import 'server-only'
import { getEmailProvider, isMockMode } from '@/lib/messaging'

/**
 * Lean transactional mail for the auth flows (password reset, magic link).
 *
 * Deliberately NOT routed through src/lib/messaging/send.ts: that path is
 * client communication — consent-gated, Communication-row-recording, tied to a
 * Client. Auth mail has no client and must never be blocked by a comms
 * kill-switch, so it calls the SAME selected EmailProvider adapter directly
 * (env selection identical: EMAIL_PROVIDER=resend + RESEND_API_KEY +
 * EMAIL_FROM, mock default). Consent gating for client comms is untouched.
 *
 * The plaintext token appears only inside the link. In mock mode OUTSIDE
 * production the link is logged server-side and returned as `devLink` so the
 * flows are demoable without an inbox. In production the token is never
 * logged and never returned — it exists only in the recipient's email.
 */

export type AuthMailResult = {
  sent: boolean
  /** Populated ONLY in mock mode outside production. Never set in production. */
  devLink?: string
  error?: string
}

/** Resolves the absolute link base: env first, then the caller's origin. */
export function authLinkBase(originFallback?: string): string {
  const base =
    process.env.APP_URL ||
    process.env.AUTH_URL ||
    process.env.NEXTAUTH_URL ||
    originFallback ||
    'http://localhost:3300'
  return base.replace(/\/+$/, '')
}

const APP_NAME = 'ProdigyFlo'

/**
 * Minimal branded HTML shell. Inline styles + email-safe hex on purpose: email
 * clients ignore stylesheets and cannot resolve the app's oklch tokens, so
 * this template lives outside the token system by necessity.
 */
export function buildAuthEmailHtml(input: {
  heading: string
  intro: string
  buttonLabel: string
  link: string
  expiryNote: string
}): string {
  const { heading, intro, buttonLabel, link, expiryNote } = input
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">
    <div style="max-width:480px;margin:0 auto;padding:32px 20px;">
      <div style="font-size:18px;font-weight:700;letter-spacing:-0.02em;margin-bottom:20px;">Prodigy<span style="color:#4f46e5;">Flo</span></div>
      <div style="background:#ffffff;border:1px solid #e4e6ea;border-radius:12px;padding:28px;">
        <h1 style="margin:0 0 8px;font-size:18px;font-weight:600;">${heading}</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4b5158;">${intro}</p>
        <a href="${link}" style="display:inline-block;background:#1a1d21;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">${buttonLabel}</a>
        <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#7a8088;">${expiryNote}</p>
        <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#7a8088;">If this wasn't you, you can safely ignore this email — nothing changes until the link is used.</p>
      </div>
      <p style="margin:16px 0 0;font-size:11px;color:#a0a4ab;">${APP_NAME} · This link was requested for your account.</p>
    </div>
  </body>
</html>`
}

async function sendAuthMail(input: {
  to: string
  subject: string
  text: string
  html: string
  link: string
  logLabel: string
}): Promise<AuthMailResult> {
  const provider = getEmailProvider()
  const result = await provider.send({
    to: input.to,
    subject: input.subject,
    body: input.text,
    html: input.html,
  })

  // Dev-only conveniences. BOTH are gated on NODE_ENV: a production box left
  // on the default mock provider must never write live sign-in/reset links to
  // its server logs, and a production response never carries the token.
  const devMock = isMockMode('EMAIL') && process.env.NODE_ENV !== 'production'
  if (devMock) {
    // Server log only — how a dev without an inbox completes the flow.
    console.log(`[auth-mail:mock] ${input.logLabel} for ${input.to}: ${input.link}`)
  }

  return {
    sent: result.status === 'SENT',
    ...(devMock ? { devLink: input.link } : {}),
    ...(result.status === 'FAILED' ? { error: result.error } : {}),
  }
}

export async function sendPasswordResetEmail(input: {
  to: string
  token: string
  originFallback?: string
}): Promise<AuthMailResult> {
  const link = `${authLinkBase(input.originFallback)}/reset-password?token=${encodeURIComponent(input.token)}`
  const expiryNote = 'This link works once and expires in 30 minutes.'
  return sendAuthMail({
    to: input.to,
    subject: `Reset your ${APP_NAME} password`,
    text: `Reset your ${APP_NAME} password:\n\n${link}\n\n${expiryNote}\nIf this wasn't you, ignore this email — nothing changes until the link is used.`,
    html: buildAuthEmailHtml({
      heading: 'Reset your password',
      intro: `Someone asked to reset the ${APP_NAME} password for this address. Choose a new one below.`,
      buttonLabel: 'Choose a new password',
      link,
      expiryNote,
    }),
    link,
    logLabel: 'password reset link',
  })
}

export async function sendMagicLinkEmail(input: {
  to: string
  token: string
  originFallback?: string
}): Promise<AuthMailResult> {
  const link = `${authLinkBase(input.originFallback)}/login/magic?token=${encodeURIComponent(input.token)}`
  const expiryNote = 'This link works once and expires in 15 minutes.'
  return sendAuthMail({
    to: input.to,
    subject: `Your ${APP_NAME} sign-in link`,
    text: `Sign in to ${APP_NAME}:\n\n${link}\n\n${expiryNote}\nIf this wasn't you, ignore this email — nobody can sign in without it.`,
    html: buildAuthEmailHtml({
      heading: 'Sign in to ProdigyFlo',
      intro: 'Click the button below and you are in — no password needed.',
      buttonLabel: 'Sign in',
      link,
      expiryNote,
    }),
    link,
    logLabel: 'magic sign-in link',
  })
}
