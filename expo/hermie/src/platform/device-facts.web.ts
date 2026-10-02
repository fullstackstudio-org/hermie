/**
 * The browser's answer to `device-facts.ts`.
 *
 * A page cannot name the machine it is on and should not try: what it has is a
 * user-agent string, which is a fingerprinting surface as much as a fact. So
 * the model is the browser rather than the hardware — "Chrome on macOS" is what
 * a bot can usefully act on, and it is the same thing the reader sees in their
 * own About box.
 *
 * `navigator.userAgentData` is the modern, low-entropy half of that and is
 * preferred wherever it exists; the `userAgent` fallback is read with a handful
 * of plain substring tests rather than a parser, because a wrong browser name
 * costs a line of prompt text and a parser costs a dependency.
 */
import Constants from 'expo-constants'

export interface DeviceFacts {
  model: string
  os: string
  appVersion: string
  timezone: string
  locale: string
}

interface UserAgentBrand {
  brand?: string
  version?: string
}

interface UserAgentData {
  brands?: UserAgentBrand[]
  platform?: string
}

const agentData = (): UserAgentData | null => {
  const navigatorWithData = globalThis.navigator as (Navigator & { userAgentData?: UserAgentData }) | undefined

  return navigatorWithData?.userAgentData ?? null
}

const userAgent = (): string => (typeof globalThis.navigator?.userAgent === 'string' ? navigator.userAgent : '')

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

export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

export function deviceLocale(): string {
  const language = typeof globalThis.navigator?.language === 'string' ? navigator.language : ''

  if (language) {
    return language
  }

  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || ''
  } catch {
    return ''
  }
}

/** Which browser, ignoring the two brands every Chromium reports for padding. */
function browserName(): string {
  const brands = agentData()?.brands ?? []

  for (const entry of brands) {
    const brand = typeof entry?.brand === 'string' ? entry.brand : ''

    if (brand && !/not.*a.*brand|chromium/iu.test(brand)) {
      return brand
    }
  }

  const agent = userAgent()

  if (/firefox\//iu.test(agent)) {
    return 'Firefox'
  }

  if (/edg\//iu.test(agent)) {
    return 'Edge'
  }

  if (/chrome\//iu.test(agent)) {
    return 'Chrome'
  }

  if (/safari\//iu.test(agent)) {
    return 'Safari'
  }

  return 'Browser'
}

function osName(): string {
  const platform = agentData()?.platform

  if (typeof platform === 'string' && platform) {
    return platform
  }

  const agent = userAgent()

  for (const [pattern, name] of [
    [/windows/iu, 'Windows'],
    [/android/iu, 'Android'],
    [/iphone|ipad|ipod/iu, 'iOS'],
    [/mac os x|macintosh/iu, 'macOS'],
    [/linux/iu, 'Linux']
  ] as const) {
    if (pattern.test(agent)) {
      return name
    }
  }

  return ''
}

export function readDeviceFacts(): DeviceFacts {
  const os = osName()

  return {
    model: os ? `${browserName()} on ${os}` : browserName(),
    os,
    appVersion: appVersionLabel(),
    timezone: deviceTimezone(),
    locale: deviceLocale()
  }
}
