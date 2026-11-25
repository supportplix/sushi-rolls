import { useEffect, useMemo, useState } from 'react'
import { CalendarCheck, Clock4, Fingerprint, Link2, Loader2, LogIn, LogOut, Pencil, Plus, RefreshCw, Trash2, UserRoundCheck, Users } from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync } from '@/lib/hooks'
import { humanError } from '@/lib/errors'
import { fmtDate, fmtDateTime, money, num, parseNum, startOfDay, toISODate } from '@/lib/format'
import type { Attendance, Employee, Profile } from '@/lib/types'
import { t } from '@/i18n'
import { ROLES, labelOf } from '@/lib/constants'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Field,
  PageHeader,
  PageLoader,
  RowMenu,
  SectionCard,
  Select,
  Switch,
  TableWrap,
  Tabs
} from '@/components/ui/primitives'
import { DatePicker } from '@/components/ui/datepicker'
import { Dialog, ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import {
  enqueueEmployeeCommand,
  deleteEmployeeWithDevice,
  listCommands,
  listEmployeeDevices,
  startEnrollment,
  type DeviceCommand,
  type EmployeeDevice
} from '@/lib/zkteco'

export default function EmployeesPage(): JSX.Element {
  const db = useDb()
  const { can, profile } = useAuth()
  const toast = useToast()
  const manage = can('employees.manage')
  const [tab, setTab] = useState<'team' | 'attendance'>('team')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    id: '',
    full_name: '',
    job_title: '',
    phone: '',
    salary: '',
    hire_date: toISODate(new Date()),
    profile_id: '',
    is_active: true
  })
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [zkBusy, setZkBusy] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null)

  const list = useAsync(async () => {
    const { data, error } = await db.from('employees').select('*').order('full_name')
    if (error) throw error
    return (data ?? []) as Employee[]
  }, [db])

  const staff = useAsync(async () => {
    const { data } = await db.from('profiles').select('*').eq('is_active', true).order('full_name')
    return (data ?? []) as Profile[]
  }, [db])

  const employeeDevices = useAsync(async () => {
    if (!manage) return [] as EmployeeDevice[]
    return listEmployeeDevices(db)
  }, [db, manage])

  const commands = useAsync(async () => {
    if (!manage) return [] as DeviceCommand[]
    return listCommands(db)
  }, [db, manage])

  useEffect(() => {
    if (!manage) return
    const timer = window.setInterval(() => {
      void employeeDevices.reload()
      void commands.reload()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [manage, employeeDevices, commands])

  const today = toISODate(new Date())
  const attendance = useAsync(async () => {
    const { data, error } = await db
      .from('attendance')
      .select('*, employees(full_name)')
      .gte('work_date', today)
      .order('check_in', { ascending: false })
    if (error) throw error
    return (data ?? []) as Attendance[]
  }, [db, today])

  const history = useAsync(async () => {
    const { data, error } = await db
      .from('attendance')
      .select('*, employees(full_name)')
      .order('check_in', { ascending: false })
      .limit(150)
    if (error) throw error
    return (data ?? []) as Attendance[]
  }, [db])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void attendance.reload()
      void history.reload()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [attendance, history])

  const myEmployee = useMemo(
    () => (list.data ?? []).find((e) => e.profile_id === profile?.id),
    [list.data, profile?.id]
  )
  const myOpen = useMemo(
    () => (attendance.data ?? []).find((a) => a.employee_id === myEmployee?.id && !a.check_out),
    [attendance.data, myEmployee?.id]
  )

  const check = async (action: 'in' | 'out'): Promise<void> => {
    setBusy(true)
    try {
      const { error } = await db.rpc(action === 'in' ? 'attendance_check_in' : 'attendance_check_out')
      if (error) throw error
      toast.success(action === 'in' ? t('employees.checkedIn') : t('employees.checkedOut'))
      void attendance.reload()
      void history.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  const linkSelf = async (): Promise<void> => {
    if (!profile) return
    setBusy(true)
    try {
      const { error } = await db.from('employees').insert({
        profile_id: profile.id,
        full_name: profile.full_name,
        job_title: labelOf(ROLES, profile.role, 'ar'),
        is_active: true
      })
      if (error) throw error
      toast.success(t('employees.added'))
      void list.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  const zkStatus = (employeeId: string): { label: string; color: string } => {
    const pending = (commands.data ?? []).find((c) => c.employee_id === employeeId && (c.status === 'pending' || c.status === 'processing'))
    if (pending) return { label: pending.type === 'start_enrollment' ? 'في انتظار البصمة' : 'جارٍ التجهيز', color: '#E4BE54' }
    const mapping = (employeeDevices.data ?? []).find((item) => item.employee_id === employeeId)
    if (!mapping) return { label: 'غير مسجل', color: '#6B7176' }
    if (mapping.enrollment_status === 'enrolled') return { label: 'بصمة مسجلة', color: '#3DBE7A' }
    if (mapping.enrollment_status === 'disabled') return { label: 'معطّل على الجهاز', color: '#6B7176' }
    if (mapping.enrollment_status === 'failed') return { label: 'فشل التسجيل', color: '#E36B6B' }
    return { label: 'بانتظار التسجيل', color: '#E4BE54' }
  }

  const runZk = async (
    employeeId: string,
    action: 'enroll' | 'disable'
  ): Promise<void> => {
    setZkBusy(employeeId)
    try {
      if (action === 'enroll') await startEnrollment(db, employeeId)
      else await enqueueEmployeeCommand(db, employeeId, 'delete_user', `disable-${employeeId}-${Date.now()}`)
      toast.success(action === 'enroll' ? 'تم إرسال أمر تسجيل البصمة' : 'تم إرسال أمر الحذف من الجهاز')
      void employeeDevices.reload()
      void commands.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setZkBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    if (!form.full_name.trim()) return
    setSaving(true)
    try {
      const payload = {
        full_name: form.full_name.trim(),
        job_title: form.job_title.trim() || null,
        phone: form.phone.trim() || null,
        salary: parseNum(form.salary),
        hire_date: form.hire_date || null,
        profile_id: form.profile_id || null,
        is_active: form.is_active
      }
      let employeeId = form.id
      if (form.id) {
        const { error } = await db.from('employees').update(payload).eq('id', form.id)
        if (error) throw error
      } else {
        const { data, error } = await db.from('employees').insert(payload).select('id').single()
        if (error) throw error
        employeeId = data.id as string
      }
      if (employeeId && manage) {
        try {
          if (form.id) await enqueueEmployeeCommand(db, employeeId, 'update_user', `update-${employeeId}-${Date.now()}`)
          else await startEnrollment(db, employeeId)
        } catch (zkError) {
          toast.error(`تم حفظ الموظف، لكن تعذر تجهيز البصمة: ${humanError(zkError)}`)
        }
      }
      toast.success(t('employees.added'))
      setOpen(false)
      void list.reload()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setSaving(false)
    }
  }

  const hours = (a: Attendance): string => {
    if (!a.check_out) return '—'
    const h = (new Date(a.check_out).getTime() - new Date(a.check_in).getTime()) / 3600000
    return `${num(h, 1)} س`
  }

  return (
    <div>
      <PageHeader
        title={t('employees.title')}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'team', label: t('employees.title'), icon: <Users className="h-3.5 w-3.5" /> },
                { value: 'attendance', label: t('employees.attendance'), icon: <CalendarCheck className="h-3.5 w-3.5" /> }
              ]}
            />
            {manage && (
              <Button
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setForm({ id: '', full_name: '', job_title: '', phone: '', salary: '', hire_date: toISODate(new Date()), profile_id: '', is_active: true })
                  setOpen(true)
                }}
              >
                {t('employees.add')}
              </Button>
            )}
            <button
              type="button"
              onClick={() => {
                void list.reload()
                void attendance.reload()
                void history.reload()
              }}
              aria-label={t('common.refresh')}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink-800 text-txt-dim hover:text-txt"
            >
              <RefreshCw className={cn('h-4 w-4', list.loading && 'animate-spin')} />
            </button>
          </>
        }
      />

      {myEmployee ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-ink-700 p-4">
          <div className="text-xs">
            <div className="font-bold">{myEmployee.full_name}</div>
            <div className="text-[10.5px] text-txt-faint">
              {myEmployee.job_title ?? '—'} · {myOpen ? `${t('employees.checkedIn')} ${fmtDateTime(myOpen.check_in)}` : t('employees.checkIn')}
            </div>
          </div>
          {myOpen ? (
            <Button size="sm" variant="danger" disabled={busy} icon={<LogOut className="h-4 w-4" />} onClick={() => void check('out')}>
              {t('employees.checkOut')}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} icon={<LogIn className="h-4 w-4" />} onClick={() => void check('in')}>
              {t('employees.checkIn')}
            </Button>
          )}
        </div>
      ) : (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-gold/25 bg-brand-gold/10 px-4 py-2.5 text-[11px] font-semibold text-brand-gold">
          <span>{t('employees.noRecord')}</span>
          {manage && (
            <Button size="sm" variant="gold" disabled={busy} icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => void linkSelf()}>
              {t('employees.linkSelf')}
            </Button>
          )}
        </div>
      )}

      {tab === 'team' && (
        <SectionCard bodyClassName="p-0">
          {list.loading && !list.data ? (
            <PageLoader />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('employees.job')}</th>
                  <th>{t('common.phone')}</th>
                  {manage && <th>{t('employees.salary')}</th>}
                  <th>{t('employees.hireDate')}</th>
                  <th>{t('common.status')}</th>
                  {manage && <th>البصمة</th>}
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="font-semibold">{e.full_name}</div>
                      <div className="text-[10px] text-txt-faint">
                        {staff.data?.find((s) => s.id === e.profile_id)?.username ?? '—'}
                      </div>
                    </td>
                    <td className="text-xs text-txt-dim">{e.job_title ?? '—'}</td>
                    <td className="text-xs text-txt-dim" dir="ltr">{e.phone ?? '—'}</td>
                    {manage && <td className="font-bold">{money(e.salary)}</td>}
                    <td className="text-[11px] text-txt-faint">{e.hire_date ? fmtDate(e.hire_date) : '—'}</td>
                    <td>
                      <Badge color={e.is_active ? '#3DBE7A' : '#6B7176'}>
                        {e.is_active ? t('common.active') : t('common.inactive')}
                      </Badge>
                    </td>
                    {manage && (
                      <td>
                        <Badge color={zkStatus(e.id).color}>{zkStatus(e.id).label}</Badge>
                      </td>
                    )}
                    <td>
                      {manage && (
                        <RowMenu
                          items={[
                            {
                              label: t('common.edit'),
                              icon: <Pencil className="h-3.5 w-3.5" />,
                              onClick: () => {
                                setForm({
                                  id: e.id,
                                  full_name: e.full_name,
                                  job_title: e.job_title ?? '',
                                  phone: e.phone ?? '',
                                  salary: String(e.salary ?? ''),
                                  hire_date: e.hire_date ?? toISODate(new Date()),
                                  profile_id: e.profile_id ?? '',
                                  is_active: e.is_active
                                })
                                setOpen(true)
                              }
                            },
                            {
                              label: zkStatus(e.id).label === 'بصمة مسجلة' ? 'إعادة تسجيل البصمة' : 'تسجيل البصمة',
                              icon: <Fingerprint className="h-3.5 w-3.5" />,
                              disabled: zkBusy === e.id,
                              onClick: () => void runZk(e.id, 'enroll')
                            },
                            {
                              label: 'حذف من الجهاز',
                              icon: <UserRoundCheck className="h-3.5 w-3.5" />,
                              danger: true,
                              disabled: zkBusy === e.id,
                              onClick: () => void runZk(e.id, 'disable')
                            },
                            {
                              label: t('common.delete'),
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onClick: () => setDeleteTarget(e)
                            }
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {(list.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={manage ? 8 : 7} className="py-10 text-center text-xs text-txt-faint">
                      {t('common.empty')}
                    </td>
                  </tr>
                )}
              </tbody>
            </TableWrap>
          )}
        </SectionCard>
      )}

      {tab === 'attendance' && (
        <SectionCard bodyClassName="p-0">
          {history.loading && !history.data ? (
            <PageLoader />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('employees.checkIn')}</th>
                  <th>{t('employees.checkOut')}</th>
                  <th>{t('employees.totalHours')}</th>
                  <th>المصدر</th>
                </tr>
              </thead>
              <tbody>
                {(history.data ?? []).map((a) => (
                  <tr key={a.id}>
                    <td className="font-semibold">{a.employees?.full_name ?? '—'}</td>
                    <td className="text-[11px] text-txt-faint">{fmtDate(a.work_date)}</td>
                    <td className="text-xs">{fmtDateTime(a.check_in)}</td>
                    <td className="text-xs">{a.check_out ? fmtDateTime(a.check_out) : <Badge color="#E4BE54">مفتوح</Badge>}</td>
                    <td className="text-xs font-bold">{hours(a)}</td>
                    <td><Badge color={a.source === 'device' ? '#3DBE7A' : '#6B7176'}>{a.source === 'device' ? 'بصمة LX15' : 'يدوي'}</Badge></td>
                  </tr>
                ))}
                {(history.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-xs text-txt-faint">
                      {t('employees.noAttendance')}
                    </td>
                  </tr>
                )}
              </tbody>
            </TableWrap>
          )}
        </SectionCard>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? t('common.edit') : t('employees.add')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('common.name')}>
            <input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} autoFocus />
          </Field>
          <Field label={t('employees.job')}>
            <input className="input" value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} />
          </Field>
          <Field label={t('common.phone')}>
            <input className="input" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label={t('employees.salary')}>
            <input className="input" inputMode="decimal" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} placeholder="0" />
          </Field>
          <Field label={t('employees.hireDate')}>
            <DatePicker value={form.hire_date} onChange={(iso) => setForm({ ...form, hire_date: iso })} />
          </Field>
          <Field label="حساب الدخول المرتبط">
            <Select
              value={form.profile_id}
              onChange={(v) => setForm({ ...form, profile_id: v })}
              options={(staff.data ?? [])
                .filter((p) => p.id === form.profile_id || !(list.data ?? []).some((e) => e.profile_id === p.id && e.id !== form.id))
                .map((p) => ({ value: p.id, ar: `${p.full_name} (${labelOf(ROLES, p.role, 'ar')})` }))}
              placeholder={t('common.none')}
            />
          </Field>
          <div className="md:col-span-2">
            <Switch checked={form.is_active} onChange={(v) => setForm({ ...form, is_active: v })} label={t('common.active')} />
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('common.delete')}
        message={t('employees.deleteConfirm')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await deleteEmployeeWithDevice(db, deleteTarget.id)
            toast.success(t('common.deleted'))
            setDeleteTarget(null)
            void list.reload()
          } catch (err) {
            toast.error(humanError(err))
          }
        }}
      />
    </div>
  )
}
