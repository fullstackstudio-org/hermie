/**
 * What the address step says and offers when a probe fails.
 *
 * The classifier's own table is in `packages/gateway-client`; this is the other
 * half — that the sentence the reader sees is composed from those codes rather
 * than from the gateway client's wording, and that each action arrives as a
 * button that does the one thing it says.
 */
import { GatewayError, type ProbeResult, type ResolvedAddress } from '@hermie/gateway-client'
import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { useState } from 'react'

import { emptyDraft, type OnboardingDraft } from '../src/features/onboarding'
import { GatewayAddressStep } from '../src/features/onboarding/steps/GatewayAddressStep'
import { deferred, renderScreen } from './support/render'

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  resolveGatewayAddress: jest.fn()
}))

// `mock`-prefixed so the factory below may close over it: jest hoists the
// factory above every other statement in this file.
let mockNetworkKind = 'wifi'

jest.mock('../src/platform/net-info', () => ({
  networkWatcher: {
    subscribe: () => () => {},
    kind: async () => mockNetworkKind
  }
}))

const { resolveGatewayAddress } = require('@hermie/gateway-client') as { resolveGatewayAddress: jest.Mock }

const PROBE: ProbeResult = {
  version: '2026.9.14',
  authRequired: false,
  authFlows: [],
  providers: [],
  supportsNativePkce: false
}

const at = (baseUrl: string): ResolvedAddress => ({ ...PROBE, baseUrl, foundOverHttp: false })

let latest: OnboardingDraft = emptyDraft()

function Harness() {
  const [draft, setDraft] = useState<OnboardingDraft>(emptyDraft())
  latest = draft

  return (
    <GatewayAddressStep
      draft={draft}
      update={patch => setDraft(current => ({ ...current, ...patch }))}
      debounceMs={0}
    />
  )
}

const type = (value: string) => fireEvent.changeText(screen.getByTestId('gateway-address'), value)

/*
  Regexes rather than strings, and it is not a style choice: RNTL's
  `toHaveTextContent` matches a STRING exactly, so every assertion about one
  sentence inside a message would have to spell out the whole message.
*/
const PRIVATE_NETWORK = /only answers on a private network/
const LANDING_PAGE = /This looks like a web page, not a gateway\./
const NOT_A_GATEWAY = /not like a Hermes gateway/
const UNREACHABLE = /Could not reach/

beforeEach(() => {
  resolveGatewayAddress.mockReset()
  mockNetworkKind = 'wifi'
  latest = emptyDraft()
})

describe('a web page where a gateway should be', () => {
  it('asks about the network when the address is one only a private network reaches', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('not_hermes', 'answered oddly', { sawLandingPage: true }))
    renderScreen(<Harness />)
    type('https://hermes.tailnet-name.ts.net')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(PRIVATE_NETWORK))
    expect(screen.getByTestId('probe-error')).toHaveTextContent(LANDING_PAGE)
  })

  it('says only what was seen when the host is a public name', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('not_hermes', 'answered oddly', { sawLandingPage: true }))
    renderScreen(<Harness />)
    type('https://hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(NOT_A_GATEWAY))
    // A public name answering with somebody's front page says nothing about a
    // tailnet, and sending the reader to check a VPN over a typo is the failure
    // this sentence used to have.
    expect(screen.getByTestId('probe-error')).not.toHaveTextContent(PRIVATE_NETWORK)
  })

  it('says nothing extra when what came back was not a page at all', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('not_hermes', 'answered oddly', { sawLandingPage: false }))
    renderScreen(<Harness />)
    type('https://10.0.0.4:9119')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(NOT_A_GATEWAY))
    expect(screen.getByTestId('probe-error')).not.toHaveTextContent(PRIVATE_NETWORK)
  })
})

describe('an address that does not resolve', () => {
  it('asks about the network on cellular, where the tunnel is the likely answer', async () => {
    mockNetworkKind = 'cellular'
    resolveGatewayAddress.mockRejectedValue(new GatewayError('network', 'raw'))
    renderScreen(<Harness />)
    type('hermes.tailnet-name.ts.net')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(PRIVATE_NETWORK))
  })

  it('keeps quiet on Wi-Fi, where a gateway that is switched off is as likely', async () => {
    mockNetworkKind = 'wifi'
    resolveGatewayAddress.mockRejectedValue(new GatewayError('network', 'raw'))
    renderScreen(<Harness />)
    type('hermes.tailnet-name.ts.net')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(UNREACHABLE))
    expect(screen.getByTestId('probe-error')).not.toHaveTextContent(PRIVATE_NETWORK)
  })

  it('keeps quiet when the device will not say what it is on', async () => {
    mockNetworkKind = 'unknown'
    resolveGatewayAddress.mockRejectedValue(new GatewayError('network', 'raw'))
    renderScreen(<Harness />)
    type('hermes.tailnet-name.ts.net')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toHaveTextContent(UNREACHABLE))
    expect(screen.getByTestId('probe-error')).not.toHaveTextContent(PRIVATE_NETWORK)
  })
})

describe('the actions under the failure', () => {
  it('offers the host a redirect landed on, and takes the wizard there', async () => {
    resolveGatewayAddress.mockRejectedValue(
      new GatewayError('redirect', 'moved', { redirectedTo: 'hermes.moved.example' })
    )
    renderScreen(<Harness />)
    type('hermes.old.example')

    await waitFor(() => expect(screen.getByTestId('probe-use-redirect')).toBeTruthy())

    resolveGatewayAddress.mockResolvedValue(at('https://hermes.moved.example'))
    fireEvent.press(screen.getByTestId('probe-use-redirect'))

    await waitFor(() => expect(latest.rawAddress).toBe('hermes.moved.example'))
  })

  it('offers the way to fill in a proxy credential when one refused before the gateway', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('auth', 'refused', { status: 403 }))
    renderScreen(<Harness />)
    type('https://hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-front-door')).toBeTruthy())

    fireEvent.press(screen.getByTestId('probe-front-door'))

    // Advanced opens on the named preset, with the fields empty: it picks the
    // likely one and chooses nothing else for the reader.
    await waitFor(() => expect(screen.getByTestId('cf-access-client-id')).toBeTruthy())
    expect(latest.frontDoor).toEqual({
      kind: 'cloudflare_access',
      clientId: '',
      clientSecret: '',
      origin: 'https://hermes.example.com'
    })
  })

  it('offers nothing for a failure with no next move in it', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('server', 'unwell', { status: 502 }))
    renderScreen(<Harness />)
    type('https://hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toBeTruthy())
    expect(screen.queryByTestId('probe-use-redirect')).toBeNull()
    expect(screen.queryByTestId('probe-front-door')).toBeNull()
  })

  /**
   * The actions belong to the failure that produced them, and they go the
   * moment a new address is being probed \u2014 not when the next answer lands.
   *
   * `classifyProbeFailure` is handed the address that failed, so "Open the
   * front door\u2026" left standing during the next probe offers to configure a
   * credential for a host the reader has already stopped typing. It also sat
   * under a "checking\u2026" line, which made the two readable as one state: the
   * step appeared to be probing AND offering a way out of a failure it had
   * already cleared the message for.
   */
  it('takes the actions away the moment a new address starts being probed', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('auth', 'refused', { status: 401 }))
    renderScreen(<Harness />)
    type('https://hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-front-door')).toBeTruthy())

    // A probe that never settles, so the in-flight state can be read rather
    // than raced past.
    const pending = deferred<never>()

    resolveGatewayAddress.mockReturnValue(pending.promise)
    type('https://hermes.elsewhere.example')

    await waitFor(() => expect(screen.getByTestId('probe-result')).toBeTruthy())
    expect(screen.queryByTestId('probe-front-door')).toBeNull()
  })

  it('clears the actions once the address answers', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('auth', 'refused', { status: 401 }))
    renderScreen(<Harness />)
    type('https://hermes.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-front-door')).toBeTruthy())

    resolveGatewayAddress.mockResolvedValue(at('https://hermes.example.com'))
    type('https://hermes.example.com/')

    await waitFor(() => expect(screen.getByTestId('probe-result')).toBeTruthy())
    expect(screen.queryByTestId('probe-front-door')).toBeNull()
  })
})
