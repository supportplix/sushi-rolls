export interface AppConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  printerName?: string | null
  receiptWidth?: 58 | 80
  language?: 'ar' | 'en'
  rememberUsername?: string | null
}

export interface PrintReceiptArgs {
  html: string
  deviceName?: string | null
  silent?: boolean
  widthMm?: 58 | 80
}

export interface ThermalPrinterProfile {
  paperWidthMm: 58 | 80
  printableWidthMm: number
  safeMarginMm: number
  contentPaddingMm: number
  bottomFeedClearanceMm: number
}

export const THERMAL_PROFILES: Record<58 | 80, ThermalPrinterProfile> = {
  58: {
    paperWidthMm: 58,
    printableWidthMm: 48,
    safeMarginMm: 5,
    contentPaddingMm: 1.5,
    bottomFeedClearanceMm: 8
  },
  80: {
    paperWidthMm: 80,
    printableWidthMm: 72,
    safeMarginMm: 4,
    contentPaddingMm: 2,
    bottomFeedClearanceMm: 10
  }
}

export const RECEIPT_MIN_PAGE_HEIGHT_MM = 40
export const RECEIPT_MAX_PAGE_HEIGHT_MM = 2000

export function receiptPageSize(
  widthMm: 58 | 80 | undefined,
  contentHeightPx?: number | null
): { width: number; height: number } {
  const width = widthMm === 58 ? 58 : 80
  const px = Number(contentHeightPx ?? 0)
  const heightMm = Number.isFinite(px) && px > 0
    ? Math.min(Math.max(Math.ceil(px * 25.4 / 96) + 6, RECEIPT_MIN_PAGE_HEIGHT_MM), RECEIPT_MAX_PAGE_HEIGHT_MM)
    : RECEIPT_MIN_PAGE_HEIGHT_MM
  return { width: width * 1000, height: heightMm * 1000 }
}

export interface PrintPdfArgs {
  html: string
  fileName?: string
}

export interface SaveFileArgs {
  dataBase64: string
  fileName: string
  filters?: { name: string; extensions: string[] }[]
}

export interface OpenFileArgs {
  filters?: { name: string; extensions: string[] }[]
}

export interface PrintResult {
  ok: boolean
  error?: string
}

export interface SaveResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export interface OpenResult {
  ok: boolean
  name?: string
  dataBase64?: string
  canceled?: boolean
  error?: string
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'dev'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  version?: string
  percent?: number
}

export type ZkTecoConnectionState =
  | 'idle'
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'driver-missing'
  | 'device-missing'
  | 'busy'
  | 'error'

export interface ZkTecoStatus {
  state: ZkTecoConnectionState
  deviceName: string | null
  serialNumber: string | null
  firmware: string | null
  transport: 'usb-std' | 'virtual-com' | null
  comPort: number | null
  lastSeenAt: string | null
  lastSyncAt: string | null
  pendingOutbox: number
  message: string | null
}

export interface ZkTecoServiceResult {
  ok: boolean
  error?: string
}

export interface ZkTecoConfigureArgs {
  supabaseUrl: string
  deviceToken: string
  timezone: string
  accessToken: string
}

export interface ZkTecoApi {
  status: () => Promise<ZkTecoStatus>
  health: () => Promise<ZkTecoStatus>
  configure: (args: ZkTecoConfigureArgs) => Promise<ZkTecoServiceResult>
  service: (args: { action: 'install' | 'start' | 'stop' | 'remove' | 'agent-install' | 'agent-remove'; accessToken: string }) => Promise<ZkTecoServiceResult>
  onStatus: (callback: (status: ZkTecoStatus) => void) => void
}

export interface SushiApi {
  config: {
    get: () => Promise<AppConfig | null>
    set: (config: AppConfig) => Promise<{ ok: boolean; error?: string }>
  }
  print: {
    receipt: (args: PrintReceiptArgs) => Promise<PrintResult>
    pdf: (args: PrintPdfArgs) => Promise<SaveResult>
    printers: () => Promise<string[]>
  }
  file: {
    save: (args: SaveFileArgs) => Promise<SaveResult>
    open: (args: OpenFileArgs) => Promise<OpenResult>
  }
  app: {
    version: () => Promise<string>
    openKds: () => Promise<{ ok: boolean }>
    openExternal: (url: string) => Promise<{ ok: boolean }>
  }
  zkteco: ZkTecoApi
  updates: {
    state: () => Promise<UpdateStatus>
    check: () => Promise<UpdateStatus>
    install: () => Promise<{ ok: boolean; error?: string }>
    onStatus: (callback: (status: UpdateStatus) => void) => void
  }
}
