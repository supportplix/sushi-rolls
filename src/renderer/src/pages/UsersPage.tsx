import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
  UsersRound
} from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError, invokeError } from '@/lib/errors'
import { fmtDateTime, num } from '@/lib/format'
import type { LoginHistory, Profile } from '@/lib/types'
import { t } from '@/i18n'
import { PERMISSIONS, ROLES, labelOf } from '@/lib/constants'
import { defaultPermissions } from '@/lib/perms'
import type { Role } from '@/lib/types'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Field,
  PageHeader,
  PageLoader,
  RowMenu,
  Select,
  Switch,
  TableWrap
} from '@/components/ui/primitives'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'

type Tri = 'default' | 'allow' | 'deny'

export default function UsersPage(): JSX.Element {
  const db = useDb()
  const { profile: me } = useAuth()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ id: '', username: '', full_name: '', password: '', role: 'cashier', is_active: true })
  const [saving, setSaving] = useState(false)
  const [permUser, setPermUser] = useState<Profile | null>(null)
  const [permState, setPermState] = useState<Record<string, Tri>>({})
  const [permSaving, setPermSaving] = useState(false)
  const [resetUser, setResetUser] = useState<Profile | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [activityUser, setActivityUser] = useState<Profile | null>(null)
  const [deleteUser, setDeleteUser] = useState<Profile | null>(null)
  const [toggleTarget, setToggleTarget] = useState<Profile | null>(null)
  const [loadingPerms, setLoadingPerms] = useState(false)

  const users = useAsync(async () => {
    const { data, error } = await db.from('profiles').select('*').order('created_at')
    if (error) throw error
    return (data ?? []) as Profile[]
  }, [db])

  const logins = useAsync(async () => {
    const { data, error } = await db
      .from('login_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(400)
    if (error) throw error
    return (data ?? []) as LoginHistory[]
  }, [db])

  const lastLogin = useMemo(() => {
    const map = new Map<string, string>()
    for (const l of logins.data ?? []) {
      if (l.user_id && !map.has(l.user_id)) map.set(l.user_id, l.created_at)
    }
    return map
  }, [logins.data])

  const callAdmin = async (body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
    const { data, error } = await db.functions.invoke('admin-users', { body })
    if (error) {
      let message = humanError(error)
      try {
        const ctx = (error as { context?: { json?: () => Promise<{ error?: string }> } }).context
        if (ctx?.json) {
          const payload = await ctx.json()
          if (payload?.error) {
            const translated = t(`error.${payload.error}`)
            message = translated !== `error.${payload.error}` ? translated : humanError(payload.error)
          }
        }
      } catch {
        void 0
      }
      const translated = t(`error.${message}`)
      return { ok: false, error: translated !== `error.${message}` ? translated : t('common.error') }
    }
    const payload = data as { error?: string } | null
    if (payload?.error) return { ok: false, error: invokeError(null, payload) }
    return { ok: true }
  }

  const saveUser = async (): Promise<void> => {
    if (!form.full_name.trim()) return
    if (!form.id && (form.password.length < 6 || !form.username.trim())) return
    setSaving(true)
    try {
      const res = form.id
        ? await callAdmin({
            action: 'update',
            id: form.id,
            full_name: form.full_name.trim(),
            role: form.role,
            is_active: form.is_active,
            ...(form.password ? { password: form.password } : {})
          })
        : await callAdmin({
            action: 'create',
            username: form.username.trim().toLowerCase(),
            full_name: form.full_name.trim(),
            password: form.password,
            role: form.role
          })
      if (!res.ok) {
        toast.error(res.error ?? t('common.error'))
        return
      }
      toast.success(form.id ? t('users.updated') : t('users.created'))
      setOpen(false)
      void users.reload()
    } finally {
      setSaving(false)
    }
  }

  const openPermissions = async (user: Profile): Promise<void> => {
    setPermUser(user)
    setLoadingPerms(true)
    const next: Record<string, Tri> = {}
    for (const p of PERMISSIONS) next[p.key] = 'default'
    try {
      const { data } = await db
        .from('user_permissions')
        .select('permission, allowed')
        .eq('user_id', user.id)
      for (const row of data ?? []) {
        next[row.permission] = row.allowed ? 'allow' : 'deny'
      }
    } finally {
      setPermState(next)
      setLoadingPerms(false)
    }
  }

  const savePermissions = async (): Promise<void> => {
    if (!permUser) return
    setPermSaving(true)
    try {
      const rows = Object.entries(permState)
        .filter(([, v]) => v !== 'default')
        .map(([permission, v]) => ({ user_id: permUser.id, permission, allowed: v === 'allow' }))
      const { data: existing, error: readError } = await db
        .from('user_permissions')
        .select('permission')
        .eq('user_id', permUser.id)
      if (readError) throw readError
      const wanted = new Map(rows.map((row) => [row.permission, row]))
      // 'default' means "no override", so only revocations are deleted.
      // Upserting first means a failed write cannot erase existing overrides.
      if (rows.length > 0) {
        const { error } = await db.from('user_permissions').upsert(rows, { onConflict: 'user_id,permission' })
        if (error) throw error
      }
      const revoked = (existing ?? [])
        .map((row) => row.permission as string)
        .filter((permission) => !wanted.has(permission))
      if (revoked.length > 0) {
        const { error } = await db
          .from('user_permissions')
          .delete()
          .eq('user_id', permUser.id)
          .in('permission', revoked)
        if (error) throw error
      }
      toast.success(t('common.saved'))
      setPermUser(null)
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setPermSaving(false)
    }
  }

  const roleDefaults = useMemo(
    () => (permUser ? defaultPermissions(permUser.role) : new Set<string>()),
    [permUser]
  )

  return (
    <div>
      <PageHeader
        title={t('users.title')}
        actions={
          <>
            <Button
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setForm({ id: '', username: '', full_name: '', password: '', role: 'cashier', is_active: true })
                setOpen(true)
              }}
            >
              {t('users.add')}
            </Button>
            <button
              type="button"
              onClick={() => {
                void users.reload()
                void logins.reload()
              }}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', users.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      <div className="card overflow-hidden">
        {users.loading && !users.data ? (
          <PageLoader />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>{t('users.fullName')}</th>
                <th>{t('users.username')}</th>
                <th>{t('users.role')}</th>
                <th>{t('common.status')}</th>
                <th>{t('users.lastActivity')}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-2 font-semibold">
                      {u.full_name}
                      {u.id === me?.id && <Badge color="#E4BE54">{t('users.self')}</Badge>}
                    </div>
                  </td>
                  <td className="text-xs text-txt-dim" dir="ltr">{u.username}</td>
                  <td>
                    <Badge color={ROLES.find((r) => r.value === u.role)?.color}>{labelOf(ROLES, u.role, 'ar')}</Badge>
                  </td>
                  <td>
                    <Badge color={u.is_active ? '#3DBE7A' : '#E50E05'}>
                      {u.is_active ? t('common.active') : t('common.inactive')}
                    </Badge>
                  </td>
                  <td className="text-[11px] text-txt-faint">
                    {lastLogin.get(u.id) ? fmtDateTime(lastLogin.get(u.id) as string) : '—'}
                  </td>
                  <td>
                    <RowMenu
                      items={[
                        {
                          label: t('users.permissions'),
                          icon: <ShieldCheck className="h-3.5 w-3.5" />,
                          onClick: () => void openPermissions(u)
                        },
                        {
                          label: t('common.edit'),
                          icon: <Pencil className="h-3.5 w-3.5" />,
                          onClick: () => {
                            setForm({
                              id: u.id,
                              username: u.username,
                              full_name: u.full_name,
                              password: '',
                              role: u.role,
                              is_active: u.is_active
                            })
                            setOpen(true)
                          }
                        },
                        {
                          label: t('users.resetPassword'),
                          icon: <KeyRound className="h-3.5 w-3.5" />,
                          onClick: () => {
                            setNewPassword('')
                            setResetUser(u)
                          }
                        },
                        {
                          label: t('users.activity'),
                          icon: <Activity className="h-3.5 w-3.5" />,
                          onClick: () => setActivityUser(u)
                        },
                        {
                          label: u.is_active ? t('users.deactivate') : t('users.activate'),
                          icon: u.is_active ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />,
                          danger: u.is_active,
                          disabled: u.id === me?.id,
                          onClick: () => setToggleTarget(u)
                        },
                        {
                          label: t('common.delete'),
                          icon: <Trash2 className="h-3.5 w-3.5" />,
                          danger: true,
                          disabled: u.id === me?.id,
                          onClick: () => setDeleteUser(u)
                        }
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? t('common.edit') : t('users.add')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void saveUser()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('users.fullName')}>
            <input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} autoFocus />
          </Field>
          <Field label={t('users.username')}>
            <input
              className="input"
              dir="ltr"
              disabled={!!form.id}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
            />
          </Field>
          <Field label={t('users.role')}>
            <Select
              value={form.role}
              onChange={(v) => setForm({ ...form, role: v })}
              options={ROLES.map((r) => ({ value: r.value, ar: r.ar }))}
            />
          </Field>
          <Field label={t('users.password')} hint={form.id ? 'اتركها فاضية لو مش هتتغير' : undefined}>
            <input
              className="input"
              dir="ltr"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          {form.id && (
            <div className="md:col-span-2">
              <Switch checked={form.is_active} onChange={(v) => setForm({ ...form, is_active: v })} label={t('common.active')} />
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={!!permUser}
        onClose={() => setPermUser(null)}
        title={`${t('users.permissions')} · ${permUser?.full_name ?? ''}`}
        subtitle={t('users.permissionsHint')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPermUser(null)}>{t('common.cancel')}</Button>
            <Button onClick={() => void savePermissions()} disabled={permSaving || loadingPerms}>
              {permSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </>
        }
      >
        {loadingPerms ? (
          <PageLoader />
        ) : (
          <div className="space-y-4">
            {Array.from(new Set(PERMISSIONS.map((p) => p.group))).map((group) => (
              <div key={group}>
                <div className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-txt-faint">
                  {t(`users.permGroup.${group}`)}
                </div>
                <div className="space-y-1">
                  {PERMISSIONS.filter((p) => p.group === group).map((p) => {
                    const state = permState[p.key] ?? 'default'
                    const isDefaultAllowed = roleDefaults.has(p.key)
                    return (
                      <div key={p.key} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5">
                        <div className="text-xs font-semibold">{p.ar}</div>
                        <div className="flex items-center gap-1">
                          {(
                            [
                              { v: 'default', label: `${t('users.roleDefault')} (${isDefaultAllowed ? '✓' : '✕'})` },
                              { v: 'allow', label: t('users.allow') },
                              { v: 'deny', label: t('users.deny') }
                            ] as { v: Tri; label: string }[]
                          ).map((opt) => (
                            <button
                              key={opt.v}
                              type="button"
                              onClick={() => setPermState({ ...permState, [p.key]: opt.v })}
                              className={cn(
                                'rounded-md px-2 py-1 text-[10px] font-bold transition',
                                state === opt.v
                                  ? opt.v === 'deny'
                                    ? 'bg-brand-red/[0.15] text-brand-redSoft'
                                    : opt.v === 'allow'
                                      ? 'bg-emerald-500/[0.15] text-emerald-400'
                                      : 'bg-white/[0.08] text-txt'
                                  : 'text-txt-faint hover:text-txt-dim'
                              )}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!resetUser}
        onClose={() => setResetUser(null)}
        title={`${t('users.resetPassword')} · ${resetUser?.full_name ?? ''}`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetUser(null)}>{t('common.cancel')}</Button>
            <Button
              disabled={newPassword.length < 6}
              onClick={async () => {
                if (!resetUser) return
                const res = await callAdmin({ action: 'reset_password', id: resetUser.id, password: newPassword })
                if (res.ok) {
                  toast.success(t('users.resetDone'))
                  setResetUser(null)
                } else toast.error(res.error ?? t('common.error'))
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Field label={t('users.password')}>
          <input autoFocus className="input" dir="ltr" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </Dialog>

      <Dialog
        open={!!activityUser}
        onClose={() => setActivityUser(null)}
        title={`${t('users.activity')} · ${activityUser?.full_name ?? ''}`}
        size="md"
      >
        <TableWrap>
          <thead>
            <tr>
              <th>{t('users.loginAt')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {(logins.data ?? [])
              .filter((l) => l.user_id === activityUser?.id)
              .slice(0, 30)
              .map((l) => (
                <tr key={l.id}>
                  <td className="text-[11px] text-txt-dim">{fmtDateTime(l.created_at)}</td>
                  <td>
                    <Badge color={l.success ? '#3DBE7A' : '#E50E05'}>
                      {l.success ? t('users.loginSuccess') : t('common.error')}
                    </Badge>
                  </td>
                </tr>
              ))}
            {(logins.data ?? []).filter((l) => l.user_id === activityUser?.id).length === 0 && (
              <tr>
                <td colSpan={2} className="py-8 text-center text-xs text-txt-faint">{t('common.empty')}</td>
              </tr>
            )}
          </tbody>
        </TableWrap>
      </Dialog>

      <ConfirmDialog
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        title={t('common.delete')}
        message={t('users.deleteConfirm', { name: deleteUser?.full_name ?? '' })}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!deleteUser) return
          const res = await callAdmin({ action: 'delete', id: deleteUser.id })
          if (res.ok) {
            toast.success(t('common.deleted'))
            setDeleteUser(null)
            void users.reload()
          } else toast.error(res.error ?? t('common.error'))
        }}
      />

      <ConfirmDialog
        open={!!toggleTarget}
        onClose={() => setToggleTarget(null)}
        title={toggleTarget?.is_active ? t('users.deactivate') : t('users.activate')}
        message={
          toggleTarget?.is_active
            ? t('users.deactivateConfirm', { name: toggleTarget?.full_name ?? '' })
            : t('users.activateConfirm', { name: toggleTarget?.full_name ?? '' })
        }
        confirmLabel={t('common.confirm')}
        danger={!!toggleTarget?.is_active}
        onConfirm={async () => {
          if (!toggleTarget) return
          const res = await callAdmin({
            action: 'update',
            id: toggleTarget.id,
            is_active: !toggleTarget.is_active
          })
          if (res.ok) {
            toast.success(t('users.updated'))
            setToggleTarget(null)
            void users.reload()
          } else toast.error(res.error ?? t('common.error'))
        }}
      />
    </div>
  )
}
