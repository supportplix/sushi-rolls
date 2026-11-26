import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarCheck, Clock4, Fingerprint, Link2, Loader2, LogIn, LogOut, Pencil, Plus, RefreshCw, Trash2, UserRoundCheck, Users } from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { useAsync, useRealtimeRefresh } from '@/lib/hooks'
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
  enrollFingerprintLive,
  listCommands,
  listEmployeeDevices,
  watchLiveEnrollment,
  type DeviceCommand,
  type EmployeeDevice
} from '@/lib/zkteco'
import type { ZkTecoStatus } from '@shared/ipc'

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
  const [liveEnrollment, setLiveEnrollment] = useState<{ employeeId: string; status: ZkTecoStatus } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null)
  const [enrollmentTarget, setEnrollmentTarget] = useState<{ id: string; full_name: string } | null>(null)
  const [enrollmentCommandId, setEnrollmentCommandId] = useState<string | null>(null)
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null)

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

  useRealtimeRefresh(manage ? ['employee_devices', 'device_commands'] : [], () => {
    void employeeDevices.reload()
    void commands.reload()
  })

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

  const notifyPunch = (name: string, label: string): void => {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('SUSHI ROLLS — الحضور والانصراف', { body: `${name} ${label}` })
      }
    } catch {
      // Notifications are optional; the in-app toast below is the fallback.
    }
    toast.success(`${name} ${label}`)
  }

  const seenPunches = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!manage) return
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    let stopped = false
    const check = async (): Promise<void> => {
      const { data, error } = await db
        .from('attendance')
        .select('id, employee_id, check_out, employees(full_name)')
        .gte('work_date', today)
        .order('check_in', { ascending: false })
        .limit(100)
      if (error || stopped || !data) return
      const rows = data as unknown as Array<{ id: string; employee_id: string; check_out: string | null; employees: { full_name: string } | null }>
      if (seenPunches.current === null) {
        // Seed both keys for rows that already exist so opening the page does
        // not fire a notification for every past punch of the day.
        const seeded = new Set<string>()
        for (const row of rows) {
          seeded.add(`in:${row.id}`)
          if (row.check_out) seeded.add(`out:${row.id}`)
        }
        seenPunches.current = seeded
        return
      }
      let fresh = false
      for (const row of rows) {
        const inKey = `in:${row.id}`
        const outKey = `out:${row.id}`
        if (!seenPunches.current.has(inKey)) {
          seenPunches.current.add(inKey)
          notifyPunch(row.employees?.full_name ?? 'موظف', 'سجّل الحضور')
          fresh = true
        }
        if (row.check_out && !seenPunches.current.has(outKey)) {
          seenPunches.current.add(outKey)
          notifyPunch(row.employees?.full_name ?? 'موظف', 'سجّل الانصراف')
          fresh = true
        }
      }
      if (fresh) {
        void attendance.reload()
        void history.reload()
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 1500)
    return () => { stopped = true; window.clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, manage, today])

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
    const live = liveEnrollment?.employeeId === employeeId ? liveEnrollment.status.enrollmentStatus : null
    if (live) {
      const labels: Record<string, string> = {
        starting: 'جارٍ تجهيز الجهاز',
        awaiting_scan: 'اليوزر على الجهاز — سجّل البصمة من قائمة الجهاز',
        scanning: 'جارٍ قراءة البصمة',
        enrolled: 'تم تسجيل البصمة',
        completed: 'تم تسجيل البصمة',
        failed: 'فشل تسجيل البصمة',
        timed_out: 'انتهت مهلة التسجيل',
        cancelled: 'تم إلغاء التسجيل'
      }
      const color = live === 'enrolled' || live === 'completed' ? '#3DBE7A' : live === 'failed' || live === 'timed_out' ? '#E36B6B' : '#E4BE54'
      return { label: labels[live] ?? live, color }
    }
    const pending = (commands.data ?? []).find((c) => c.employee_id === employeeId && (c.status === 'pending' || c.status === 'processing'))
    if (pending) return { label: pending.type === 'start_enrollment' ? 'في انتظار البصمة' : 'جارٍ التجهيز', color: '#E4BE54' }
    const latestCommand = employeeCommands[0]
    if (latestCommand?.status === 'failed' || latestCommand?.status === 'timed_out') {
      return { label: 'فشل التسجيل', color: '#E36B6B' }
    }
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
      if (action === 'enroll') {
        const employee = (list.data ?? []).find((item) => item.id === employeeId)
        const commandId = await enrollFingerprintLive(db, employeeId, employee?.full_name ?? 'Employee')
        watchLiveEnrollment(db, employeeId, commandId, (status) => {
          setLiveEnrollment({ employeeId, status })
          void employeeDevices.reload()
        })
        toast.success('تمت إضافة الموظف على الجهاز — سجّل البصمة من الجهاز والمتابعة لايف')
      } else {
        await enqueueEmployeeCommand(db, employeeId, 'delete_user', `disable-${employeeId}-${Date.now()}`)
        toast.success('تم إرسال أمر الحذف من الجهاز')
      }
      void employeeDevices.reload()
      void commands.reload()
    } catch (err) {
      const message = humanError(err, action === 'enroll')
      if (action === 'enroll') {
        setEnrollmentError(message)
        void employeeDevices.reload()
        void commands.reload()
      }
      toast.error(message)
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
          else {
            const commandId = await enrollFingerprintLive(db, employeeId, form.full_name.trim())
            watchLiveEnrollment(db, employeeId, commandId, (status) => {
          setLiveEnrollment({ employeeId, status })
          void employeeDevices.reload()
        })
          }
        } catch (zkError) {
          const message = humanError(zkError, true)
          setEnrollmentError(message)
          toast.error(`تم حفظ الموظف، لكن تعذر تجهيز البصمة: ${message}`)
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

  const enrollmentCommand = commands.data?.find((command) => command.id === enrollmentCommandId) ?? null
  const enrollmentState = enrollmentError
    ? 'error'
    : !enrollmentCommandId || !enrollmentCommand
      ? 'preparing'
      : enrollmentCommand.status === 'pending'
        ? 'pending'
        : enrollmentCommand.status === 'processing'
          ? 'scanning'
          : enrollmentCommand.status === 'completed'
            ? 'completed'
            : enrollmentCommand.status === 'failed' || enrollmentCommand.status === 'timed_out' || enrollmentCommand.status === 'cancelled'
              ? 'error'
              : 'pending'

  return (
    <div>
      <Dialog
        open={enrollmentTarget !== null}
        onClose={() => {
          setEnrollmentTarget(null)
          setEnrollmentCommandId(null)
          setEnrollmentError(null)
        }}
        title="تسجيل بصمة الموظف"
        subtitle={enrollmentTarget?.full_name}
        size="sm"
      >
        <div className="flex flex-col items-center gap-4 py-3 text-center" role="status" aria-live="polite">
          {enrollmentState === 'completed' ? (
            <CheckCircle2 className="h-14 w-14 text-[#3DBE7A]" aria-hidden="true" />
          ) : enrollmentState === 'error' ? (
            <CircleAlert className="h-14 w-14 text-brand-redSoft" aria-hidden="true" />
          ) : (
            <Fingerprint className={`h-14 w-14 ${enrollmentState === 'scanning' ? 'animate-pulse text-brand-gold' : 'text-brand-gold'}`} aria-hidden="true" />
          )}
          <div>
            <h3 className="text-sm font-bold">
              {enrollmentState === 'preparing'
                ? 'جارٍ تجهيز الموظف وإرسال الأمر للجهاز'
                : enrollmentState === 'pending'
                  ? 'تم إرسال الأمر، في انتظار استجابة الجهاز'
                  : enrollmentState === 'scanning'
                    ? 'ضع إصبعك على حساس جهاز البصمة'
                    : enrollmentState === 'completed'
                      ? 'تم تسجيل البصمة بنجاح'
                      : 'تعذر تسجيل البصمة'}
            </h3>
            {enrollmentState === 'scanning' && (
              <p className="mt-2 text-xs leading-6 text-txt-dim">
                اتبع التعليمات التي تظهر على شاشة جهاز ZKTeco حتى يكتمل التسجيل.
              </p>
            )}
            {enrollmentState === 'error' && (
              <p className="mt-2 text-xs leading-6 text-brand-redSoft">
                {enrollmentError ?? enrollmentCommand?.last_error ?? 'تعذر تنفيذ أمر التسجيل على الجهاز'}
              </p>
            )}
            {enrollmentState === 'preparing' && (
              <p className="mt-2 text-xs leading-6 text-txt-dim">
                سيظهر لك طلب وضع الإصبع عند جاهزية الجهاز. اترك الشاشة مفتوحة أثناء التجهيز.
              </p>
            )}
          </div>
          {(enrollmentState === 'preparing' || enrollmentState === 'pending') && (
            <Loader2 className="h-4 w-4 animate-spin text-brand-gold" aria-label="جارٍ تجهيز التسجيل" />
          )}
        </div>
      </Dialog>

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
            <>
              {liveEnrollment && (
                <div className="m-3 rounded-xl border border-brand-gold/30 bg-brand-gold/10 p-3 text-xs">
                  <div className="font-bold">
                    تسجيل البصمة — {list.data?.find((e) => e.id === liveEnrollment.employeeId)?.full_name ?? ''}: {zkStatus(liveEnrollment.employeeId).label}
                  </div>
                  {liveEnrollment.status.enrollmentMessage && (
                    <div className="mt-1 text-txt-dim">{liveEnrollment.status.enrollmentMessage}</div>
                  )}
                </div>
              )}
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
            </>
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
