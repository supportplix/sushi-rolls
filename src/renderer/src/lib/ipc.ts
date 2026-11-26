import type { SushiApi, AppConfig } from '@shared/ipc'

const NO_ELECTRON = 'NO_ELECTRON'

function webFallback(): SushiApi {
  return {
    config: {
      get: async (): Promise<AppConfig | null> => {
        try {
          return JSON.parse(localStorage.getItem('sushi.web.config') ?? 'null')
        } catch {
          return null
        }
      },
      set: async (config: AppConfig) => {
        localStorage.setItem('sushi.web.config', JSON.stringify(config))
        return { ok: true }
      }
    },
    print: {
      receipt: async ({ html }) => {
        try {
          const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
          const win = window.open(blobUrl, '_blank', 'width=420,height=720')
          if (!win) return { ok: false, error: NO_ELECTRON }
          setTimeout(() => {
            try {
              win.print()
            } finally {
              setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
            }
          }, 600)
          return { ok: true }
        } catch {
          return { ok: false, error: NO_ELECTRON }
        }
      },
      pdf: async () => ({ ok: false, error: NO_ELECTRON }),
      printers: async () => []
    },
    file: {
      save: async () => ({ ok: false, error: NO_ELECTRON }),
      open: async () => ({ ok: false, error: NO_ELECTRON })
    },
    app: {
      version: async () => 'web',
      openKds: async () => {
        window.open(`${window.location.origin}${window.location.pathname}#/kds`, '_blank')
        return { ok: true }
      },
      openExternal: async (url: string) => {
        window.open(url, '_blank')
        return { ok: true }
      }
    },
    zkteco: {
      status: async () => ({
        state: 'device-missing',
        deviceName: null,
        serialNumber: null,
        firmware: null,
        transport: null,
        comPort: null,
        lastSeenAt: null,
        lastSyncAt: null,
        pendingOutbox: 0,
        message: NO_ELECTRON
      }),
      health: async () => ({
        state: 'device-missing',
        deviceName: null,
        serialNumber: null,
        firmware: null,
        transport: null,
        comPort: null,
        lastSeenAt: null,
        lastSyncAt: null,
        pendingOutbox: 0,
        message: NO_ELECTRON
      }),
      service: async () => ({ ok: false, error: NO_ELECTRON }),
      configure: async () => ({ ok: false, error: NO_ELECTRON }),
      enroll: async () => ({ ok: false, error: NO_ELECTRON }),
      onStatus: () => () => undefined
    },
    updates: {
      state: async () => ({ state: 'dev', currentVersion: 'web' }),
      check: async () => ({ state: 'dev', currentVersion: 'web' }),
      install: async () => ({ ok: false, error: NO_ELECTRON }),
      onStatus: () => undefined
    }
  }
}

export const api: SushiApi =
  typeof window !== 'undefined' && window.sushi ? window.sushi : webFallback()

export function hasApi(): boolean {
  return typeof window !== 'undefined' && !!window.sushi
}
