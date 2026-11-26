import { useEffect, useState } from 'react'
import { Fingerprint, Loader2, Power, RefreshCw, Save, ShieldCheck, Usb } from 'lucide-react'
import { useAuth, useDb } from '@/lib/auth'
import { humanError } from '@/lib/errors'
import { api } from '@/lib/ipc'
import { useAsync } from '@/lib/hooks'
import { Badge, Button, Field, PageLoader, SectionCard, Select } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import {
  createOrRotateDevice,
  listDevices,
  revokeDeviceToken,
  updateDevice,
  type AttendanceDevice
} from '@/lib/zkteco'
import type { ZkTecoStatus } from '@shared/ipc'

const idleStatus: ZkTecoStatus = {
  state: 'idle',
  deviceName: null,
  serialNumber: null,
  firmware: null,
  transport: null,
  comPort: null,
  lastSeenAt: null,
  lastSyncAt: null,
  pendingOutbox: 0,
  message: null
}

export default function ZKTecoSettingsCard(): JSX.Element {
  const db = useDb()
  const { can, config, profile } = useAuth()
  const canManageDevice = can('device.manage') || profile?.role === 'super_admin'
  const toast = useToast()
  const [status, setStatus] = useState<ZkTecoStatus>(idleStatus)
  const [busy, setBusy] = useState<string | null>(null)
  const [mode, setMode] = useState('alternating')
  const [background, setBackground] = useState('app_only')
  const [timezone, setTimezone] = useState('Africa/Cairo')

  const devices = useAsync(async () => {
    if (!canManageDevice) return [] as AttendanceDevice[]
    return listDevices(db)
  }, [db, canManageDevice])
  const device = devices.data?.[0] ?? null

  useEffect(() => {
    void api.zkteco.status().then(setStatus)
    return api.zkteco.onStatus(setStatus)
  }, [])

  useEffect(() => {
    if (!device) return
    setMode(device.attendance_mode)
    setBackground(device.background_mode)
    setTimezone(device.timezone)
  }, [device])

  const run = async (name: string, action: () => Promise<void>): Promise<void> => {
    setBusy(name)
    try {
      await action()
      toast.success('تم الحفظ')
    } catch (error) {
      toast.error(humanError(error))
    } finally {
      setBusy(null)
    }
  }

  const service = async (action: 'install' | 'start' | 'stop' | 'remove' | 'agent-install' | 'agent-remove'): Promise<void> => {
    const { data } = await db.auth.getSession()
    const accessToken = data.session?.access_token
    if (!accessToken) throw new Error('NO_SESSION')
    const result = await api.zkteco.service({ action, accessToken })
    if (!result.ok) throw new Error(result.error ?? 'SERVICE_ACTION_FAILED')
  }

  if (!canManageDevice) return <></>

  return (
    <SectionCard title="جهاز البصمة ZKTeco LX15">
      {devices.error && (
        <div className="mb-4 rounded-xl border border-brand-redSoft/30 bg-brand-redSoft/10 p-3 text-[11px] text-brand-redSoft">
          تعذر تحميل إعدادات الجهاز: {humanError(devices.error)}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-black/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Usb className="h-4 w-4 text-brand-gold" />
              حالة الجهاز
            </div>
            <Badge color={status.state === 'connected' ? '#3DBE7A' : '#E4BE54'}>
              {status.state === 'connected' ? 'متصل' : status.state}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px] text-txt-dim">
            <div>الاسم: {status.deviceName ?? '—'}</div>
            <div>Serial: {status.serialNumber ?? '—'}</div>
            <div>Firmware: {status.firmware ?? '—'}</div>
            <div>النقل: {status.transport ?? '—'}</div>
            <div>آخر اتصال: {status.lastSeenAt ? new Date(status.lastSeenAt).toLocaleString('ar-EG') : '—'}</div>
            <div>آخر مزامنة: {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('ar-EG') : '—'}</div>
            <div>أحداث مؤجلة: {status.pendingOutbox}</div>
            <div>فرق الساعة: {device?.clock_drift_seconds ?? '—'} ث</div>
            <div>مستخدمو الجهاز: {status.users ?? '—'}</div>
            <div>بصمات مسجلة: {status.fingerprints ?? '—'}</div>
            <div>سجلات الحضور: {status.records ?? '—'}</div>
          </div>
          {status.message && <div className="text-[11px] text-brand-redSoft">{status.message}</div>}
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => void run('health', async () => setStatus(await api.zkteco.health()))}
          >
            إعادة فحص
          </Button>
        </div>

        <div className="space-y-3">
          <Field label="سياسة الحضور">
            <Select
              value={mode}
              onChange={setMode}
              options={[
                { value: 'alternating', ar: 'تلقائي: أول بصمة حضور والثانية انصراف' },
                { value: 'device_state', ar: 'الموظف يختار الحالة من الجهاز' },
                { value: 'raw_only', ar: 'تسجيل خام للمدير' }
              ]}
            />
          </Field>
          <Field label="وضع التشغيل">
            <Select
              value={background}
              onChange={setBackground}
              options={[
                { value: 'app_only', ar: 'مع فتح SUSHI ROLLS فقط' },
                { value: 'logon_agent', ar: 'خلفية بعد دخول Windows' },
                { value: 'windows_service', ar: 'خدمة Windows قبل الدخول' }
              ]}
            />
          </Field>
          <Field label="المنطقة الزمنية">
            <input className="input" value={timezone} onChange={(event) => setTimezone(event.target.value)} dir="ltr" />
          </Field>
          <Button
            icon={busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            disabled={!device || busy !== null}
            onClick={() => void run('save', async () => {
              if (!device) return
              await updateDevice(db, device.id, {
                attendance_mode: mode as AttendanceDevice['attendance_mode'],
                background_mode: background as AttendanceDevice['background_mode'],
                timezone
              })
              await devices.reload()
            })}
          >
            حفظ الإعدادات
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-white/[0.06] pt-4">
        <Button
          icon={<Fingerprint className="h-4 w-4" />}
          disabled={busy !== null || !config?.supabaseUrl}
          onClick={() => void run('token', async () => {
            if (!config?.supabaseUrl) throw new Error('SUPABASE_NOT_CONFIGURED')
            await createOrRotateDevice(db, config.supabaseUrl, device)
            await devices.reload()
          })}
        >
          {device?.device_token_hash ? 'تدوير توكن الجهاز' : 'ربط الجهاز وتوليد توكن'}
        </Button>
        <Button
          variant="danger"
          icon={<ShieldCheck className="h-4 w-4" />}
          disabled={!device?.device_token_hash || busy !== null}
          onClick={() => void run('revoke', async () => {
            if (!device) return
            await revokeDeviceToken(db, device.id)
            await devices.reload()
          })}
        >
          إلغاء التوكن
        </Button>
        <Button variant="ghost" icon={<Power className="h-4 w-4" />} disabled={busy !== null} onClick={() => void run('service-install', () => service('install'))}>
          تثبيت الخدمة
        </Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => void run('agent-install', () => service('agent-install'))}>تشغيل خلفية بعد الدخول</Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => void run('agent-remove', () => service('agent-remove'))}>إيقاف خلفية الدخول</Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => void run('service-start', () => service('start'))}>تشغيل الخدمة</Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => void run('service-stop', () => service('stop'))}>إيقاف الخدمة</Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => void run('service-remove', () => service('remove'))}>حذف الخدمة</Button>
      </div>
      {devices.loading && !devices.data && <PageLoader />}
    </SectionCard>
  )
}
