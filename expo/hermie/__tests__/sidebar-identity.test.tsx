/**
 * Who is signed in, at the bottom of the chat list
 * ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 *
 * Three things are worth holding down here, and only one of them is "it
 * renders". The name comes off the gateway rather than out of a preference
 * file; a gateway with no accounts names nobody and the row stays away; and on
 * the web the Hermie Web line lives in this same block rather than in a second
 * one beside it.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { SidebarIdentity, serviceLine } from '../src/features/bots/SidebarIdentity'
import { loadHermieWebConfig } from '../src/gateway/web-config'
import { useDeviceContextStore } from '../src/store/device-context'
import { renderScreen } from './support/render'

jest.mock('../src/gateway/web-config', () => ({
  ...jest.requireActual('../src/gateway/web-config'),
  loadHermieWebConfig: jest.fn()
}))

const config = jest.mocked(loadHermieWebConfig)

const SERVED = {
  gatewayHost: '127.0.0.1:9119',
  gatewayOrigin: 'http://127.0.0.1:9119',
  loginReturn: '/',
  version: '0.1.2',
  setupRequired: false,
  authRequired: true,
  authKinds: ['cookie'],
  providers: [],
  service: { login: true, push: true, cache: true }
}

beforeEach(() => {
  config.mockReset()
  config.mockResolvedValue(null)
  useDeviceContextStore.getState().reset()
})

describe('the identity row', () => {
  it('names whoever the gateway signed in, and offers a way out', async () => {
    useDeviceContextStore.getState().setIdentity({
      baseUrl: 'https://gateway.example',
      gated: true,
      userId: 'self-hosted:0ac1',
      displayName: 'Ada Lovelace',
      email: 'ada@example.invalid'
    })

    const onSignOut = jest.fn()
    renderScreen(<SidebarIdentity onSignOut={onSignOut} />)

    await waitFor(() => expect(screen.getByTestId('sidebar-identity-name')).toBeTruthy())
    expect(screen.getByTestId('sidebar-identity-name').props.children).toBe('Ada Lovelace')

    fireEvent.press(screen.getByTestId('sidebar-sign-out'))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('falls back down the same ladder the context section uses', async () => {
    // Measured on a real OIDC gateway: `/api/auth/me` answered with a subject
    // and nothing else. The address's local part first, then the subject with
    // its provider prefix taken off — never a guess at a person's name.
    useDeviceContextStore.getState().setIdentity({
      baseUrl: 'https://gateway.example',
      gated: true,
      userId: 'self-hosted:0ac1',
      displayName: '',
      email: 'ada@example.invalid'
    })

    renderScreen(<SidebarIdentity />)

    await waitFor(() => expect(screen.getByTestId('sidebar-identity-name').props.children).toBe('ada'))
  })

  it('draws no way out when the screen has none to offer', async () => {
    useDeviceContextStore.getState().setIdentity({
      baseUrl: 'https://gateway.example',
      gated: true,
      userId: 'self-hosted:0ac1',
      displayName: 'Ada Lovelace',
      email: ''
    })

    renderScreen(<SidebarIdentity />)

    await waitFor(() => expect(screen.getByTestId('sidebar-identity-name')).toBeTruthy())
    // A button that does nothing is worse than a name with no button under it.
    expect(screen.queryByTestId('sidebar-sign-out')).toBeNull()
  })

  it('says nothing at all on a gateway with no accounts', async () => {
    // `readIdentity` answers `owner` there, which is a placeholder rather than
    // a person — introducing the reader to themselves as "owner" is worse than
    // saying nothing.
    useDeviceContextStore.getState().setIdentity({
      baseUrl: 'http://127.0.0.1:9119',
      gated: false,
      userId: 'owner',
      displayName: '',
      email: ''
    })

    renderScreen(<SidebarIdentity onSignOut={jest.fn()} />)

    await waitFor(() => expect(config).toHaveBeenCalled())
    expect(screen.queryByTestId('sidebar-identity')).toBeNull()
  })
})

describe('the Hermie Web line', () => {
  it('reads the version and the gateway it proxies, in one string', () => {
    expect(serviceLine(SERVED)).toBe('Hermie Web 0.1.2 · 127.0.0.1:9119')
    // Off the web there is no such server, and `loadHermieWebConfig` says so.
    expect(serviceLine(null)).toBe('')
    expect(serviceLine({ ...SERVED, version: '' })).toBe('127.0.0.1:9119')
  })

  it('sits in the SAME block as the name rather than a second one beside it', async () => {
    config.mockResolvedValue(SERVED)
    useDeviceContextStore.getState().setIdentity({
      baseUrl: 'http://127.0.0.1:9120',
      gated: true,
      userId: 'self-hosted:0ac1',
      displayName: 'Ada Lovelace',
      email: ''
    })

    renderScreen(<SidebarIdentity onSignOut={jest.fn()} />)

    await waitFor(() => expect(screen.getByTestId('sidebar-identity-service')).toBeTruthy())
    expect(screen.getAllByTestId('sidebar-identity')).toHaveLength(1)
    expect(screen.getByTestId('sidebar-identity-service').props.children).toBe('Hermie Web 0.1.2 · 127.0.0.1:9119')
  })

  it('draws on its own where the gateway has named nobody', async () => {
    config.mockResolvedValue(SERVED)

    renderScreen(<SidebarIdentity />)

    // Which Hermie Web am I on is answerable even before anyone signs in, and
    // it is the one question a signed-out tab most wants answered.
    await waitFor(() => expect(screen.getByTestId('sidebar-identity-service')).toBeTruthy())
    expect(screen.queryByTestId('sidebar-identity-name')).toBeNull()
  })
})
