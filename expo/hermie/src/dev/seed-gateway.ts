/**
 * Seed a configured gateway from a launch argument, so onboarding is skipped.
 *
 * **Why this is not a shortcut around the stores.** It would have been cheaper to
 * hold the address and the token in memory and hand them to `GatewayProvider`
 * directly, and that would have been worthless: the thing a screenshot has to
 * prove is the app a reader gets, and that app reads its gateway off disk. A seed
 * that bypasses the stores photographs a code path nobody ships. So this writes
 * the same two stores the wizard's last step writes — the key-value config and the
 * keychain's session token — through `saveGatewaySetup`, the same function
 * `OnboardingNavigator.finish` calls, with the config built by the same
 * `configFromDraft`. There is one shape, and it is not defined here.
 *
 * **What it deliberately does not do.** It does not probe. The wizard learns the
 * gateway's version and the user's display name from a round trip it makes the
 * reader wait for, and neither is needed to connect: `version` and
 * `userDisplayName` are optional on `StoredGatewayConfig`, so a seeded setup shows
 * "Unknown" for both in Settings until a wizard run fills them in. That is the
 * honest cost of not blocking a launch on the network, and it is invisible in
 * every surface this argument exists to photograph.
 *
 * **The gates are the same three as the rest of `src/dev`.** The native constant
 * the arguments come from is inside `#if DEBUG`, `DEV_LAUNCH_INTENT` is already
 * `null` unless `__DEV__`, and this module's one exported function checks `__DEV__`
 * again at its own top so the write itself is dead code in a production bundle
 * rather than merely unreachable through a null. See `launch-intent.ts` for why a
 * back door gets three gates instead of one.
 */
// From `draft` itself rather than from the feature's barrel: the barrel pulls in
// every step's UI, and this module is imported by `GatewayProvider`, which mounts
// before any of it.
import { configFromDraft, emptyDraft } from '../features/onboarding/draft'
import { loadGatewayRegistry, saveGatewayAndRegister } from '../gateway/registry'
import { DEV_LAUNCH_INTENT } from './launch-intent'

/**
 * Write the seeded gateway, if a launch argument named one.
 *
 * Called by `GatewayProvider.reload` BEFORE it reads the configuration, which is
 * what makes the read find it and the phase land on `connected` instead of
 * `onboarding`. Idempotent: the same launch argument writes the same two values
 * every time, so a reload during a Metro session costs one keychain write and
 * changes nothing.
 *
 * Resolves to whether anything was written, so a caller can tell a seeded launch
 * from an ordinary one without reading the intent a second time.
 */
export async function seedDevGateway(): Promise<boolean> {
  const seed = __DEV__ ? DEV_LAUNCH_INTENT?.gateway : undefined

  if (!seed) {
    return false
  }

  // Through the wizard's own draft so the stored shape cannot drift from what a
  // real setup writes. A draft with no `probe` is a session-token gateway, which
  // is what `authModeOf(null)` answers and what this argument is for — the native
  // PKCE flow cannot be seeded, because its credential is minted by a round trip
  // through an identity provider and there is nothing to copy from the command
  // line.
  const draft = { ...emptyDraft(), rawAddress: seed.baseUrl, baseUrl: seed.baseUrl, sessionToken: seed.token ?? '' }

  // Into the entry that already names this address, when there is one, so a
  // reload during a Metro session writes the same entry rather than growing the
  // list by one on every refresh.
  const { registry } = await loadGatewayRegistry()
  const existing = registry.gateways.find(gateway => gateway.address === seed.baseUrl)

  await saveGatewayAndRegister({
    gatewayId: existing?.id ?? null,
    // A launch argument naming a gateway means "use this one", so it becomes
    // the live one even on a device that already had others.
    activate: true,
    config: configFromDraft(draft),
    extraHeaders: {},
    sessionToken: seed.token ?? null
  })

  return true
}
