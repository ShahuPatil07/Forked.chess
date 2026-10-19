// The scanner reuses the product's wordmark so it reads as a native section.
export { ForkedWordmark } from '../../../components/layout/AppShell'

export function ForkedLogo({ className = 'h-8 w-auto' }: { className?: string }) {
  return <img src="/logo.png" alt="Forked" className={className} />
}
