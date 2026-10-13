'use client'

import { useState, type ReactNode } from 'react'
import { initials, safeAvatar } from './format'

/**
 * A person's round face in the team chat: their picture when the Worker sent
 * one from an allowed origin (format.ts safeAvatar), else their initials. A
 * picture that fails to load falls back to the initials too. Decorative: the
 * name is always written next to it.
 */
export function Face({
  name,
  avatar,
  size = 40,
  className = '',
  children,
}: {
  name: string
  avatar?: string | null
  /** The drawn size in px (CSS sets the box; this is the img's intrinsic size). */
  size?: number
  className?: string
  /** The presence dot, when the row shows one. */
  children?: ReactNode
}) {
  const src = safeAvatar(avatar)
  const [failed, setFailed] = useState<string | null>(null)
  const show = src && failed !== src
  return (
    <span className={`chat-av${show ? ' pic' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element -- a cross-origin avatar from the app or the chat Worker; next/image would proxy it
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="chat-av-img"
          onError={() => setFailed(src)}
        />
      ) : (
        initials(name)
      )}
      {children}
    </span>
  )
}
