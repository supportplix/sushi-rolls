import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, Loader2, LockKeyhole, PlugZap } from 'lucide-react'
import logo from '@/assets/logo-ui.png'
import { useAuth } from '@/lib/auth'
import { t } from '@/i18n'
import { cn } from '@/lib/cn'
import { Button, Field } from '@/components/ui/primitives'
import { AuroraField } from '@/components/layout/AuroraField'

function Screen({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="relative h-screen w-screen overflow-y-auto bg-ink">
      <AuroraField />
      <div className="app-drag fixed inset-x-0 top-0 z-50 h-[38px]" />
      <div className="relative z-10 flex min-h-full items-center justify-center px-6 py-16">{children}</div>
    </div>
  )
}

function Logo({ size = 'md' }: { size?: 'md' | 'lg' }): JSX.Element {
  return (
    <div
      className={cn(
        'mx-auto drop-shadow-[0_30px_70px_rgba(229,14,5,0.26)]',
        size === 'lg' ? 'w-60' : 'w-48'
      )}
    >
      <img src={logo} alt="SUSHI ROLLS" className="h-auto w-full" />
    </div>
  )
}

export function BootSplash(): JSX.Element {
  return (
    <div className="grid h-screen w-screen place-items-center bg-ink">
      <AuroraField />
      <div className="app-drag fixed inset-x-0 top-0 h-[38px]" />
      <div className="flex flex-col items-center gap-5">
        <Logo size="lg" />
        <div className="flex items-center gap-2 text-xs font-semibold text-txt-faint">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('boot.loading')}
        </div>
      </div>
    </div>
  )
}

export function Connect(): JSX.Element {
  const { retryBoot } = useAuth()
  const [busy, setBusy] = useState(false)
  return (
    <Screen>
      <div className="w-full max-w-[420px]">
        <Logo />
        <div className="mt-6 rounded-[28px] border border-white/[0.07] bg-[#0C0D10]/80 p-7 text-center shadow-card backdrop-blur-2xl">
          <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl border border-brand-gold/20 bg-brand-gold/[0.10] text-brand-gold">
            <PlugZap className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-black">{t('connect.title')}</h1>
          <p className="mt-1 text-[11px] leading-relaxed text-txt-faint">{t('connect.subtitle')}</p>
          <Button
            className="mt-5 w-full"
            disabled={busy}
            icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            onClick={async () => {
              setBusy(true)
              await retryBoot()
              setBusy(false)
            }}
          >
            {t('schema.retry')}
          </Button>
        </div>
      </div>
    </Screen>
  )
}

export function SchemaGuide(): JSX.Element {
  const { retryBoot } = useAuth()
  const [busy, setBusy] = useState(false)
  return (
    <Screen>
      <div className="w-full max-w-[420px]">
        <Logo />
        <div className="mt-6 rounded-[28px] border border-white/[0.07] bg-[#0C0D10]/80 p-7 text-center shadow-card backdrop-blur-2xl">
          <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl border border-brand-gold/20 bg-brand-gold/[0.10] text-brand-gold">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-black">{t('schema.title')}</h1>
          <p className="mt-1 text-[11px] leading-relaxed text-txt-faint">{t('schema.body')}</p>
          <Button
            className="mt-5 w-full"
            disabled={busy}
            icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            onClick={async () => {
              setBusy(true)
              await retryBoot()
              setBusy(false)
            }}
          >
            {t('schema.retry')}
          </Button>
        </div>
      </div>
    </Screen>
  )
}

export function Login(): JSX.Element {
  const { signIn } = useAuth()
  const remembered = localStorage.getItem('sushi.user') ?? ''
  const [username, setUsername] = useState(remembered)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(!!remembered)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    const res = await signIn(username, password)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? t('login.bad'))
      return
    }
    if (remember) localStorage.setItem('sushi.user', username.trim().toLowerCase())
    else localStorage.removeItem('sushi.user')
  }

  return (
    <Screen>
      <div className="w-full max-w-[380px]">
        <Logo />
        <div className="mt-6 rounded-[28px] border border-white/[0.07] bg-[#0C0D10]/80 p-7 shadow-card backdrop-blur-2xl">
          <h1 className="text-center text-lg font-black">{t('login.title')}</h1>
          <p className="mt-1 text-center text-[11px] text-txt-faint">{t('login.subtitle')}</p>
          {error && (
            <p className="mt-3 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2 text-[11px] font-semibold text-brand-redSoft">
              {error}
            </p>
          )}
          <form onSubmit={submit} className="mt-5 space-y-4">
            <Field label={t('login.username')}>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                dir="ltr"
                className="input text-left"
                autoFocus
                autoComplete="username"
                spellCheck={false}
              />
            </Field>
            <Field label={t('login.password')}>
              <div className="relative">
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type={show ? 'text' : 'password'}
                  dir="ltr"
                  className="input pe-11 text-left"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                  className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-txt-faint transition hover:bg-white/[0.06] hover:text-txt"
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            <button
              type="button"
              onClick={() => setRemember((v) => !v)}
              className="flex items-center gap-2 text-[11px] font-semibold text-txt-dim"
            >
              <span
                className={cn(
                  'grid h-4 w-4 place-items-center rounded border transition',
                  remember ? 'border-brand-red bg-brand-red' : 'border-line-2 bg-ink-800'
                )}
              >
                {remember && <span className="h-1.5 w-1.5 rounded-[2px] bg-white" />}
              </span>
              {t('login.remember')}
            </button>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('login.submit')}
            </Button>
          </form>
        </div>
      </div>
    </Screen>
  )
}

export function Setup(): JSX.Element {
  const { completeSetup } = useAuth()
  const { client } = useAuth()
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || !client) return
    setError('')
    if (!/^[a-z0-9._-]{3,32}$/.test(username.trim().toLowerCase())) {
      setError(t('setup.usernameRule'))
      return
    }
    if (password.length < 6) {
      setError(t('setup.short'))
      return
    }
    if (password !== confirm) {
      setError(t('setup.mismatch'))
      return
    }
    setBusy(true)
    try {
      const email = `${username.trim().toLowerCase()}@sushirolls.local`
      let { data, error: signErr } = await client.auth.signUp({ email, password })
      if (signErr && /already registered|already exists/i.test(signErr.message)) {
        const { data: si, error: siErr } = await client.auth.signInWithPassword({ email, password })
        if (siErr) {
          setError(t('login.bad'))
          return
        }
        data = { user: si.user, session: si.session } as typeof data
        signErr = null
      }
      if (signErr) {
        setError(signErr.message)
        return
      }
      if (!data.session) {
        setError(t('setup.emailConfirm'))
        return
      }
      const boot = await client.rpc('bootstrap_admin', {
        p_username: username.trim().toLowerCase(),
        p_full_name: fullName.trim() || username.trim()
      })
      if (boot.error && !/ALREADY_SETUP/.test(boot.error.message)) {
        setError(boot.error.message)
        return
      }
      const ok = await completeSetup()
      if (!ok) {
        setError(t('setup.emailConfirm'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <div className="w-full max-w-[420px]">
        <Logo />
        <div className="mt-6 rounded-[28px] border border-white/[0.07] bg-[#0C0D10]/80 p-7 shadow-card backdrop-blur-2xl">
          <h1 className="text-center text-lg font-black">{t('setup.title')}</h1>
          <p className="mt-1 text-center text-[11px] leading-relaxed text-txt-faint">{t('setup.hint')}</p>
          {error && (
            <p className="mt-3 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2 text-[11px] font-semibold leading-relaxed text-brand-redSoft">
              {error}
            </p>
          )}
          <form onSubmit={submit} className="mt-5 space-y-3.5">
            <Field label={t('setup.fullName')}>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="input"
                autoFocus
              />
            </Field>
            <Field label={t('setup.username')}>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                dir="ltr"
                className="input text-left"
                spellCheck={false}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('setup.password')}>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                  className="input text-left"
                  autoComplete="new-password"
                />
              </Field>
              <Field label={t('setup.confirm')}>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  dir="ltr"
                  className="input text-left"
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('setup.submit')}
            </Button>
          </form>
        </div>
      </div>
    </Screen>
  )
}
