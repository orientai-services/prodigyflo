'use client'

import { useEffect, useRef } from 'react'
import { QUICK } from './message-logic'
import type { T } from './strings'

/** A modal sheet (bottom on phones, centered on desktop) that closes on Escape, a backdrop tap or ×. */
function Modal({ label, onClose, children, className = '' }: { label: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const downOnBackdrop = useRef(false)
  // No close() in a cleanup: it fires `close`, which would unmount the sheet on React's dev double-mount.
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`chat-sheet ${className}`}
      aria-label={label}
      onClose={onClose}
      // A backdrop tap closes only when it also started on the backdrop: the finger that ends a long-press
      // lifts over the backdrop, and that click must not close the sheet it just opened.
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === ref.current
      }}
      onClick={(e) => {
        if (e.target === ref.current && downOnBackdrop.current) onClose()
        downOnBackdrop.current = false
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {children}
    </dialog>
  )
}

export type MenuItem = { key: string; icon: string; label: string; danger?: boolean; run: () => void }

/**
 * The message action sheet (long-press on touch, right-click or ⋯ on desktop):
 * the quick reactions, "More reactions", then only what this person may do.
 */
export function MessageMenu({ t, who, items, onReact, onMore, onClose }: { t: T; who: string; items: MenuItem[]; onReact: (e: string) => void; onMore: (el: HTMLElement) => void; onClose: () => void }) {
  return (
    <Modal label={t.actions} onClose={onClose}>
      <div className="chat-sheet-in">
        <header>
          <div>
            <small className="chat-sheet-k">{who}</small>
            <h2>{t.actions}</h2>
          </div>
          <button type="button" className="chat-icon" onClick={onClose} aria-label={t.close}>×</button>
        </header>
        <div className="chat-qrx">
          {QUICK.map((e) => (
            <button key={e} type="button" onClick={() => onReact(e)} aria-label={`${t.react} ${e}`}>{e}</button>
          ))}
        </div>
        <div className="chat-alist">
          <button type="button" className="chat-ai" onClick={(e) => onMore(e.currentTarget)}>
            <span className="ic" aria-hidden="true">😀</span>
            {t.moreReact}
          </button>
          {items.map((it) => (
            <button key={it.key} type="button" className={`chat-ai${it.danger ? ' red' : ''}`} onClick={it.run}>
              <span className="ic" aria-hidden="true">{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/** "Delete this message?" with the plain consequence and a red yes. */
export function ConfirmBox({ title, body, yes, no, onYes, onClose }: { title: string; body: string; yes: string; no: string; onYes: () => void; onClose: () => void }) {
  return (
    <Modal label={title} onClose={onClose} className="chat-confirm">
      <div className="chat-sheet-in">
        <h2>{title}</h2>
        <p className="chat-confirm-p">{body}</p>
        <div className="chat-sheet-foot">
          <button type="button" className="chat-btn ghost" onClick={onClose} autoFocus>{no}</button>
          <button type="button" className="chat-btn danger" onClick={onYes}>{yes}</button>
        </div>
      </div>
    </Modal>
  )
}

/** The photo viewer: the image fit to the screen, "Open" in a new tab, Close. */
export function Lightbox({ url, name, t, onClose }: { url: string; name: string; t: T; onClose: () => void }) {
  return (
    <Modal label={name || t.photo} onClose={onClose} className="chat-lb">
      {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from the chat Worker; next/image can't fetch it */}
      <img src={url} alt={name || t.photo} />
      <div className="chat-lb-row">
        <a className="chat-btn ghost" href={url} target="_blank" rel="noopener noreferrer">{t.openFile}</a>
        <button type="button" className="chat-btn" onClick={onClose} autoFocus>{t.close}</button>
      </div>
    </Modal>
  )
}
