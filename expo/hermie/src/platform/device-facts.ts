/**
 * What this device will tell a bot about itself.
 *
 * The gateway-side plugin renders these into a bot's system prompt once per
 * session — "They are on iPhone 17 Pro running iOS 27.0", "their timezone is
 * Europe/Amsterdam" — so what is collected here is exactly what the model gets
 * to see, and nothing is gathered that is not rendered.
 *
 * **No new native dependency.** `expo-device` would give a model name off a
 * lookup table; `expo-constants` is already in the build and already answers
 * the same question well enough. `Constants.deviceName` is `UIDevice.name` on
 * iOS and `Build.MODEL` on Android, so on a phone somebody named it is a name
 * they chose — which is the reason Settings shows this line back to the reader
 * verbatim rather than describing it. Nobody should have to guess what leaves
 * the device.
 *
 * **A Mac says Mac.** The Mac build is the iPad binary running under
 * `isiOSAppOnMac` (ADR-0011), so `Platform.OS` is `ios` and
 * `Platform.Version` is the iOS runtime version rather than macOS'. Reporting
 * that unqualified would tell a bot the owner is on an iPad, which is the one
 * thing a context section exists to get right.
 *
 * Everything here is defensive. A runtime with no `Intl`, a manifest with no
 * `extra`, a platform that answers `undefined` — each of those is one empty
 * field, never a throw, because this is read on a foreground transition and a
 * crash there would take the app down for a line of prompt text.
 */
import Constants from 'expo-constants'
import { Platform } from 'react-native'

import { RUNS_ON_MAC } from './runs-on-mac'

export interface DeviceFacts {
  model: string
  os: string
  /** `0.1.0 (1284) · 7c838c4`: version, build number and commit. */
  appVersion: string
  timezone: string
  locale: string
}

/** The build's own identity, as About already prints it. */
export function appVersionLabel(): string {
  const extra = Constants.expoConfig?.extra as { commit?: unknown; buildNumber?: unknown } | undefined
  const version = typeof Constants.expoConfig?.version === 'string' ? Constants.expoConfig.version : ''
  const build =
    typeof extra?.buildNumber === 'number' || typeof extra?.buildNumber === 'string' ? extra.buildNumber : ''
  const commit = typeof extra?.commit === 'string' ? extra.commit : ''

  const head = build ? `${version} (${build})` : version

  return commit ? `${head} · ${commit}`.trim() : head
}

/** `Europe/Amsterdam`, or nothing on a runtime with no `Intl`. */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

/** `nl-NL`, or nothing. Same caveat as the timezone. */
export function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || ''
  } catch {
    return ''
  }
}

function deviceModel(): string {
  if (RUNS_ON_MAC) {
    return 'Mac'
  }

  const name = typeof Constants.deviceName === 'string' ? Constants.deviceName.trim() : ''

  if (name) {
    return name
  }

  // A simulator with no name, or a platform that declines. The idiom is the
  // least this can honestly say and is still worth saying.
  return Platform.OS === 'ios' ? (Platform.isPad ? 'iPad' : 'iPhone') : Platform.OS
}

function deviceOs(): string {
  const version = String(Platform.Version ?? '')

  if (RUNS_ON_MAC) {
    // Both halves, because both are true and a bot that is told only one of
    // them will reason about the wrong machine.
    return version ? `macOS · iOS ${version}` : 'macOS'
  }

  const name = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS

  return version ? `${name} ${version}` : name
}

/** Everything, read now. Cheap enough to call on every foreground. */
export function readDeviceFacts(): DeviceFacts {
  return {
    model: deviceModel(),
    os: deviceOs(),
    appVersion: appVersionLabel(),
    timezone: deviceTimezone(),
    locale: deviceLocale()
  }
}
