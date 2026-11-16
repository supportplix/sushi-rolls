import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

export function Popover({
  open,
  anchorRef,
  onClose,
  matchWidth = false,
  width,
  className,
  children
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement>
  onClose: () => void
  matchWidth?: boolean
  width?: number
  className?: string
  children: ReactNode
}): JSX.Element | null {
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width?: number } | null>(null)

  const update = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    const el = popRef.current
    if (!anchor) return
    const w = matchWidth ? anchor.width : width ?? el?.offsetWidth ?? 240
    const h = el?.offsetHeight ?? 0
    const margin = 8
    let left = anchor.left
    if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w
    left = Math.max(margin, left)
    let top = anchor.bottom + 6
    if (top + h > window.innerHeight - margin && anchor.top - h - 6 >= margin) {
      top = anchor.top - h - 6
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - margin - h))
    setPos({ top, left, width: w })
  }, [anchorRef, matchWidth, width])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    update()
    const frame = requestAnimationFrame(update)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, update])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node
      if (popRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  return createPortal(
    <div
      ref={popRef}
      style={{
        position: 'fixed',
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: pos?.width,
        visibility: pos ? 'visible' : 'hidden'
      }}
      className={cn('z-[300]', className)}
    >
      {children}
    </div>,
    document.body
  )
}
