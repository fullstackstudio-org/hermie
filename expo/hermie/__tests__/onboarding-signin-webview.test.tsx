import { screen } from '@testing-library/react-native'
import { Platform } from 'react-native'

import { NativeSignInWebView, webViewMayCarryHeaders } from '../src/features/onboarding/NativeSignInWebView'
import { renderScreen } from './support/render'

const PROPS = {
  visible: true,
  baseUrl: 'https://hermes.example.com',
  provider: 'self-hosted',
  onCancel: jest.fn(),
  onSuccess: jest.fn()
}

describe('webViewMayCarryHeaders', () => {
  it('refuses Android and allows WKWebView, which drops them at the origin boundary', () => {
    expect(webViewMayCarryHeaders('android')).toBe(false)
    expect(webViewMayCarryHeaders('ios')).toBe(true)
  })
})

describe('the in-app sign-in page', () => {
  const platform = Platform.OS

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: platform, configurable: true })
  })

  const runOn = (os: string) => {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
  }

  it('loads in the app with the gateway headers where they stay on the gateway', () => {
    runOn('ios')
    renderScreen(<NativeSignInWebView {...PROPS} extraHeaders={{ 'CF-Access-Client-Id': 'client-id' }} />)

    expect(screen.getByTestId('sign-in-webview').props.source).toMatchObject({
      headers: { 'CF-Access-Client-Id': 'client-id' }
    })
  })

  it('sends the user to their browser rather than leak the headers to the provider on Android', () => {
    runOn('android')
    renderScreen(<NativeSignInWebView {...PROPS} extraHeaders={{ 'CF-Access-Client-Id': 'client-id' }} />)

    // Android's WebView re-sends `source.headers` across the redirect to the
    // identity provider, so the gateway's access secret would leave its domain.
    expect(screen.queryByTestId('sign-in-webview')).toBeNull()
    expect(screen.getByText(/forward them to your identity provider/)).toBeTruthy()
  })

  it('still loads in the app on Android when there are no headers to protect', () => {
    runOn('android')
    renderScreen(<NativeSignInWebView {...PROPS} extraHeaders={{}} />)

    expect(screen.getByTestId('sign-in-webview')).toBeTruthy()
    expect(screen.getByTestId('sign-in-webview').props.source.headers).toEqual({})
  })
})
