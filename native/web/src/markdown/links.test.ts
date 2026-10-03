import { describe, expect, it } from 'vitest'

import { isOpenableLink, openableHref, resolveImage } from './links'

const GATEWAY = 'https://gw.example.test'

describe('which links may be anchors', () => {
  it('opens http, https and mailto, in any case', () => {
    expect(isOpenableLink('https://example.com')).toBe(true)
    expect(isOpenableLink('HTTP://example.com')).toBe(true)
    expect(isOpenableLink('mailto:someone@example.com')).toBe(true)
    expect(isOpenableLink('MAILTO:someone@example.com')).toBe(true)
  })

  it('refuses everything else, and anything that only looks like one of those', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html;base64,AAAA',
      'vbscript:msgbox(1)',
      'file:///var/log/hermes.log',
      'tel:+3112345678',
      'sms:+3112345678',
      'blob:https://example.com/id',
      '/home/you/notes.md',
      '//example.com/path',
      'example.com',
      'httpx://example.com',
      'https//example.com',
      ' https://example.com',
      ''
    ]) {
      expect(isOpenableLink(href), JSON.stringify(href)).toBe(false)
      expect(openableHref(href), JSON.stringify(href)).toBeNull()
    }
  })

  it('writes an address the way the URL parser does, and refuses one it cannot parse', () => {
    expect(openableHref('https://example.com')).toBe('https://example.com/')
    expect(openableHref('https://example.com/a b?q=1#x')).toBe('https://example.com/a%20b?q=1#x')
    expect(openableHref('mailto:someone@example.com')).toBe('mailto:someone@example.com')
    expect(openableHref('https://')).toBeNull()
    expect(openableHref('http://exa mple.com')).toBeNull()
  })
})

describe('how an image is drawn', () => {
  it('loads a path from the gateway, which is what the gateway writes into replies', () => {
    expect(resolveImage('/api/files/1.png', GATEWAY)).toEqual({ kind: 'image', src: `${GATEWAY}/api/files/1.png` })
    expect(resolveImage('/api/files/1.png', `${GATEWAY}/`)).toEqual({
      kind: 'image',
      src: `${GATEWAY}/api/files/1.png`
    })
    expect(resolveImage('api/files/1.png', GATEWAY)).toEqual({ kind: 'image', src: `${GATEWAY}/api/files/1.png` })
  })

  it('keeps a path under the prefix a gateway is published at', () => {
    expect(resolveImage('/api/files/1.png', `${GATEWAY}/hermes`)).toEqual({
      kind: 'image',
      src: `${GATEWAY}/hermes/api/files/1.png`
    })
  })

  it('loads an absolute address on the gateway origin', () => {
    expect(resolveImage(`${GATEWAY}/api/files/1.png`, GATEWAY)).toEqual({
      kind: 'image',
      src: `${GATEWAY}/api/files/1.png`
    })
    expect(resolveImage('//gw.example.test/a.png', GATEWAY)).toEqual({ kind: 'image', src: `${GATEWAY}/a.png` })
  })

  it('shows another origin as a link and requests nothing', () => {
    expect(resolveImage('https://cdn.example.net/a.png', GATEWAY)).toEqual({
      kind: 'link',
      href: 'https://cdn.example.net/a.png'
    })
    expect(resolveImage('//cdn.example.net/a.png', GATEWAY)).toEqual({
      kind: 'link',
      href: 'https://cdn.example.net/a.png'
    })
    // The same host on another port, another scheme or a look-alike host is another origin.
    expect(resolveImage('https://gw.example.test:8443/a.png', GATEWAY).kind).toBe('link')
    expect(resolveImage('http://gw.example.test/a.png', GATEWAY).kind).toBe('link')
    expect(resolveImage('https://gw.example.test.evil.example/a.png', GATEWAY).kind).toBe('link')
    expect(resolveImage('https://gw.example.test@evil.example/a.png', GATEWAY).kind).toBe('link')
    expect(resolveImage('https://user:secret@gw.example.test/a.png', GATEWAY).kind).toBe('link')
  })

  it('does not let a path leave the gateway', () => {
    for (const source of ['/\\evil.example/a.png', '\\\\evil.example\\a.png', '/../../evil.example/a.png']) {
      const drawn = resolveImage(source, GATEWAY)

      expect(drawn.kind === 'image' ? new URL(drawn.src).origin : GATEWAY, source).toBe(GATEWAY)
    }
  })

  it('shows anything that is not http(s) as text', () => {
    for (const source of [
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'blob:https://gw.example.test/id',
      'ftp://example.com/a.png',
      '',
      '   '
    ]) {
      expect(resolveImage(source, GATEWAY), source).toEqual({ kind: 'text' })
    }
  })

  it('has nothing to resolve a path against without a gateway, and treats an address as remote', () => {
    expect(resolveImage('/api/files/1.png')).toEqual({ kind: 'text' })
    expect(resolveImage('/api/files/1.png', 'not a url')).toEqual({ kind: 'text' })
    expect(resolveImage('/api/files/1.png', 'ftp://gw.example.test')).toEqual({ kind: 'text' })
    expect(resolveImage('https://cdn.example.net/a.png')).toEqual({
      kind: 'link',
      href: 'https://cdn.example.net/a.png'
    })
  })
})
