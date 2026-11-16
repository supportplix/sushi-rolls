import { useEffect, useSyncExternalStore } from 'react'
import type { UpdateStatus } from '@shared/ipc'
import { api } from './ipc'

let status: UpdateStatus = { state: 'idle', currentVersion: '' }
let started = false
const listeners = new Set<() => void>()

function publish(next: UpdateStatus): void {
  status = next
  listeners.forEach((listener) => listener())
}

export function initUpdates(): void {
  if (started) return
  started = true
  void api.updates.state().then(publish).catch(() => undefined)
  api.updates.onStatus(publish)
}

export function useUpdateStatus(): UpdateStatus {
  useEffect(() => {
    initUpdates()
  }, [])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => status,
    () => status
  )
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  initUpdates()
  try {
    const next = await api.updates.check()
    if (next.state === 'dev' || next.state === 'error') publish(next)
    return next
  } catch {
    const next: UpdateStatus = { ...status, state: 'error' }
    publish(next)
    return next
  }
}

export async function installUpdate(): Promise<{ ok: boolean; error?: string }> {
  return api.updates.install()
}
