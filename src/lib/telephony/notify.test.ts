import { describe, expect, it } from 'vitest'
import { alertEmailHtml, alertSmsText } from './notify'

describe('telephony alert copy', () => {
  it('the text carries the title, the body and the link', () => {
    const t = alertSmsText({ title: 'Call from an unknown number', body: '•••-•••-1234 called the main line.', link: 'https://www.prodigyflo.ai/call-center?missed=abc' })
    expect(t).toBe('ProdigyFlo: Call from an unknown number. •••-•••-1234 called the main line. https://www.prodigyflo.ai/call-center?missed=abc')
  })
  it('the email escapes what it prints and links the app', () => {
    const html = alertEmailHtml({ title: 'A <b>lead</b> waited', body: 'Nobody called & they left', link: 'https://www.prodigyflo.ai/call-center' })
    expect(html).toContain('A &lt;b&gt;lead&lt;/b&gt; waited')
    expect(html).toContain('Nobody called &amp; they left')
    expect(html).toContain('href="https://www.prodigyflo.ai/call-center"')
    expect(html).not.toContain('<b>lead</b>')
  })
})
