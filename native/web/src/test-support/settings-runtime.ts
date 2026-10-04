/**
 * What the Settings pages are given by the page, filled in for a test: a gateway at a made-up address,
 * a person with a name, and spies for the two things only the entry module can do.
 */
import { vi } from 'vitest'

import type { SettingsRuntime } from '../features/settings/settings-runtime'

export function aSettingsRuntime(
  over: Partial<Omit<SettingsRuntime, 'clearTranscriptCache' | 'signOut'>> = {}
): SettingsRuntime & {
  clearTranscriptCache: ReturnType<typeof vi.fn<() => Promise<void>>>
  signOut: ReturnType<typeof vi.fn<() => void>>
} {
  return {
    gatewayBaseUrl: 'https://gw.example.test',
    hermesVersion: '0.21.3',
    identity: { displayName: 'Tess Tester', email: 'tess@example.test', userId: 'u-1', provider: 'password' },
    user: 'Tess Tester',
    pictureUrl: '',
    licencesUrl: 'https://gw.example.test/dashboard-plugins/hermie/app/licenses.json',
    ...over,
    clearTranscriptCache: vi.fn<() => Promise<void>>(async () => undefined),
    signOut: vi.fn<() => void>()
  }
}
