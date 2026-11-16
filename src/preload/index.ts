import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  OpenFileArgs,
  OpenResult,
  PrintPdfArgs,
  PrintReceiptArgs,
  PrintResult,
  SaveFileArgs,
  SaveResult,
  SushiApi,
  UpdateStatus
} from '@shared/ipc'

const api: SushiApi = {
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<AppConfig | null>,
    set: (config: AppConfig) => ipcRenderer.invoke('config:set', config)
  },
  print: {
    receipt: (args: PrintReceiptArgs) => ipcRenderer.invoke('print:receipt', args) as Promise<PrintResult>,
    pdf: (args: PrintPdfArgs) => ipcRenderer.invoke('print:pdf', args) as Promise<SaveResult>,
    printers: () => ipcRenderer.invoke('print:printers') as Promise<string[]>
  },
  file: {
    save: (args: SaveFileArgs) => ipcRenderer.invoke('file:save', args) as Promise<SaveResult>,
    open: (args: OpenFileArgs) => ipcRenderer.invoke('file:open', args) as Promise<OpenResult>
  },
  app: {
    version: () => ipcRenderer.invoke('app:version') as Promise<string>,
    openKds: () => ipcRenderer.invoke('app:open-kds') as Promise<{ ok: boolean }>,
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<{ ok: boolean }>
  },
  updates: {
    state: () => ipcRenderer.invoke('updates:state') as Promise<UpdateStatus>,
    check: () => ipcRenderer.invoke('updates:check') as Promise<UpdateStatus>,
    install: () => ipcRenderer.invoke('updates:install') as Promise<{ ok: boolean; error?: string }>,
    onStatus: (callback: (status: UpdateStatus) => void) => {
      ipcRenderer.on('updates:status', (_event, status: UpdateStatus) => callback(status))
    }
  }
}

contextBridge.exposeInMainWorld('sushi', api)
