/**
 * Which host Settings and the wizard call "the gateway", in a browser.
 *
 * `config.baseUrl` is `window.location.origin` on the web, because Hermie Web
 * proxies the gateway onto its own origin. That is right for the code that
 * dials it and wrong as an answer to "which gateway am I on": two screens in
 * one flow named two different things the gateway, and the one that was right
 * — the sign-in step, saying `talking to 127.0.0.1:9119` — was the one nobody
 * had doubted.
 *
 * Driven against `GatewayAddressRow.web` directly, as every other web seam
 * test in this directory is: the shared module resolves to the native row under
 * Jest, and that row is the thing this replaces.
 */
import { render, screen, waitFor } from '@testing-library/react-native'

import { GatewayAddressRow } from '../src/gateway/GatewayAddressRow.web'
import { loadHermieWebConfig } from '../src/gateway/web-config'
import { ThemeProvider } from '../src/ui/theme'

jest.mock('../src/gateway/web-config', () => ({ loadHermieWebConfig: jest.fn() }))

const config = jest.mocked(loadHermieWebConfig)

const renderRow = (baseUrl: string | null) =>
  render(
    <ThemeProvider>
      <GatewayAddressRow baseUrl={baseUrl} />
    </ThemeProvider>
  )

beforeEach(() => config.mockReset())

describe('the gateway address, in a browser', () => {
  it('names the gateway Hermie Web proxies to, and says the proxy is there', async () => {
    config.mockResolvedValue({ gatewayHost: '127.0.0.1:9119', loginReturn: '/', version: '0.1.0' })

    renderRow('http://127.0.0.1:9120')

    // The gateway's own host, not this page's origin…
    await waitFor(() => expect(screen.getByText('127.0.0.1:9119')).toBeTruthy())
    // …with the reason the address bar says something else, in the row.
    expect(screen.getByText('via Hermie Web')).toBeTruthy()
    expect(screen.queryByText('http://127.0.0.1:9120')).toBeNull()
  })

  it('falls back to the origin when the server does not answer', async () => {
    // Best-effort: a missing config costs the qualification, never a connection.
    config.mockResolvedValue(null)

    renderRow('http://127.0.0.1:9120')

    await waitFor(() => expect(screen.getByText('http://127.0.0.1:9120')).toBeTruthy())
    expect(screen.queryByText('via Hermie Web')).toBeNull()
  })

  it('says so rather than showing an empty row before there is an address at all', async () => {
    config.mockResolvedValue(null)

    renderRow(null)

    await waitFor(() => expect(screen.getByText('Unknown')).toBeTruthy())
  })
})
