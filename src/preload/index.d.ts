import type { SushiApi } from '@shared/ipc'

declare global {
  interface Window {
    sushi: SushiApi
  }
}

export {}
