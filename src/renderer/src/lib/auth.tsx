import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import type { AppConfig } from '@shared/ipc'
import { api } from './ipc'
import { buildClient, usernameToEmail } from './supabase'
import { effectivePermissions } from './perms'
import type { AppSettings, Profile } from './types'
import { t } from '@/i18n'

export type AuthPhase = 'booting' | 'connect' | 'schema' | 'setup' | 'login' | 'app'

interface AuthContextValue {
  phase: AuthPhase
  config: AppConfig | null
  connectionError: string | null
  profile: Profile | null
  perms: Set<string>
  settings: AppSettings
  client: SupabaseClient | null
  can: (permission: string) => boolean
  signIn: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>
  signOut: () => Promise<void>
  saveConfig: (config: AppConfig) => Promise<{ ok: boolean; error?: string }>
  retryBoot: () => Promise<void>
  completeSetup: () => Promise<boolean>
  refreshProfile: () => Promise<boolean>
  refreshSettings: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

async function fetchSettings(c: SupabaseClient): Promise<AppSettings> {
  const { data } = await c.from('settings').select('key, value')
  const map: AppSettings = {}
  for (const row of data ?? []) {
    ;(map as Record<string, unknown>)[row.key] = row.value
  }
  return map
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [phase, setPhase] = useState<AuthPhase>('booting')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [perms, setPerms] = useState<Set<string>>(() => new Set())
  const [settings, setSettings] = useState<AppSettings>({})
  const clientRef = useRef<SupabaseClient | null>(null)
  const bootGen = useRef(0)
  const [session, setSession] = useState<Session | null>(null)

  const loadProfile = useCallback(async (c: SupabaseClient, uid: string): Promise<boolean> => {
    const { data: prof } = await c.from('profiles').select('*').eq('id', uid).maybeSingle()
    if (!prof) return false
    if (!(prof as Profile).is_active) {
      await c.auth.signOut()
      setProfile(null)
      setPerms(new Set())
      return false
    }
    const { data: overrides } = await c
      .from('user_permissions')
      .select('permission, allowed')
      .eq('user_id', uid)
    setProfile(prof as Profile)
    setPerms(
      effectivePermissions(
        (prof as Profile).role,
        (overrides ?? []) as { permission: string; allowed: boolean }[]
      )
    )
    setSettings(await fetchSettings(c))
    return true
  }, [])

  const boot = useCallback(async (): Promise<void> => {
    const gen = ++bootGen.current
    setPhase('booting')
    setConnectionError(null)

    let cfg: AppConfig | null = null
    try {
      cfg = await api.config.get()
    } catch {
      cfg = null
    }
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
      const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
      if (envUrl && envKey) {
        cfg = { supabaseUrl: envUrl, supabaseAnonKey: envKey }
      }
    }
    if (gen !== bootGen.current) return

    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      setConfig(null)
      setPhase('connect')
      return
    }
    setConfig(cfg)
    const c = buildClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    clientRef.current = c

    try {
      const { data, error } = await c.rpc('instance_status')
      if (gen !== bootGen.current) return
      if (error) {
        const missing =
          (error as { code?: string }).code === 'PGRST202' ||
          /could not find the function|does not exist/i.test(error.message)
        if (missing) {
          setPhase('schema')
        } else {
          setConnectionError(error.message)
          setPhase('connect')
        }
        return
      }
      const status = data as { has_users: boolean }
      const { data: sess } = await c.auth.getSession()
      if (gen !== bootGen.current) return
      setSession(sess.session)

      if (sess.session) {
        const ok = await loadProfile(c, sess.session.user.id)
        if (gen !== bootGen.current) return
        setPhase(ok ? 'app' : 'setup')
      } else {
        setPhase(status.has_users ? 'login' : 'setup')
      }
    } catch (err) {
      if (gen !== bootGen.current) return
      setConnectionError(String(err))
      setPhase('connect')
    }
  }, [loadProfile])

  useEffect(() => {
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const c = clientRef.current
    if (!c) return
    const { data: sub } = c.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      if (event === 'SIGNED_OUT') {
        setProfile(null)
        setPerms(new Set())
        setPhase((p) => (p === 'connect' || p === 'schema' || p === 'booting' ? p : 'login'))
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [config?.supabaseUrl, config?.supabaseAnonKey])

  const signIn = useCallback(
    async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
      const c = clientRef.current
      if (!c) return { ok: false, error: t('common.notConnected') }
      const { data, error } = await c.auth.signInWithPassword({
        email: usernameToEmail(username),
        password
      })
      if (error || !data.user) return { ok: false, error: t('login.bad') }
      const ok = await loadProfile(c, data.user.id)
      if (!ok) {
        await c.auth.signOut()
        return { ok: false, error: t('login.noProfile') }
      }
      setPhase('app')
      void c.rpc('log_login', { p_username: username.trim().toLowerCase(), p_success: true })
      return { ok: true }
    },
    [loadProfile]
  )

  const signOut = useCallback(async (): Promise<void> => {
    const c = clientRef.current
    if (c) await c.auth.signOut()
    setProfile(null)
    setPerms(new Set())
    setSession(null)
    setPhase('login')
  }, [])

  const saveConfig = useCallback(
    async (next: AppConfig): Promise<{ ok: boolean; error?: string }> => {
      const res = await api.config.set(next)
      if (!res.ok) return { ok: false, error: res.error }
      setConfig(next)
      await boot()
      return { ok: true }
    },
    [boot]
  )

  const completeSetup = useCallback(async (): Promise<boolean> => {
    const c = clientRef.current
    if (!c) return false
    const { data: sess } = await c.auth.getSession()
    if (!sess.session) return false
    const ok = await loadProfile(c, sess.session.user.id)
    if (ok) setPhase('app')
    return ok
  }, [loadProfile])

  const refreshProfile = useCallback(async (): Promise<boolean> => {
    const c = clientRef.current
    if (!c) return false
    const { data: sess } = await c.auth.getSession()
    if (!sess.session) return false
    return loadProfile(c, sess.session.user.id)
  }, [loadProfile])

  const refreshSettings = useCallback(async (): Promise<void> => {
    const c = clientRef.current
    if (!c) return
    setSettings(await fetchSettings(c))
  }, [])

  const can = useCallback((permission: string) => perms.has(permission), [perms])

  useEffect(() => {
    if (phase !== 'app') return
    let last = Date.now()
    const bump = (): void => {
      last = Date.now()
    }
    const events = ['mousedown', 'keydown', 'touchstart', 'wheel']
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }))
    const minutes = settings.session?.timeout_minutes ?? 480
    const timer = setInterval(() => {
      if (Date.now() - last > minutes * 60_000) void signOut()
    }, 30_000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump))
      clearInterval(timer)
    }
  }, [phase, settings.session?.timeout_minutes, signOut])

  const value: AuthContextValue = {
    phase,
    config,
    connectionError,
    profile,
    perms,
    settings,
    client: clientRef.current,
    can,
    signIn,
    signOut,
    saveConfig,
    retryBoot: boot,
    completeSetup,
    refreshProfile,
    refreshSettings
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}

export function useDb(): SupabaseClient {
  const { client } = useAuth()
  if (!client) throw new Error('SUPABASE_NOT_READY')
  return client
}

export function useSession(): Session | null {
  const { phase } = useAuth()
  void phase
  return null
}
