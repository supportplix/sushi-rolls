import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { cn } from '@/lib/cn'

type ToastType = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  type: ToastType
  message: string
}

interface ToastApi {
  push: (type: ToastType, message: string) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const push = useCallback((type: ToastType, message: string) => {
    const id = ++seq.current
    setItems((list) => [...list.slice(-3), { id, type, message }])
    setTimeout(() => {
      setItems((list) => list.filter((i) => i.id !== id))
    }, type === 'error' ? 6000 : 3500)
  }, [])

  const api: ToastApi = {
    push,
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m)
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-[48px] z-[200] flex flex-col items-center gap-2 px-4">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={cn(
              'pointer-events-auto flex min-w-[260px] max-w-xl animate-pop items-center gap-2.5 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-card backdrop-blur-xl',
              item.type === 'success' && 'border-emerald-400/25 bg-emerald-500/[0.10] text-emerald-300',
              item.type === 'error' && 'border-brand-red/[0.35] bg-brand-red/[0.12] text-brand-redSoft',
              item.type === 'info' && 'border-brand-gold/30 bg-brand-gold/[0.10] text-brand-gold'
            )}
          >
            {item.type === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0" />}
            {item.type === 'error' && <AlertTriangle className="h-4 w-4 shrink-0" />}
            {item.type === 'info' && <Info className="h-4 w-4 shrink-0" />}
            <span className="leading-snug">{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast outside ToastProvider')
  return ctx
}
