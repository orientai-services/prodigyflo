import type { ReactNode } from 'react'

/** Shared Daily Desk page chrome — cream paper heading, existing actions sit to the right. */
export function DeskChrome({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="desk-page">
      <div className="desk-head">
        <div>
          <h1 className="font-heading">{title}</h1>
          {description ? <p className="desk-muted">{description}</p> : null}
        </div>
        {actions ? <div className="desk-actions-row">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}
