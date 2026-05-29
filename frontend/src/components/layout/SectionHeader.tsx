import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ForkedWordmark } from './AppShell'

/**
 * Unified page header used by every section in the app.
 *
 * Pattern (matches the Openings page exactly):
 *   [icon] **Forked** {title}                                  STATS FROM
 *   {description}                                              {right slot}
 */
export function SectionHeader({
  icon: Icon,
  title,
  description,
  right,
}: {
  icon:         LucideIcon
  title:        string
  description:  string
  right?:       ReactNode
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
      {right && (
        <div className="text-right flex-shrink-0">{right}</div>
      )}
    </div>
  )
}

/** Standard right-slot pattern: an uppercase mini-label + a tabular value. */
export function SectionHeaderStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <p className="text-[10px] text-text-2 uppercase tracking-wider">{label}</p>
      <p className="text-xs text-text-1 tabular-nums">{value}</p>
    </>
  )
}
