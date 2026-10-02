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
})
