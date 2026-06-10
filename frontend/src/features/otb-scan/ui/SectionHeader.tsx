import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ForkedWordmark } from './Brand'

// Mirrors PawnPrint/frontend SectionHeader so the scanner header matches the
// rest of the product exactly.
export function SectionHeader({
  icon: Icon,
  title,
  description,
  right,
}: {
  icon: LucideIcon
  title: string
  description: string
  right?: ReactNode
}) {
  return (
    <div className="flex items-end justify-between mb-5 gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-bold text-text-0 flex items-center gap-2 flex-wrap">
          <Icon size={18} className="text-accent flex-shrink-0" />
          <ForkedWordmark className="text-xl" />
          <span className="text-text-1 font-semibold">{title}</span>
        </h1>
        <p className="text-xs text-text-2 mt-1 leading-relaxed">{description}</p>
      </div>
      {right && <div className="text-right flex-shrink-0">{right}</div>}
    </div>
  )
}
