/**
 * Open the app straight onto one surface, from the command line.
 *
 * **Why this exists.** This machine has no `Simulator.app`, so `xcrun simctl` is
 * the whole toolbox: an app can be launched and photographed and nothing else —
 * no taps, no swipes, no rotation (docs/platform-notes.md, "The wide layout, on
 * an iPad simulator"). Three consecutive design rounds therefore shipped every
 * sheet, every options page and the colour picker without anyone having seen one
 * of them, because all of it sits behind a tap. Launch arguments are the one
 * channel `simctl` does have, and one launch then equals one screenshot:
 *
 * ```sh
 * xcrun simctl launch <udid> dev.hermie.app \
 *   --initialUrl http://localhost:8081 \
 *   --hermieOpen gallery:sheets/options-model-page --hermieTheme dark
 * ```
 *
 * **Why it cannot reach a release build.** Three independent gates, because a
 * back door that opens arbitrary screens is not something to leave one flag away
 * from a shipped app:
 *
 *  1. the constant it reads is inside `#if DEBUG` in `HermieMacModule.swift`, so
 *     a Release binary does not define it at all;
 *  2. `__DEV__` is checked here, and Metro inlines it as `false` in a production
 *     bundle, which folds the native read and everything reached through it;
 *  3. nothing is registered with the system — no URL scheme, no
 *     `CFBundleURLTypes`, no entitlement, no associated domain. Launch arguments
 *     are visible only to the process itself, and nothing but a debugger or
 *     `simctl` can set them on a device.
 *
 * **Android reaches the same grammar through Intent extras**, because there is no
 * process argument vector to set there — see `modules/hermie-dev-launch`, which
 * flattens `--es hermieGateway <url>` into the same `argv` this file parses. It
 * has gates 2 and 3 from above but not gate 1 in the same form: the native read is
 * behind a runtime `FLAG_DEBUGGABLE` check rather than removed by the compiler,
 * and `MainActivity` is `exported` because a launcher activity has to be. The
 * module's own comment says so rather than claiming parity.
 *
 * **What gate 2 actually removes, measured** rather than assumed — the claim used
 * to be that the minifier folds "the code" out, and that is not quite true.
 * `npx expo export:embed --platform ios --dev false` on 2026-09-20 produced a
 * bundle in which:
 *
 *  - `devLaunchArguments`, the native property, appears **zero** times: the read
 *    and `requireOptionalNativeModule` are gone from this module entirely;
 *  - this module's `DEV_LAUNCH_INTENT` compiles to the literal `var v = null`;
 *  - `seedDevGateway` compiles to `function*(){ return !1 }` — its body, and the
 *    `saveGatewaySetup` call inside it, are not in the bundle at all;
 *  - but `parseDevLaunchArguments` IS still there, with `'--hermiegateway'` and
 *    the rest of the grammar as string literals, because it is a module export
 *    and Metro will not drop one. Nothing calls it, and with `DEV_LAUNCH_INTENT`
 *    folded to `null` nothing can. So the right claim is that the argument is
 *    INERT in Release, not that its parser is absent — `strings` on a release
 *    bundle will find these flag names, and that is expected.
 *
 * `__tests__/dev-launch-intent.test.ts` asserts the `__DEV__` gate, and
 * `__tests__/dev-seed-gateway.test.ts` asserts that the seeder writes nothing
 * with the flag down.
 *
 * **The grammar**, deliberately tiny and order-independent:
 *
 * | Argument                      | Meaning                                          |
 * | ----------------------------- | ------------------------------------------------ |
 * | `--hermieOpen gallery:<id>`   | one gallery section, alone, filling the screen   |
 * | `--hermieOpen sheet:<name>`   | shorthand for that sheet's gallery section       |
 * | `--hermieOpen chat:<handle>`  | the real chat screen for that bot                |
 * | `--hermieOpen overlay:<s>[/p]`| Activity / Crons / Settings, and a settings page |
 * | `--hermieOpen gallery:appearance` | Settings → Appearance, alone            |
 * | `--hermieTheme light\|dark`   | pin the scheme, whatever the simulator is set to |
 * | `--hermiePreset <name>`       | pin the theme preset                             |
 * | `--hermieGateway <url>`       | seed that gateway and skip the wizard            |
 * | `--hermieToken <token>`       | the session token to seed beside it               |
 * | `--hermieTraceScroll`         | log the transcript's offsets and row heights      |
 *
 * `--hermieOpen=<value>` is accepted as well, because a shell quoting habit
 * should not be the reason a screenshot comes back wrong.
 *
 * **Why `--hermieGateway` exists**, since it is the one argument that writes
 * something rather than only choosing what to draw: `chat:` and `overlay:` need a
 * configured gateway, and the only way to configure one was to complete the
 * five-step wizard by hand — which means finding a text field in a screenshot,
 * typing an address, waiting for a probe, typing a token, and tapping through a
 * connection test. That is four rounds of coordinate arithmetic against a screen
 * that re-renders under the tap, and it is why the README's screenshots sat stale
 * through three design passes. It seeds the same two stores the wizard's last step
 * writes, in the same shape, through the same functions — see `seedDevGateway` in
 * `seed-gateway.ts`.
 */
import { hasExplicitScheme, normalizeBaseUrl } from '@hermie/gateway-client'
import { requireOptionalNativeModule } from 'expo'

import { settingsRouteFrom, type SettingsRouteName } from '../features/settings/navigation/route-names'
import { THEME_PRESET_ORDER, type ThemePresetName } from '../ui/themes'
import { type Scheme } from '../ui/tokens'

/** The three destinations that are not the gallery. */
export type DevOverlaySection = 'activity' | 'cron' | 'settings'

/** A page inside Settings, as a route in its own stack (`features/settings/navigation`). */
export type DevSettingsPage = SettingsRouteName

export type DevOpenTarget =
  | { kind: 'gallery'; section: string }
  | { kind: 'chat'; bot: string }
  | { kind: 'overlay'; section: DevOverlaySection; page?: DevSettingsPage }

/**
 * A gateway to seed before the app reads its configuration.
 *
 * `token` is optional and the difference is worth stating: with one, the app
 * reaches the connected shell outright; without one, the address is seeded and
 * nothing else, so the wizard opens on its sign-in step with the address already
 * filled — the same state a sign-out leaves behind.
 */
export interface DevGatewaySeed {
  baseUrl: string
  token?: string
}

export interface DevLaunchIntent {
  open?: DevOpenTarget
  scheme?: Scheme
  preset?: ThemePresetName
  gateway?: DevGatewaySeed
  /**
   * Trace the transcript's scroll offsets and row heights to the log.
   *
   * The one flag here that takes no value, because it asks for nothing to be
   * drawn — see `trace-scroll.ts` for what it prints and why it is kept.
   */
  traceScroll?: boolean
  /**
   * Trace every width the window reports, every width that SETTLES out of those,
   * and every change of the sidebar's state with the reason for it.
   *
   * Same shape as `traceScroll` and for the same reason: the bug it exists for —
   * the sidebar closing itself — leaves nothing behind in any state a screenshot
   * can show, because by the time anyone looks the width is back to normal.
   */
  traceLayout?: boolean
}

const OVERLAY_SECTIONS: Record<string, DevOverlaySection> = {
  activity: 'activity',
  cron: 'cron',
  crons: 'cron',
  routines: 'cron',
  settings: 'settings'
}

/*
  Any route name, plus the spellings the old boolean pages were opened by —
  `settingsRouteFrom` in `features/settings/navigation/route-names.ts` owns
  both, so a page added to Settings is openable from the command line without
  anything here being told about it.

  This exists for the reason the whole file does: these pages are behind taps a
  simulator on this machine cannot make, and a page nobody can open is a page
  nobody photographs — which is how the screenshots went stale through three
  design passes.
*/

/** `sheet:approval` → the gallery section that holds the approval sheet. */
const SHEET_SECTIONS: Record<string, string> = {
  agents: 'sheet-agents',
  approval: 'sheet-approval',
  'approval-answered': 'sheet-approval-answered',
  clarify: 'sheet-clarify',
  'clarify-batch': 'sheet-clarify-batch',
  colour: 'sheet-options-colour-page',
  color: 'sheet-options-colour-page',
  cron: 'sheet-cron-editor',
  'cron-editor': 'sheet-cron-editor',
  model: 'sheet-options-model-page',
  options: 'sheet-options',
  reasoning: 'sheet-options-reasoning-page'
}

/**
 * A gateway address from the command line, or `undefined` if it is not one.
 *
 * A scheme-less address resolves to `http://`, which is the one place this
 * deliberately disagrees with `normalizeBaseUrl`. That function answers `https://`
 * because the wizard then PROBES both and tells the reader which one answered;
 * there is no probe here, and the only gateways this argument ever names are a
 * loopback port or a LAN address, so defaulting to https would turn the common
 * case into a connection that cannot succeed.
 */
function parseGatewayUrl(value: string): string | undefined {
  const trimmed = value.trim()

  if (!trimmed) {
    return undefined
  }

  try {
    return normalizeBaseUrl(hasExplicitScheme(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    // Not an address at all. Ignored like every other unrecognised value here,
    // so a typo produces the wizard rather than a crash on launch.
    return undefined
  }
}

function parseTarget(value: string): DevOpenTarget | undefined {
  const at = value.indexOf(':')
  const kind = (at < 0 ? value : value.slice(0, at)).trim().toLowerCase()
  const rest = at < 0 ? '' : value.slice(at + 1).trim()

  if (kind === 'gallery') {
    return rest ? { kind: 'gallery', section: rest } : { kind: 'gallery', section: '' }
  }

  if (kind === 'sheet') {
    const section = SHEET_SECTIONS[rest.toLowerCase()]

    return section ? { kind: 'gallery', section } : undefined
  }

  if (kind === 'chat') {
    return rest ? { kind: 'chat', bot: rest } : undefined
  }

  if (kind === 'overlay') {
    const [head = '', tail = ''] = rest.split('/')
    const section = OVERLAY_SECTIONS[head.toLowerCase()]

    if (!section) {
      return undefined
    }

    const page = section === 'settings' ? settingsRouteFrom(tail) : undefined

    return { kind: 'overlay', section, ...(page ? { page } : {}) }
  }

  return undefined
}

/**
 * Read one intent out of an argv array. Pure, so it is the part with tests.
 *
 * Returns `null` when nothing in the array asks for anything, which is the
 * ordinary case: every simulator launch carries arguments, and almost none of
 * them are ours.
 */
export function parseDevLaunchArguments(argv: readonly string[]): DevLaunchIntent | null {
  const intent: DevLaunchIntent = {}
  // Collected apart from the intent because the two arguments are order
  // independent like everything else here: the token can be read before the
  // address it belongs to.
  let gatewayUrl: string | undefined
  let token: string | undefined

  const valueAt = (index: number, inline: string | undefined): string => {
    if (inline !== undefined) {
      return inline
    }

    const next = argv[index + 1]

    // A following token that is itself a flag is somebody else's argument, not
    // our value — `--hermieOpen --hermieTheme dark` asks for nothing.
    return next && !next.startsWith('--') ? next : ''
  }

  argv.forEach((raw, index) => {
    const eq = raw.indexOf('=')
    const flag = (eq < 0 ? raw : raw.slice(0, eq)).toLowerCase()
    const inline = eq < 0 ? undefined : raw.slice(eq + 1)

    if (flag === '--hermieopen') {
      const target = parseTarget(valueAt(index, inline))

      if (target) {
        intent.open = target
      }

      return
    }

    if (flag === '--hermietheme') {
      const value = valueAt(index, inline).toLowerCase()

      if (value === 'light' || value === 'dark') {
        intent.scheme = value
      }

      return
    }

    if (flag === '--hermiepreset') {
      const value = valueAt(index, inline).toLowerCase()

      if ((THEME_PRESET_ORDER as readonly string[]).includes(value)) {
        intent.preset = value as ThemePresetName
      }

      return
    }

    if (flag === '--hermiegateway') {
      gatewayUrl = parseGatewayUrl(valueAt(index, inline))

      return
    }

    if (flag === '--hermietracescroll') {
      // A bare flag is on, and `--hermieTraceScroll false` is off: a shell habit
      // of passing every flag a value should not turn a trace on by accident.
      const value = valueAt(index, inline).toLowerCase()

      intent.traceScroll = value !== 'false' && value !== '0'

      return
    }

    if (flag === '--hermietracelayout') {
      const value = valueAt(index, inline).toLowerCase()

      intent.traceLayout = value !== 'false' && value !== '0'

      return
    }

    if (flag === '--hermietoken') {
      // NOT lowercased, unlike every other value here: a session token is opaque
      // and case-sensitive, and the gateway compares it byte for byte.
      token = valueAt(index, inline).trim() || undefined
    }
  })

  if (gatewayUrl) {
    // A token with no address seeds nothing: there is no gateway for it to be a
    // credential for, and writing one to the keychain on its own would leave a
    // secret behind that no configuration can explain.
    intent.gateway = { baseUrl: gatewayUrl, ...(token ? { token } : {}) }
  }

  return intent.open ||
    intent.scheme ||
    intent.preset ||
    intent.gateway ||
    intent.traceScroll !== undefined ||
    intent.traceLayout !== undefined
    ? intent
    : null
}

type DevLaunchModule = { devLaunchArguments?: unknown }

/**
 * The two native modules that can answer, in the order they are tried.
 *
 * `HermieMac` is Apple-only and reports the process's own argument vector, which
 * is what `xcrun simctl launch` sets. Android has no argument vector to set, so
 * `HermieDevLaunch` reports this launch's Intent extras flattened into the same
 * shape — see `modules/hermie-dev-launch`. Exactly one of the two exists in any
 * given binary, so the order only decides which `undefined` is skipped first.
 */
const DEV_LAUNCH_MODULES = ['HermieMac', 'HermieDevLaunch'] as const

function nativeArguments(): readonly string[] {
  for (const name of DEV_LAUNCH_MODULES) {
    try {
      const value = requireOptionalNativeModule<DevLaunchModule>(name)?.devLaunchArguments
      const argv = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

      if (argv.length > 0) {
        return argv
      }
    } catch {
      // No Expo module host: a unit test renderer, or a platform this module was
      // not built for. Nothing to read is the honest answer, not an error.
      continue
    }
  }

  return []
}

/**
 * The intent this process was launched with, or `null`.
 *
 * Evaluated once, at module load, because launch arguments cannot change while
 * the process lives — and because a value read once is a value a production
 * bundle can drop entirely.
 */
export const DEV_LAUNCH_INTENT: DevLaunchIntent | null = __DEV__ ? parseDevLaunchArguments(nativeArguments()) : null
