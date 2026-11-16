import { cn } from '@/lib/cn'

export function AuroraField({ className }: { className?: string }): JSX.Element {
  return (
    <div aria-hidden className={cn('aurora-field', className)}>
      <div className="aurora-blob aurora-a" />
      <div className="aurora-blob aurora-b" />
      <div className="aurora-blob aurora-c" />
      <div className="aurora-grain" />
    </div>
  )
}
