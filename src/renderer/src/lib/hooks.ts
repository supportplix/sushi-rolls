import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from './auth'

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = []
): { data: T | null; loading: boolean; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const gen = useRef(0)

  const run = useCallback(async () => {
    const g = ++gen.current
    setLoading(true)
    setError(null)
    try {
      const res = await fn()
      if (g === gen.current) setData(res)
    } catch (err) {
      if (g === gen.current) setError(String((err as Error)?.message ?? err))
    } finally {
      if (g === gen.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    void run()
    return () => {
      gen.current++
    }
  }, [run])

  return { data, loading, error, reload: run }
}

export function useRealtimeRefresh(tables: string[], onChange: () => void): void {
  const { client } = useAuth()
  const cb = useRef(onChange)
  cb.current = onChange

  useEffect(() => {
    if (!client) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const channel = client.channel(`rt-${tables.join('-')}-${Math.random().toString(36).slice(2, 8)}`)
    for (const table of tables) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => cb.current(), 350)
      })
    }
    channel.subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      void client.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tables.join(',')])
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
