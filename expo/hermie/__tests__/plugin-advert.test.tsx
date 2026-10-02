/**
 * Whether the gateway has a Hermie plugin, and what the app does about it.
 *
 * `packages/gateway-client/src/plugin.test.ts` pins the READING of the advert
 * against the plugin's own contract. This is what the app does with the answer,
 * and the three cases are three different screens:
 *
 *  - **"Checking…" is not "Not installed".** They look the same for a second,
 *    and only one of them is a reason to send somebody to a shell. The store
 *    keeps them apart with `read`, and everything else follows from that.
 *  - **The advert must not be cleared by the app asking itself.** The app-side
 *    snapshot carries no `plugin` field at all, and a reader that treated an
 *    absent field as "gone" would flip the whole app into "no plugin" on the
 *    next local settings change.
 *  - **The install screen is the same screen in both places.** A reader who
 *    skipped it during setup and came looking in Settings later should find
 *    what they skipped, not a paraphrase of it.
 */
import { PLUGIN_ADVERT } from '@hermie/fake-gateway'
import { pluginAdvertOf } from '@hermie/gateway-client/plugin'
import { screen } from '@testing-library/react-native'

import { NS_A } from './support/gateway-namespace'

import { NotificationsSection } from '../src/features/push/NotificationsSection'
import { PLUGIN_INSTALL_COMMANDS } from '../src/features/push/PluginInstall'
import { PushSync } from '../src/features/push/push-sync'
import { NotificationsStep } from '../src/features/onboarding/steps/NotificationsStep'
import { emptyDraft, type ConnectionTestOutcome, type OnboardingDraft } from '../src/features/onboarding/draft'
import { keyValueStore } from '../src/platform/key-value-store'
import { pluginPresence, usePluginStore } from '../src/store/plugin'
import { PUSH_KEY, usePushStore } from '../src/store/push'
import { applySnapshot } from '../src/store/ui-meta-bridge'
import { renderScreen } from './support/render'

const ADVERT = pluginAdvertOf(PLUGIN_ADVERT)

const push = () =>
  new PushSync({
    namespace: NS_A,
    ports: {
      showChat: async () => undefined,
      openApprovals: async () => [],
      respondApproval: async () => undefined
    },
    platform: {
      available: true,
      platform: 'ios',
      needsSystemSettings: false,
      openSystemSettings: async () => false,
      prepare: async () => undefined,
      permission: async () => 'undetermined' as const,
      requestPermission: async () => 'undetermined' as const,
      obtainAddress: async () => ({ transport: 'expo' as const, token: 'ExponentPushToken[abc]' }),
      dropAddress: async () => undefined,
      onResponse: () => () => undefined,
      consumeInitialResponse: async () => null
    }
  })

function testedDraft(plugin: ConnectionTestOutcome['plugin']): OnboardingDraft {
  return {
    ...emptyDraft(),
    baseUrl: 'https://hermes.example.com',
    test: { key: '', userDisplayName: 'Fake Tester', botCount: 2, plugin }
  }
}

beforeEach(async () => {
  usePluginStore.getState().reset()
  usePushStore.getState().reset()
  await keyValueStore.delete(PUSH_KEY)
  await usePushStore.getState().hydrate(NS_A)
})

describe('the three states', () => {
  it('says nothing before a roster has arrived', () => {
    expect(pluginPresence(usePluginStore.getState())).toBe('unknown')
  })

  it('takes the advert off a gateway snapshot', () => {
    applySnapshot({ app: null, bots: {}, plugin: ADVERT })

    expect(pluginPresence(usePluginStore.getState())).toBe('installed')
    expect(usePluginStore.getState().advert?.version).toBe('0.2.0')
  })

  it('reads a gateway that carried no advert as not installed', () => {
    applySnapshot({ app: null, bots: {}, plugin: null })

    expect(pluginPresence(usePluginStore.getState())).toBe('absent')
  })

  it('is not cleared by a snapshot the app produced itself', () => {
    applySnapshot({ app: null, bots: {}, plugin: ADVERT })
    // No `plugin` field at all — which is what `snapshotFromStores` answers and
    // says nothing about the gateway.
    applySnapshot({ app: null, bots: {} })

    expect(pluginPresence(usePluginStore.getState())).toBe('installed')
  })
})

describe('the install screen', () => {
  it('is shown in Settings when the gateway has no plugin', () => {
    applySnapshot({ app: null, bots: {}, plugin: null })
    renderScreen(<NotificationsSection push={push()} />)

    expect(screen.getByTestId('settings-plugin-install')).toBeTruthy()
    // Both lines. A reader who ran only the install would restart nothing and
    // find the advert still missing, with no reason why.
    expect(screen.getByTestId('settings-plugin-install-commands')).toHaveTextContent(PLUGIN_INSTALL_COMMANDS.join(' '))
    // The switch stays: `hermie-web --push` is still supported, and somebody
    // already running it would otherwise be refused a feature that works.
    expect(screen.getByTestId('settings-push-enabled')).toBeTruthy()
  })

  it('is not shown when the plugin is there', () => {
    applySnapshot({ app: null, bots: {}, plugin: ADVERT })
    renderScreen(<NotificationsSection push={push()} />)

    expect(screen.queryByTestId('settings-plugin-install')).toBeNull()
  })

  it('is the same screen the wizard shows after a test that found no plugin', () => {
    renderScreen(<NotificationsStep draft={testedDraft(null)} />)

    expect(screen.getByTestId('onboarding-plugin-install')).toBeTruthy()
    expect(screen.getByTestId('onboarding-plugin-install-guide')).toBeTruthy()
    expect(screen.queryByTestId('onboarding-push-enable')).toBeNull()
  })

  it('gives way to the switch when the test found one', () => {
    renderScreen(<NotificationsStep draft={testedDraft(ADVERT)} />)

    expect(screen.queryByTestId('onboarding-plugin-install')).toBeNull()
    expect(screen.getByTestId('onboarding-push-enable')).toBeTruthy()
    // Always skippable, and it says so rather than leaving somebody hunting for
    // the way past a permission dialog they do not want yet.
    expect(screen.getByTestId('onboarding-push-skip')).toBeTruthy()
  })
})
