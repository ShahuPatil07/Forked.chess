// Forked wordmark — identical treatment to PawnPrint/frontend AppShell.tsx so
// the scanner reads as a native section of the product.
export function ForkedWordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`font-black tracking-tight select-none ${className}`}
      style={{
        background: 'linear-gradient(135deg, #c4b5fd 0%, #7B61FF 45%, #a78bfa 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        letterSpacing: '-0.03em',
      }}
    >
      Forked
    </span>
  )
}

export function ForkedLogo({ className = 'h-8 w-auto' }: { className?: string }) {
  return <img src="/logo.png" alt="Forked" className={className} />
}
