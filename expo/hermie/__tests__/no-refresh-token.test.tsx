/**
 * A sign-in that worked and cannot be renewed.
 *
 * Nothing here is an error path: the exchange succeeded, the session is live,
 * the bots answer. What it has is an expiry nobody was told about, and the
 * three assertions below are the three places that were silent about it — the
 * last step of the wizard, Settings, and the auth timeline that outlives both.
 */
import { screen } from '@testing-library/react-native'

import { RefreshNotice } from '../src/gateway/RefreshNotice'
import { DoneStep } from '../src/features/onboarding/steps/DoneStep'
import { emptyDraft } from '../src/features/onboarding/draft'
import { renderScreen } from './support/render'

const tokens = (refreshToken: string) => ({
  accessToken: 'access',
  refreshToken,
  expiresAt: 0,
  provider: 'self-hosted',
  userId: 'u1'
})

describe('the notice itself', () => {
  it('says nothing at all when the credential can be refreshed', () => {
    renderScreen(<RefreshNotice canRefresh testID="notice" />)

    expect(screen.queryByTestId('notice')).toBeNull()
  })

  it('names the scope and offers the page that explains it', () => {
    renderScreen(<RefreshNotice canRefresh={false} testID="notice" />)

    // The scope is the fix, and it is upstream of this app entirely. A line
    // that only said "could not refresh" would send people to reinstall.
    expect(screen.getByTestId('notice').props.children).toContain('offline_access')
    expect(screen.getByTestId('notice-link')).toBeTruthy()
  })
})

describe('the last step of setup', () => {
  it('warns when the exchange came back without a refresh token', () => {
    renderScreen(<DoneStep draft={{ ...emptyDraft(), tokens: tokens('') }} error={null} />)

    expect(screen.getByTestId('done-no-refresh')).toBeTruthy()
  })

  it('stays quiet when it came back with one', () => {
    renderScreen(<DoneStep draft={{ ...emptyDraft(), tokens: tokens('refresh') }} error={null} />)

    expect(screen.queryByTestId('done-no-refresh')).toBeNull()
  })

  it('stays quiet for a gateway that has no tokens to speak of', () => {
    // Session-token and cookie gateways have nothing to rotate; telling them
    // about a refresh token they were never going to have is noise.
    renderScreen(<DoneStep draft={emptyDraft()} error={null} />)

    expect(screen.queryByTestId('done-no-refresh')).toBeNull()
  })
})
