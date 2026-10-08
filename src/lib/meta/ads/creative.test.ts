import { describe, expect, it } from 'vitest'
import { ctaWords, linkHost, safeThumbnail, summarizeCreative } from './creative'

describe('creative summary', () => {
  it('reads a classic link ad', () => {
    expect(summarizeCreative({
      thumbnail_url: 'https://cdn.example.com/t.jpg',
      object_story_spec: { link_data: { name: 'Headline', message: 'Body text', link: 'https://www.example.com/x?fbclid=1', call_to_action: { type: 'LEARN_MORE' } } },
    })).toEqual({ thumbnailUrl: 'https://cdn.example.com/t.jpg', headline: 'Headline', body: 'Body text', cta: 'Learn more', linkUrl: 'https://www.example.com/x?fbclid=1' })
  })
  it('reads an Advantage+ creative (asset_feed_spec)', () => {
    const s = summarizeCreative({ asset_feed_spec: { titles: [{ text: '' }, { text: 'T2' }], bodies: [{ text: 'B1' }], call_to_action_types: ['SIGN_UP'], link_urls: [{ website_url: 'https://example.com/apply' }] } })
    expect(s).toMatchObject({ headline: 'T2', body: 'B1', cta: 'Sign up', linkUrl: 'https://example.com/apply' })
  })
  it('reads a video ad and survives junk', () => {
    expect(summarizeCreative({ object_story_spec: { video_data: { title: 'V', message: 'M', image_url: 'https://x.test/i.jpg' } } })).toMatchObject({ headline: 'V', body: 'M', thumbnailUrl: 'https://x.test/i.jpg' })
    expect(summarizeCreative(null)).toEqual({ thumbnailUrl: null, headline: null, body: null, cta: null, linkUrl: null })
    expect(summarizeCreative(['x'])).toEqual({ thumbnailUrl: null, headline: null, body: null, cta: null, linkUrl: null })
  })
  it('link host only, never the path or query', () => {
    expect(linkHost('https://www.example.com/landing?utm_source=fb&fbclid=1')).toBe('example.com')
    expect(linkHost('javascript:alert(1)')).toBeNull()
    expect(linkHost('not a url')).toBeNull()
  })
  it('thumbnails: http(s) only', () => {
    expect(safeThumbnail('data:image/png;base64,AAAA')).toBeNull()
    expect(safeThumbnail('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg')
  })
  it('cta words', () => {
    expect(ctaWords('GET_QUOTE')).toBe('Get quote')
    expect(ctaWords(null)).toBeNull()
  })
})
