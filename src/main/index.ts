import { app, BrowserWindow, ipcMain, dialog, Menu, shell, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { z } from 'zod'
import type {
  AppConfig,
  OpenFileArgs,
  OpenResult,
  PrintPdfArgs,
  PrintReceiptArgs,
  PrintResult,
  SaveFileArgs,
  SaveResult,
  UpdateStatus
} from '@shared/ipc'
import { receiptPageSize } from '@shared/ipc'
import { ZkTecoBridgeManager } from './zkteco'
import type { ZkTecoServiceResult, ZkTecoStatus } from '@shared/ipc'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const RENDERER_URL = process.env['ELECTRON_RENDERER_URL'] || ''
const APP_ID = 'com.sushirolls.pos'

// Non-printable hardware allowance (mm) reserved at each physical paper edge so
// thermal printer margins never clip receipt content.
const RECEIPT_SAFE_MARGIN_MM = 1.5

if (isDev && process.env['SUSHI_CDP_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['SUSHI_CDP_PORT'])
}

let mainWindow: BrowserWindow | null = null
let kdsWindow: BrowserWindow | null = null

const zktecoBridge = new ZkTecoBridgeManager((status) => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('zkteco:status', status)
})

const configSchema = z.object({
  supabaseUrl: z.string().max(300),
  supabaseAnonKey: z.string().max(4000),
  printerName: z.string().max(300).nullable().optional(),
  receiptWidth: z.union([z.literal(58), z.literal(80)]).optional(),
  language: z.enum(['ar', 'en']).optional(),
  rememberUsername: z.string().max(120).nullable().optional()
})

const printArgsSchema = z.object({
  html: z.string().min(20).max(6_000_000),
  deviceName: z.string().max(300).nullable().optional(),
  silent: z.boolean().optional(),
  widthMm: z.union([z.literal(58), z.literal(80)]).optional()
})

const pdfArgsSchema = z.object({
  html: z.string().min(20).max(6_000_000),
  fileName: z.string().max(200).optional()
})

const saveFileSchema = z.object({
  dataBase64: z.string().min(1).max(60_000_000),
  fileName: z.string().min(1).max(250),
  filters: z
    .array(z.object({ name: z.string().max(100), extensions: z.array(z.string().max(10)).max(10) }))
    .max(10)
    .optional()
})

const openFileSchema = z.object({
  filters: z
    .array(z.object({ name: z.string().max(100), extensions: z.array(z.string().max(10)).max(10) }))
    .max(10)
    .optional()
})

const zktecoConfigureSchema = z.object({
  supabaseUrl: z.string().url().max(300),
  deviceToken: z.string().min(32).max(512),
  timezone: z.string().min(1).max(64),
  accessToken: z.string().min(1).max(4000)
})

const zktecoServiceSchema = z.object({
  action: z.enum(['install', 'start', 'stop', 'remove', 'agent-install', 'agent-remove']),
  accessToken: z.string().min(1).max(4000)
})

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function readConfig(): AppConfig | null {
  try {
    const file = configPath()
    if (!existsSync(file)) return null
    const parsed = configSchema.safeParse(JSON.parse(readFileSync(file, 'utf-8')))
    return parsed.success ? (parsed.data as AppConfig) : null
  } catch {
    return null
  }
}

function writeConfig(config: AppConfig): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
}

function resourcePath(name: string): string {
  return join(app.getAppPath(), 'resources', name)
}

function activeWindow(): BrowserWindow | undefined {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0]
  return win && !win.isDestroyed() ? win : undefined
}

async function showSave(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
  const win = activeWindow()
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

async function showOpen(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  const win = activeWindow()
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

function createWindow(hashRoute = ''): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#050506',
    autoHideMenuBar: true,
    icon: existsSync(resourcePath('icon.png')) ? resourcePath('icon.png') : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#050506', symbolColor: '#F7F7F5', height: 38 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(RENDERER_URL) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('https://')) shell.openExternal(url)
    }
  })

  if (isDev) {
    win.loadURL(`${RENDERER_URL}${hashRoute ? `#${hashRoute}` : ''}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), hashRoute ? { hash: hashRoute } : undefined)
  }

  return win
}

function openHidden(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 360,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: false
    }
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadHtml(win: BrowserWindow, html: string): Promise<void> {
  const dataUrl = 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf-8').toString('base64')
  await win.loadURL(dataUrl)
  await win.webContents
    .executeJavaScript(`
      (async () => {
        if (document.fonts) {
          await document.fonts.ready
        }
        await new Promise<void>((resolve) => {
          const images = Array.from(document.images)
          if (!images.length) {
            return resolve()
          }
          const tick = () => {
            const ready = images.every((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0)
            if (ready) {
              return resolve()
            }
            requestAnimationFrame(tick)
          }
          tick()
          setTimeout(resolve, 5000)
        })
      })();
    `)
    .catch(() => true)
}

ipcMain.handle('zkteco:status', (): ZkTecoStatus => zktecoBridge.getStatus())

ipcMain.handle('zkteco:health', async (): Promise<ZkTecoStatus> => zktecoBridge.health())

ipcMain.handle('zkteco:configure', async (_e, raw): Promise<ZkTecoServiceResult> => {
  const parsed = zktecoConfigureSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'INVALID_ARGS' }
  if (!await zktecoBridge.authorize(parsed.data.accessToken)) return { ok: false, error: 'FORBIDDEN' }
  return zktecoBridge.configure(parsed.data.supabaseUrl, parsed.data.deviceToken, parsed.data.timezone)
})

ipcMain.handle('zkteco:service', async (_e, raw): Promise<ZkTecoServiceResult> => {
  const parsed = zktecoServiceSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'INVALID_ARGS' }
  return zktecoBridge.service(parsed.data.action, parsed.data.accessToken)
})

ipcMain.handle('config:get', (): AppConfig | null => readConfig())

ipcMain.handle('config:set', (_e, raw): { ok: boolean; error?: string } => {
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'INVALID_CONFIG' }
  writeConfig(parsed.data as AppConfig)
  return { ok: true }
})

ipcMain.handle('print:printers', async (): Promise<string[]> => {
  try {
    const list = await (mainWindow ?? BrowserWindow.getAllWindows()[0])?.webContents.getPrintersAsync()
    return (list ?? []).map((p) => p.name)
  } catch {
    return []
  }
})

ipcMain.handle('print:receipt', async (_e, raw): Promise<PrintResult> => {
  const parsed = printArgsSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'INVALID_ARGS' }
  const args = parsed.data as PrintReceiptArgs
  const win = openHidden()
  try {
    await loadHtml(win, args.html)
    const contentHeightPxRaw = await win.webContents.executeJavaScript(`
      Math.ceil(Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        document.body.getBoundingClientRect().height,
        document.documentElement.getBoundingClientRect().height
      ))
    `) as number
    const contentHeightPx = Number.isFinite(contentHeightPxRaw) ? contentHeightPxRaw : 0
    const pageSize = receiptPageSize(args.widthMm, contentHeightPx)
    console.log('[print:receipt] measured contentHeightPx=%o pageSize=%o widthMm=%o', contentHeightPx, pageSize, args.widthMm)
    const silent = args.silent ?? !!args.deviceName
    if (!silent) {
      win.show()
      win.focus()
    }
    const result = await new Promise<PrintResult>((resolve) => {
      win.webContents.print(
        {
          silent,
          printBackground: true,
          deviceName: args.deviceName ?? undefined,
          margins: { marginType: 'none' },
          pageSize
        },
        (success, failureReason) => resolve({ ok: success, error: success ? undefined : failureReason })
      )
    })
    return result
  } catch (err) {
    return { ok: false, error: String(err) }
  } finally {
    win.destroy()
  }
})

ipcMain.handle('print:pdf', async (_e, raw): Promise<SaveResult> => {
  const parsed = pdfArgsSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'INVALID_ARGS' }
  const args = parsed.data as PrintPdfArgs
  const win = openHidden()
  try {
    await loadHtml(win, args.html)
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
    })
    const save = await showSave({
      title: 'Save PDF',
      defaultPath: args.fileName ?? 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (save.canceled || !save.filePath) return { ok: false, canceled: true }
    writeFileSync(save.filePath, pdf)
    return { ok: true, path: save.filePath }
  } catch (err) {
    return { ok: false, error: String(err) }
  } finally {
    win.destroy()
  }
})

ipcMain.handle('file:save', async (_e, raw): Promise<SaveResult> => {
  const parsed = saveFileSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'INVALID_ARGS' }
  const args = parsed.data as SaveFileArgs
  try {
    const save = await showSave({
      title: 'Save',
      defaultPath: args.fileName,
      filters: args.filters
    })
    if (save.canceled || !save.filePath) return { ok: false, canceled: true }
    writeFileSync(save.filePath, Buffer.from(args.dataBase64, 'base64'))
    return { ok: true, path: save.filePath }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('file:open', async (_e, raw): Promise<OpenResult> => {
  const parsed = openFileSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'INVALID_ARGS' }
  const args = parsed.data as OpenFileArgs
  try {
    const picked = await showOpen({
      title: 'Open',
      properties: ['openFile'],
      filters: args.filters
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    const data = readFileSync(picked.filePaths[0])
    return {
      ok: true,
      name: picked.filePaths[0].split(/[\\/]/).pop(),
      dataBase64: data.toString('base64')
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('app:open-kds', (): { ok: boolean } => {
  if (kdsWindow && !kdsWindow.isDestroyed()) {
    kdsWindow.focus()
    return { ok: true }
  }
  kdsWindow = createWindow('/kds')
  kdsWindow.setTitleBarOverlay?.({ color: '#050506', symbolColor: '#F7F7F5', height: 38 })
  kdsWindow.maximize()
  kdsWindow.on('closed', () => (kdsWindow = null))
  return { ok: true }
})

ipcMain.handle('app:open-external', (_e, url: unknown): { ok: boolean } => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url)
    return { ok: true }
  }
  return { ok: false }
})

let updateStatus: UpdateStatus = { state: 'idle', currentVersion: '' }

function setUpdateStatus(next: Partial<UpdateStatus>): void {
  updateStatus = { ...updateStatus, ...next, currentVersion: app.getVersion() }
  const win = mainWindow
  if (win && !win.isDestroyed()) win.webContents.send('updates:status', updateStatus)
}

function checkForUpdates(): void {
  if (!app.isPackaged) {
    setUpdateStatus({ state: 'dev' })
    return
  }
  if (updateStatus.state === 'downloading' || updateStatus.state === 'downloaded') return
  setUpdateStatus({ state: 'checking' })
  void autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updates] check failed', err?.message ?? err)
    setUpdateStatus({ state: 'error' })
  })
}

function setupAutoUpdates(): void {
  setUpdateStatus({ state: app.isPackaged ? 'idle' : 'dev' })
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => setUpdateStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => setUpdateStatus({ state: 'available', version: info.version }))
  autoUpdater.on('download-progress', (p) => setUpdateStatus({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-not-available', () => setUpdateStatus({ state: 'up-to-date' }))
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateStatus({ state: 'downloaded', version: info.version, percent: 100 })
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'تحديث SUSHI ROLLS جاهز',
        body: `تم تنزيل الإصدار ${info.version} — أعد تشغيل التطبيق للتثبيت.`,
        icon: existsSync(resourcePath('icon.png')) ? resourcePath('icon.png') : undefined
      })
      notification.on('click', () => {
        const win = activeWindow()
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
      })
      notification.show()
    }
  })
  autoUpdater.on('error', (err) => {
    console.error('[updates]', err?.message ?? err)
    setUpdateStatus({ state: 'error' })
  })
  setTimeout(checkForUpdates, 6000)
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000)
}

ipcMain.handle('updates:state', (): UpdateStatus => updateStatus)
ipcMain.handle('updates:check', (): UpdateStatus => {
  checkForUpdates()
  return updateStatus
})
ipcMain.handle('updates:install', (): { ok: boolean; error?: string } => {
  if (!app.isPackaged) return { ok: false, error: 'DEV' }
  if (updateStatus.state !== 'downloaded') return { ok: false, error: 'NOT_READY' }
  setImmediate(() => autoUpdater.quitAndInstall())
  return { ok: true }
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)
    if (!isDev) Menu.setApplicationMenu(null)
    mainWindow = createWindow()
    mainWindow.on('closed', () => (mainWindow = null))
    setupAutoUpdates()
    zktecoBridge.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('before-quit', () => zktecoBridge.stop())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
