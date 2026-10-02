/**
 * What "Sign out" actually ends.
 *
 * On the phones and the Mac the credential is a keychain item this app owns, so
 * clearing the secret store is the whole of a sign-out. In a browser it is not:
 * the session is the gateway's own `HttpOnly` cookie — the entire point of the
 * cookie flow, because a page has nowhere safe to keep a token — and a page
 * cannot delete it.
 *
 * So the browser build cleared a secret store that in that mode was already
 * empty. The app returned to the wizard, the session stayed alive on the
 * gateway, and the very next reload signed straight back in. That is how this
 * was found: signing out during a QA pass and then reloading the page.
 */
import { endGatewaySession } from '../src/gateway/client'

// Named `mockLogout` because Jest hoists the factory above every other
// binding in the file and only lets a `mock`-prefixed one through.
const mockLogout = jest.fn<Promise<void>, [string]>()

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  CookieSessionCredentials: class {
    private readonly baseUrl: string

    constructor(options: { baseUrl: string }) {
      this.baseUrl = options.baseUrl
    }

    signOut() {
      return mockLogout(this.baseUrl)
    }
  }
}))

const logout = mockLogout

beforeEach(() => {
  logout.mockReset()
  logout.mockResolvedValue(undefined)
})

describe('ending the session the server holds', () => {
  it('asks the gateway to drop the cookie', async () => {
    await endGatewaySession({ baseUrl: 'https://hermes.example.com', authMode: 'cookie' })

    expect(logout).toHaveBeenCalledWith('https://hermes.example.com')
  })

  it('does nothing in the modes where the credential was local', async () => {
    // There is no server-side session to end, and the thing that authenticated
    // has just been deleted from the place it lived.
    await endGatewaySession({ baseUrl: 'https://hermes.example.com', authMode: 'native_pkce' })
    await endGatewaySession({ baseUrl: 'https://hermes.example.com', authMode: 'session_token' })
    await endGatewaySession(null)

    expect(logout).not.toHaveBeenCalled()
  })

  it('still looks like a sign-out when the gateway never hears about it', async () => {
    // This runs BEFORE the connection is torn down and the local state
    // cleared, so a rejection here would be a sign-out that also failed to
    // sign out locally — strictly worse than the defect it is fixing.
    logout.mockRejectedValue(new Error('offline'))

    await expect(
      endGatewaySession({ baseUrl: 'https://hermes.example.com', authMode: 'cookie' })
    ).resolves.toBeUndefined()
  })
})
