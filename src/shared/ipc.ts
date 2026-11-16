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
  updates: {
    state: () => Promise<UpdateStatus>
    check: () => Promise<UpdateStatus>
    install: () => Promise<{ ok: boolean; error?: string }>
    onStatus: (callback: (status: UpdateStatus) => void) => void
  }
}
