import { describe, expect, it } from 'vitest'

import {
  accessUserScript,
  CF_ACCESS_CLIENT_ID,
  CF_ACCESS_CLIENT_SECRET,
  CF_ACCESS_INCOMPLETE,
  CF_ACCESS_PRESENT,
  describeFrontDoor,
  type FrontDoor,
  frontDoorHeaders,
  frontDoorWithheld,
  isFrontDoorComplete,
  NO_FRONT_DOOR,
  originOf,
  redactHeaders
} from './front-door'

const SECRET = 'cf-secret-value-nobody-may-print'

const ACCESS: FrontDoor = {
  kind: 'cloudflare_access',
  clientId: 'abc123.access',
  clientSecret: SECRET,
  origin: 'https://gateway.example.com'
}

describe('the headers a front door adds', () => {
  it('is Cloudflare’s own pair, spelled the way Cloudflare spells them', () => {
    expect(frontDoorHeaders(ACCESS, 'https://gateway.example.com')).toEqual({
      'CF-Access-Client-Id': 'abc123.access',
      'CF-Access-Client-Secret': SECRET
    })
  })

  it('is nothing at all without a front door', () => {
    expect(frontDoorHeaders(NO_FRONT_DOOR, 'https://gateway.example.com')).toEqual({})
  })

  it('trims the client id, because it is pasted and pastes carry whitespace', () => {
    const headers = frontDoorHeaders({ ...ACCESS, clientId: '  abc123.access\n' }, 'https://gateway.example.com')

    expect(headers[CF_ACCESS_CLIENT_ID]).toBe('abc123.access')
  })

  it('does not trim the secret, because a secret is bytes', () => {
    const headers = frontDoorHeaders({ ...ACCESS, clientSecret: ' padded ' }, 'https://gateway.example.com')

    expect(headers[CF_ACCESS_CLIENT_SECRET]).toBe(' padded ')
  })

  it('sends neither half when only one is filled in', () => {
    expect(frontDoorHeaders({ ...ACCESS, clientSecret: '' }, 'https://gateway.example.com')).toEqual({})
    expect(frontDoorHeaders({ ...ACCESS, clientId: '   ' }, 'https://gateway.example.com')).toEqual({})
    expect(isFrontDoorComplete({ ...ACCESS, clientSecret: '' })).toBe(false)
  })
})

describe('the https-only rule', () => {
  it.each(['http://gateway.example.com', 'ws://gateway.example.com/api/ws', 'gateway.example.com'])(
    'withholds a tenant-wide service token from %s',
    address => {
      expect(frontDoorHeaders(ACCESS, address)).toEqual({})
      expect(frontDoorWithheld(ACCESS, address)).toBe(true)
    }
  )

  it.each(['https://gateway.example.com', 'wss://gateway.example.com/api/ws'])('sends over %s', address => {
    expect(Object.keys(frontDoorHeaders(ACCESS, address))).toHaveLength(2)
    expect(frontDoorWithheld(ACCESS, address)).toBe(false)
  })

  it.each(['wss://', 'https://', 'https://:443/'])('withholds it from %s, which names no host', address => {
    // A secure scheme with nowhere to send the credentials to is not a gateway.
    expect(frontDoorHeaders(ACCESS, address)).toEqual({})
    expect(frontDoorWithheld(ACCESS, address)).toBe(true)
    expect(accessUserScript(ACCESS, address)).toBe('')
  })

  it('has nothing to withhold when no front door is configured', () => {
    expect(frontDoorWithheld(NO_FRONT_DOOR, 'http://gateway.example.com')).toBe(false)
  })
})

describe('what may be said out loud', () => {
  it('reports presence and never a value', () => {
    const described = describeFrontDoor(frontDoorHeaders(ACCESS, 'https://gateway.example.com'))

    expect(described).toBe(CF_ACCESS_PRESENT)
    expect(described).not.toContain(SECRET)
    expect(described).not.toContain('abc123')
  })

  it('finds the headers whatever case they were stored in', () => {
    expect(describeFrontDoor({ 'cf-access-client-id': 'a', 'CF-ACCESS-CLIENT-SECRET': 'b' })).toBe(CF_ACCESS_PRESENT)
  })

  it('says so when only one half made it onto the wire', () => {
    expect(describeFrontDoor({ [CF_ACCESS_CLIENT_ID]: 'a' })).toBe(CF_ACCESS_INCOMPLETE)
    expect(describeFrontDoor({ [CF_ACCESS_CLIENT_SECRET]: 'b' })).toBe(CF_ACCESS_INCOMPLETE)
  })

  it('says nothing when there is no front door, so nothing renders "none"', () => {
    expect(describeFrontDoor({})).toBe('')
    expect(describeFrontDoor({ 'X-Other': 'value' })).toBe('')
  })
})

describe('redaction', () => {
  it('replaces every value, not a list of known names', () => {
    expect(
      redactHeaders({
        [CF_ACCESS_CLIENT_ID]: 'abc123.access',
        [CF_ACCESS_CLIENT_SECRET]: SECRET,
        'X-Proxy-Shared-Secret': 'a secret this package never heard of'
      })
    ).toEqual({
      [CF_ACCESS_CLIENT_ID]: 'present',
      [CF_ACCESS_CLIENT_SECRET]: 'present',
      'X-Proxy-Shared-Secret': 'present'
    })
  })

  it('keeps the names, so a misspelled header is still diagnosable', () => {
    expect(Object.keys(redactHeaders({ 'Cf-Acces-Client-Id': 'x' }))).toEqual(['Cf-Acces-Client-Id'])
  })

  it('leaves an empty value empty rather than claiming one is present', () => {
    expect(redactHeaders({ 'X-Empty': '' })).toEqual({ 'X-Empty': '' })
  })

  it('leaks nothing of the secret at any length', () => {
    const redacted = JSON.stringify(redactHeaders(frontDoorHeaders(ACCESS, 'https://gateway.example.com')))

    expect(redacted).not.toContain(SECRET)
    expect(redacted).not.toContain(SECRET.slice(0, 4))
  })
})

describe('the document-start script', () => {
  const script = accessUserScript(ACCESS, 'https://gateway.example.com')

  it('is built from the values, so the page can actually send them', () => {
    expect(script).toContain(JSON.stringify(SECRET))
    expect(script).toContain(JSON.stringify('abc123.access'))
    expect(script).toContain('CF-Access-Client-Id')
  })

  it('pins itself to the gateway origin, so a token cannot follow a sign-in to the provider', () => {
    expect(script).toContain(JSON.stringify('https://gateway.example.com'))
    expect(script).toContain('window.location.origin === origin')
  })

  it('wraps both of the ways a page makes a request', () => {
    expect(script).toContain('window.fetch =')
    expect(script).toContain('XMLHttpRequest.prototype.open')
    expect(script).toContain('XMLHttpRequest.prototype.send')
  })

  it('embeds every value as a JSON literal, so a pasted secret cannot close the string', () => {
    const hostile = accessUserScript(
      { ...ACCESS, clientSecret: '";window.stolen=1;var x="' },
      'https://gateway.example.com'
    )

    expect(hostile).toContain(JSON.stringify('";window.stolen=1;var x="'))
    expect(hostile).not.toContain('";window.stolen=1;var x="\n')
    // The literal is closed by the escaping, so nothing after it is code.
    expect(hostile).not.toMatch(/var value2 = "";window\.stolen/)
  })

  it('is empty when there is nothing to inject, which the prop accepts as-is', () => {
    expect(accessUserScript(NO_FRONT_DOOR, 'https://gateway.example.com')).toBe('')
    expect(accessUserScript(ACCESS, 'http://gateway.example.com')).toBe('')
    expect(accessUserScript(ACCESS, 'not an address')).toBe('')
  })
})

describe('origins', () => {
  it('drops the path, keeps the port, and lowercases the host', () => {
    expect(originOf('https://Gateway.Example.com:8443/hermes')).toBe('https://gateway.example.com:8443')
  })

  it('answers empty for something that is not an address', () => {
    expect(originOf('gateway.example.com')).toBe('')
    expect(originOf('')).toBe('')
  })
})
