/**
 * HERM-120: Settings → Account shows the signed-in person's picture and
 * email, both read off `config` — the same `/api/auth/me` snapshot that
 * already fed `userDisplayName` — rather than a second fetch.
 */
import { screen, waitFor } from '@testing-library/react-native'

import { SettingsScreen } from '../src/features/settings'
import { renderScreen } from './support/render'

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: () => () => undefined
}))

let mockGatewayConfig: Record<string, unknown> | null = null
let mockFetchAuthenticatedPicture: jest.Mock

jest.mock('../src/gateway', () => ({
  useGateway: () => ({
    changeGateway: jest.fn(),
    config: mockGatewayConfig,
    forgetGateway: jest.fn(),
    gatewayId: 'gw-a',
    http: { fetchAuthenticatedPicture: mockFetchAuthenticatedPicture },
    signOut: jest.fn()
  })
}))

jest.mock('../src/gateway/web-config', () => ({ WEB_GATEWAY_BASE_URL: null }))

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => ({ push: null }) }))

// `Avatar` is deliberately hidden from accessibility (decorative; the name
// beside it carries the attribution), and RNTL's queries skip anything hidden
// that way unless told not to.
const HIDDEN = { includeHiddenElements: true } as const

async function openAccount() {
  renderScreen(<SettingsScreen initialRoute="Account" />)
  await waitFor(() => expect(screen.getByTestId('settings-page-Account')).toBeTruthy())
}

describe('Settings → Account, the picture and the email (HERM-120)', () => {
  beforeEach(() => {
    mockFetchAuthenticatedPicture = jest.fn(async () => ({
      kind: 'ready',
      dataUri: 'data:image/png;base64,AAAA'
    }))
  })

  it('shows the email row when /api/auth/me sent one', async () => {
    mockGatewayConfig = {
      authMode: 'native_pkce',
      baseUrl: 'https://gateway.example.com',
      userDisplayName: 'Sam',
      userEmail: 'sam@example.test',
      version: '1'
    }

    await openAccount()

    expect(screen.getByText('sam@example.test')).toBeTruthy()
  })

  it('draws no email row at all when email is empty', async () => {
    mockGatewayConfig = {
      authMode: 'native_pkce',
      baseUrl: 'https://gateway.example.com',
      userDisplayName: 'Sam',
      userEmail: '',
      version: '1'
    }

    await openAccount()

    expect(screen.queryByText('sam@example.test')).toBeNull()
  })

  it('fetches and draws the picture when userPictureUrl is set, joined onto the gateway base with auth', async () => {
    mockGatewayConfig = {
      authMode: 'native_pkce',
      baseUrl: 'https://gateway.example.com',
      userDisplayName: 'Sam',
      userPictureUrl: '/api/auth/picture?id=self-hosted%3Asam-sub',
      version: '1'
    }

    await openAccount()

    await waitFor(() =>
      expect(mockFetchAuthenticatedPicture).toHaveBeenCalledWith('/api/auth/picture?id=self-hosted%3Asam-sub')
    )

    await waitFor(() =>
      expect(screen.getByTestId('settings-account-avatar', HIDDEN).props.source).toMatchObject({
        uri: 'data:image/png;base64,AAAA'
      })
    )
  })

  it('draws the initial, and asks the network for nothing, without a userPictureUrl', async () => {
    mockGatewayConfig = {
      authMode: 'native_pkce',
      baseUrl: 'https://gateway.example.com',
      userDisplayName: 'Sam',
      version: '1'
    }

    await openAccount()

    expect(mockFetchAuthenticatedPicture).not.toHaveBeenCalled()
    expect(screen.getByTestId('settings-account-avatar', HIDDEN).props.source).toBeUndefined()
  })
})
