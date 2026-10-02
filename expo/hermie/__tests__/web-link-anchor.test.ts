/**
 * A markdown link, as the browser build renders it.
 *
 * Driven against `../src/platform/link-anchor.web` directly, for the reason
 * `web-text-field.test.ts` gives at length: the shared module a component
 * imports resolves to the NATIVE no-op under Jest, so a test that went through
 * the renderer would prove the opposite of what it claims.
 *
 * What the native half does is pinned where it always was —
 * `chat-ui/markdown-render.test.tsx` presses the link and watches the handler
 * fire — and the scheme policy the two share is pinned here too, because both
 * halves read it and only one of them is reachable from this file.
 */
import { isOpenableLink } from '../src/markdown/context'
import { anchorProps, HAS_ANCHOR_LINKS } from '../src/platform/link-anchor.web'

describe('a markdown link in a browser', () => {
  it('is a real anchor, not a div with a role on it', () => {
    expect(HAS_ANCHOR_LINKS).toBe(true)
    expect(anchorProps('https://example.com/x')).toHaveProperty('href', 'https://example.com/x')
  })

  it('opens an http link in a new tab, with both rel tokens', () => {
    // `noopener` was already there, through `Linking.openURL`. `noreferrer` is
    // the new one: without it the full URL of the transcript being read travels
    // to the destination in the Referer header.
    expect(anchorProps('https://example.com/x')).toEqual({
      href: 'https://example.com/x',
      hrefAttrs: { rel: 'noopener noreferrer', target: '_blank' }
    })
  })

  it('leaves the tab alone for a handler scheme', () => {
    // `target="_blank"` on a mailto: opens a tab for the browser to hand to the
    // mail client, and that tab stays behind empty.
    for (const href of ['mailto:someone@example.com', 'tel:+3112345678']) {
      expect(anchorProps(href)).toEqual({ href, hrefAttrs: { rel: 'noopener noreferrer' } })
    }
  })
})

describe('which links this app is willing to leave through', () => {
  it('opens the three schemes a device can actually handle', () => {
    expect(isOpenableLink('https://example.com')).toBe(true)
    expect(isOpenableLink('HTTP://example.com')).toBe(true)
    expect(isOpenableLink('mailto:someone@example.com')).toBe(true)
    expect(isOpenableLink('tel:+3112345678')).toBe(true)
  })

  it('refuses a path on the gateway machine, which is where an agent writes most of them', () => {
    // The renderer asks this BEFORE it asks for anchor props, so a link like
    // these ships with no href at all: nothing to middle-click, nothing to copy,
    // nothing for the browser to try to navigate to.
    expect(isOpenableLink('/home/you/notes.md')).toBe(false)
    expect(isOpenableLink('file:///var/log/hermes.log')).toBe(false)
    expect(isOpenableLink('javascript:alert(1)')).toBe(false)
  })
})
