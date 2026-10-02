import { describe, expect, it } from 'vitest'

import { classifyHost, hostOfAddress, isExposedCleartext } from './host-privacy'

const privacyOf = (address: string) => classifyHost(address).privacy

describe('hostOfAddress', () => {
  it('takes the host out of a URL, an authority or a bare name', () => {
    expect(hostOfAddress('https://example.test/hermes?x=1')).toBe('example.test')
    expect(hostOfAddress('example.test:9119')).toBe('example.test')
    expect(hostOfAddress('example.test')).toBe('example.test')
  })

  it('drops a trailing root dot and lowercases', () => {
    expect(hostOfAddress('HTTP://Hermes.Tail1234.TS.NET./')).toBe('hermes.tail1234.ts.net')
  })

  it('unwraps a bracketed IPv6 literal with a port', () => {
    expect(hostOfAddress('http://[fd7a:115c:a1e0::1]:9119/api')).toBe('fd7a:115c:a1e0::1')
  })

  it('keeps an unbracketed IPv6 literal whole rather than reading its last group as a port', () => {
    expect(hostOfAddress('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1')
  })

  it('drops credentials', () => {
    expect(hostOfAddress('http://user:pass@192.168.1.4:9119')).toBe('192.168.1.4')
  })

  it('reads credentials only inside the authority, never in a path, query or fragment', () => {
    // An `@` after the first `/`, `?` or `#` is part of the path, query or
    // fragment. Cutting at it would let any public host name itself private.
    expect(hostOfAddress('http://example.com/path@foo')).toBe('example.com')
    expect(hostOfAddress('http://public.example/@10.0.0.1')).toBe('public.example')
    expect(hostOfAddress('http://public.example?next=@127.0.0.1')).toBe('public.example')
    expect(hostOfAddress('http://example.com#frag@x')).toBe('example.com')
    expect(hostOfAddress('http://user@host@example.com/x@y')).toBe('example.com')
  })
})

describe('classifyHost: IPv4', () => {
  it('reads loopback', () => {
    expect(privacyOf('http://127.0.0.1:9119')).toBe('loopback')
    expect(privacyOf('127.13.2.9')).toBe('loopback')
  })

  it('reads the RFC 1918 ranges', () => {
    expect(privacyOf('10.0.0.1')).toBe('private')
    expect(privacyOf('192.168.2.250:9119')).toBe('private')
    expect(privacyOf('172.16.0.1')).toBe('private')
    expect(privacyOf('172.31.255.254')).toBe('private')
  })

  it('does not stretch 172.16/12 past its edges', () => {
    expect(privacyOf('172.15.0.1')).toBe('public')
    expect(privacyOf('172.32.0.1')).toBe('public')
  })

  it('reads link-local and the CGNAT block Tailscale allots from', () => {
    expect(privacyOf('169.254.1.1')).toBe('link_local')
    expect(privacyOf('100.101.102.103')).toBe('cgnat')
    expect(privacyOf('100.64.0.0')).toBe('cgnat')
    expect(privacyOf('100.127.255.255')).toBe('cgnat')
  })

  it('does not stretch 100.64/10 past its edges', () => {
    expect(privacyOf('100.63.0.1')).toBe('public')
    expect(privacyOf('100.128.0.1')).toBe('public')
  })

  it('reads a routable address as public', () => {
    expect(privacyOf('8.8.8.8')).toBe('public')
  })

  it('treats an out-of-range dotted quad as a name, not an address', () => {
    // `999.1.1.1` is not an IPv4 literal; it is a name with dots in it.
    expect(privacyOf('999.1.1.1')).toBe('public')
  })
})

describe('classifyHost: IPv6', () => {
  it('reads loopback', () => {
    expect(privacyOf('http://[::1]:9119')).toBe('loopback')
    expect(privacyOf('0:0:0:0:0:0:0:1')).toBe('loopback')
  })

  it("reads Tailscale's own /48 before the wider ULA range", () => {
    expect(privacyOf('fd7a:115c:a1e0::1')).toBe('tailnet')
    expect(privacyOf('FD7A:115C:A1E0:AB12:4843:CD96:6265:1')).toBe('tailnet')
  })

  it('reads a unique local address', () => {
    expect(privacyOf('fd12:3456:789a::1')).toBe('private')
    expect(privacyOf('fc00::1')).toBe('private')
  })

  it('reads link-local across the whole fe80::/10 block', () => {
    expect(privacyOf('fe80::1')).toBe('link_local')
    expect(privacyOf('febf::1')).toBe('link_local')
  })

  it('reads a global unicast address as public', () => {
    expect(privacyOf('2606:4700:4700::1111')).toBe('public')
    expect(privacyOf('[2606:4700:4700::1111]:443')).toBe('public')
  })

  it('classifies an IPv4-mapped address by the address it maps', () => {
    expect(privacyOf('::ffff:192.168.1.10')).toBe('private')
    expect(privacyOf('::ffff:8.8.8.8')).toBe('public')
  })

  it('does not read a malformed literal as private', () => {
    expect(privacyOf('fd7a::115c::a1e0')).toBe('public')
    expect(privacyOf('fdzz::1')).toBe('public')
  })
})

describe('classifyHost: names', () => {
  it('reads localhost', () => {
    expect(privacyOf('http://localhost:9119')).toBe('loopback')
    expect(privacyOf('gateway.localhost')).toBe('loopback')
  })

  it('reads a MagicDNS name, whatever its case', () => {
    expect(privacyOf('hermes.tail9f3c.ts.net')).toBe('tailnet')
    expect(privacyOf('https://Hermes.Tail9F3C.TS.NET/')).toBe('tailnet')
  })

  it('reads a .local name and an unqualified one', () => {
    expect(privacyOf('studio.local')).toBe('local_name')
    expect(privacyOf('hermes')).toBe('local_name')
    expect(privacyOf('http://hermes:9119')).toBe('local_name')
  })

  it('reads a .internal name, which the public root will never answer for', () => {
    expect(privacyOf('hermes.lab.internal')).toBe('local_name')
    expect(privacyOf('http://Hermes.Lab.Internal:9119/')).toBe('local_name')
    // The label alone, with nothing in front of it.
    expect(privacyOf('internal')).toBe('local_name')
  })

  it('reads an ordinary domain as public, Headscale base domain included', () => {
    expect(privacyOf('hermes.example.com')).toBe('public')
    // A Headscale base domain is a name of the operator's choosing, so it is
    // indistinguishable from any other domain and is treated as one — unless
    // the operator chose one under `.internal`, which the test above covers.
    expect(privacyOf('hermes.tailnet.example.org')).toBe('public')
    // Not a suffix match on the letters: `.internal` has to be the whole label.
    expect(privacyOf('hermes.notinternal')).toBe('public')
  })

  it('cannot be talked into a calmer verdict by an `@` in the path', () => {
    expect(classifyHost('http://public.example/@10.0.0.1')).toEqual({
      host: 'public.example',
      privacy: 'public',
      isPrivate: false
    })
    expect(privacyOf('http://public.example/x@127.0.0.1:9119')).toBe('public')
    expect(privacyOf('http://public.example/@hermes.ts.net')).toBe('public')
  })

  it('answers something for an empty host rather than throwing', () => {
    expect(classifyHost('')).toEqual({ host: '', privacy: 'public', isPrivate: false })
  })
})

describe('isExposedCleartext', () => {
  it('is true only for http to a host anyone can be on the path to', () => {
    expect(isExposedCleartext('http://hermes.example.com')).toBe(true)
    expect(isExposedCleartext('HTTP://hermes.example.com')).toBe(true)
    expect(isExposedCleartext('https://hermes.example.com')).toBe(false)
    expect(isExposedCleartext('http://100.101.102.103:9119')).toBe(false)
    expect(isExposedCleartext('http://hermes.tail9f3c.ts.net')).toBe(false)
    expect(isExposedCleartext('http://hermes.lab.internal')).toBe(false)
    expect(isExposedCleartext('http://127.0.0.1:9119')).toBe(false)
  })

  it('still warns about a public host whose path names a private one', () => {
    expect(isExposedCleartext('http://public.example/@10.0.0.1')).toBe(true)
  })
})
