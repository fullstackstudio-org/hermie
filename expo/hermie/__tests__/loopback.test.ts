import { REDIRECT_URI } from '@hermie/gateway-client'

import { inspectSignInNavigation } from '../src/features/onboarding/loopback'

const STATE = 'state-from-this-attempt'

describe('inspectSignInNavigation', () => {
  it('lets the gateway and the identity provider navigate freely', () => {
    expect(inspectSignInNavigation('https://hermes.example.com/auth/native/authorize?x=1', STATE)).toEqual({
      kind: 'continue'
    })
    expect(inspectSignInNavigation('https://idp.example.com/login', STATE)).toEqual({ kind: 'continue' })
  })

  it('takes the code off the loopback redirect instead of loading it', () => {
    const url = `${REDIRECT_URI}?code=abc123&state=${STATE}`

    expect(inspectSignInNavigation(url, STATE)).toEqual({ kind: 'code', code: 'abc123' })
  })

  it('also intercepts the IPv6 loopback literal', () => {
    expect(inspectSignInNavigation(`http://[::1]:38007/callback?code=abc&state=${STATE}`, STATE)).toEqual({
      kind: 'code',
      code: 'abc'
    })
  })

  it('drops a code whose state belongs to another attempt', () => {
    const verdict = inspectSignInNavigation(`${REDIRECT_URI}?code=abc123&state=someone-elses`, STATE)

    expect(verdict.kind).toBe('failed')
    expect(verdict).not.toHaveProperty('code')
  })

  it('drops a code when this attempt never generated a state', () => {
    expect(inspectSignInNavigation(`${REDIRECT_URI}?code=abc123&state=`, '').kind).toBe('failed')
  })

  it('reports the error the gateway redirected with', () => {
    const verdict = inspectSignInNavigation(
      `${REDIRECT_URI}?error=access_denied&error_description=Not%20a%20member`,
      STATE
    )

    expect(verdict.kind).toBe('failed')
    expect(verdict).toMatchObject({ message: expect.stringContaining('Not a member') })
  })

  it('reports a redirect that carried neither a code nor an error', () => {
    expect(inspectSignInNavigation(`${REDIRECT_URI}?something=else`, STATE).kind).toBe('failed')
  })

  /**
   * The web view reads an address the way the URL parser does, so every one of
   * these reaches this device — where, on Android, any app can be listening on
   * the port for the code in the query. `isLoopbackRedirect` refuses each of
   * them as "not our callback", and that used to mean `continue`: the code was
   * really sent. Not one of them may load.
   */
  it('never loads any other address on this device', () => {
    for (const url of [
      `http://127.0.0.1:000038007/callback?code=abc&state=${STATE}`,
      `http://127.0.0.1:0038007/callback?code=abc&state=${STATE}`,
      `http://127.1:38007/callback?code=abc&state=${STATE}`,
      `http://0x7f.0.0.1:38007/callback?code=abc&state=${STATE}`,
      `http://2130706433:38007/callback?code=abc&state=${STATE}`,
      `http://127.0.0.2:38007/callback?code=abc&state=${STATE}`,
      `http://localhost:38007/callback?code=abc&state=${STATE}`,
      `http://sub.localhost:38007/callback?code=abc&state=${STATE}`,
      `http://[0:0:0:0:0:0:0:1]:38007/callback?code=abc&state=${STATE}`,
      `http://[::ffff:127.0.0.1]:38007/callback?code=abc&state=${STATE}`,
      `http://0.0.0.0:38007/callback?code=abc&state=${STATE}`,
      `HTTP://127.0.0.1:38007/callback?code=abc&state=${STATE}`,
      `https://127.0.0.1:38007/callback?code=abc&state=${STATE}`,
      `http://idp.example@127.0.0.1:38007/callback?code=abc&state=${STATE}`
    ]) {
      const verdict = inspectSignInNavigation(url, STATE, 'https://hermes.example.com')

      expect([url, verdict.kind]).toEqual([url, 'failed'])
      expect(verdict).not.toHaveProperty('code')
    }
  })

  it('still lets a gateway that runs on this machine serve its own pages', () => {
    expect(
      inspectSignInNavigation('http://localhost:9119/auth/native/authorize?x=1', STATE, 'http://localhost:9119/').kind
    ).toBe('continue')
    // Its origin, and nothing else on loopback.
    expect(inspectSignInNavigation('http://localhost:9120/x', STATE, 'http://localhost:9119').kind).toBe('failed')
    expect(inspectSignInNavigation('http://127.0.0.1:9119/x', STATE, 'http://localhost:9119').kind).toBe('failed')
  })

  it('leaves an address that only mentions loopback alone', () => {
    expect(inspectSignInNavigation('http://127.0.0.1.example.com/login', STATE).kind).toBe('continue')
    expect(inspectSignInNavigation('https://idp.example.com/login?next=http://127.0.0.1:38007/', STATE).kind).toBe(
      'continue'
    )
  })
})
