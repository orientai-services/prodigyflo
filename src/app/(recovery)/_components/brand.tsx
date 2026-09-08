import { cn } from '@/lib/utils'

/**
 * Lead Recovery Flow logo mark — a self-contained inline SVG so it never 404s
 * and inherits the recovery accent. A circular "return" loop (recycle the lead)
 * wrapped around an upward chevron (the deal rising again toward the close).
 */
export function RecoveryLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('h-6 w-6 shrink-0', className)}
      role="img"
      aria-label="Lead Recovery Flow"
    >
      <rect width="32" height="32" rx="9" fill="var(--rec-primary)" />
      {/* recovery loop — an open ring that comes back around */}
      <path
        d="M23 12.5a8 8 0 1 0 1.4 6"
        fill="none"
        stroke="var(--rec-on-primary)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* arrowhead closing the loop */}
      <path
        d="M23.6 8.2l.4 4.9-4.9-.5"
        fill="none"
        stroke="var(--rec-on-primary)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* rising-again chevron */}
      <path
        d="M12.5 18.5L16 15l3.5 3.5"
        fill="none"
        stroke="var(--rec-on-primary)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Full lockup: mark + wordmark, with "Recovery" carrying the accent. */
export function RecoveryWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <RecoveryLogo />
      <span className="text-[0.95rem] leading-none font-semibold tracking-tight text-[var(--rec-text)]">
        Lead <span className="text-[var(--rec-primary-ink)]">Recovery</span> Flow
      </span>
    </span>
  )
}
