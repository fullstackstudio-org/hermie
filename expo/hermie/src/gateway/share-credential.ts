/**
 * Keeping the share extension's credential in step with the app's.
 *
 * `features/share/delivery-credential.ts` owns the FORMAT and knows nothing
 * about where a gateway's configuration lives. This is the other half: the three
 * moments at which the answer can have changed, and the reading of the stores
 * that produces it.
 *
 * ## The three moments, and why they are these three
 *
 * - **The registry was written.** Everything that changes WHICH gateway is
 *   active goes through `saveGatewayRegistry` — onboarding, switching, removing
 *   the active one. That makes it the one place worth reconciling from scratch,
 *   and the only one that has the registry in its hand.
 * - **A token rotated.** `createSecretTokenStore(...).save()` is the single seam
 *   through which a refreshed access token reaches the keychain. Without a
 *   republish here the extension would hold the token the app was signed in with
 *   an hour ago, which expires and then queues everything for ever — the feature
 *   would appear to work for one hour after every launch.
 * - **Credentials were cleared.** A sign-out has to take the extension's copy
 *   with it. Otherwise the access token stays valid at the identity provider for
 *   as long as it has left to live, and a share sheet keeps sending on a session
 *   its owner has ended, which is the one failure in this feature that is worse
 *   than not delivering. That one is NOT here: it needs nothing but the record
 *   itself, so it lives in `clearCredentials` and calls
 *   `dropShareDeliveryRecordFor` directly — this module imports `config.ts`, and
 *   a `config.ts` that imported this one back would close a cycle.
 *
 * ## Why the rotation path is guarded and the registry path is not
 *
 * A rotation names ONE gateway, and it is not necessarily the active one — the
 * app holds tokens for every configured gateway and refreshes the one whose
 * banner was tapped. So it only acts on a record that is already this gateway's
 * or absent, and the registry path is the one allowed to decide whose record it
 * is. Without that, a background refresh on a gateway nobody is using would take
 * the active one's credential away from the sheet.
 *
 * Nothing here throws and nothing here is awaited by anything that matters. A
 * keychain that refuses means the extension queues instead of sending, which is
 * exactly what it did before ADR-0026 and is still the fallback.
 */
import { gatewayKeyOf } from '@hermie/gateway-client'

import { secretStore } from '../platform/secret-store'
import {
  buildShareDeliveryRecord,
  publishedShareDeliveryGateway,
  writeShareDeliveryRecord
} from '../features/share/delivery-credential'
import { loadGatewaySetup, secretKeysFor } from './config'
import { namespace, type GatewayNamespace } from './namespace'

/**
 * The access token and its deadline, for the PKCE flow.
 *
 * Read here rather than taken from `GatewaySetup`, which deliberately reports
 * only WHETHER there is a credential: everything else in the app needs the
 * boolean and nothing else needed the token itself until an extension had to
 * carry one. `tokenMeta` is the same JSON blob `createSecretTokenStore` writes,
 * read with the same tolerance — a corrupt blob costs the deadline, not the
 * token.
 */
async function pkceToken(ns: GatewayNamespace): Promise<{ accessToken: string; expiresAt: number }> {
  const keys = secretKeysFor(ns)
  const [accessToken, rawMeta] = await Promise.all([secretStore.get(keys.accessToken), secretStore.get(keys.tokenMeta)])

  let expiresAt = 0

  if (rawMeta) {
    try {
      const parsed = JSON.parse(rawMeta) as { expiresAt?: unknown }

      expiresAt = typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : 0
    } catch {
      // No deadline means the extension tries and may be told 401, which it
      // handles by leaving the entry. That is one wasted round trip, not a bug.
    }
  }

  return { accessToken: accessToken ?? '', expiresAt }
}

/** Build and write the record for one gateway, or take the published one away. */
async function publishFor(ns: GatewayNamespace): Promise<void> {
  const setup = await loadGatewaySetup(ns)

  if (!setup) {
    await writeShareDeliveryRecord(secretStore, null)

    return
  }

  const pkce = setup.config.authMode === 'native_pkce' ? await pkceToken(ns) : { accessToken: '', expiresAt: 0 }

  const record = buildShareDeliveryRecord({
    gatewayId: ns.id,
    gatewayKey: gatewayKeyOf(setup.config.baseUrl),
    baseUrl: setup.config.baseUrl,
    authMode: setup.config.authMode,
    headers: setup.extraHeaders,
    sessionToken: setup.sessionToken,
    accessToken: pkce.accessToken,
    expiresAt: pkce.expiresAt
  })

  await writeShareDeliveryRecord(secretStore, record)
}

/**
 * Reconcile the published record against whichever gateway is now active.
 *
 * Takes the ID rather than the registry, and that is not a convenience: this
 * module is imported BY `registry.ts`, so reaching back into it for
 * `activeGatewayOf` would close an import cycle — the kind that resolves to
 * `undefined` at module scope in a release bundle and to nothing at all in
 * development.
 *
 * With nothing active — a first run, a reader who removed their last gateway —
 * the record goes. An extension holding a credential for a gateway the app has
 * forgotten would be the only part of the install still able to reach it.
 */
export async function publishShareDeliveryCredential(activeGatewayId: string | null): Promise<void> {
  try {
    if (!activeGatewayId) {
      await writeShareDeliveryRecord(secretStore, null)

      return
    }

    await publishFor(namespace(activeGatewayId))
  } catch {
    // See the module comment: the cost of failing here is a queued share.
  }
}

/**
 * A rotated token, for a gateway that is not necessarily the active one.
 *
 * Republished when the record already names this gateway — the ordinary case,
 * an hour into a session — and ALSO when no record is published at all, which is
 * the state a sign-out leaves behind. Without the second half, signing out and
 * back in again would leave the extension with nothing until the next time
 * anything wrote the registry, and "share works, until you sign out once" is a
 * worse story than "share does not work".
 *
 * Publishing for an inactive gateway is the price of that, and it is paid on the
 * other side: `share-targets.json` carries the active gateway's key, the record
 * carries its own, and the extension sends nothing when the two disagree. A
 * record for the wrong gateway is therefore inert rather than wrong.
 */
export async function refreshShareDeliveryCredential(ns: GatewayNamespace): Promise<void> {
  try {
    const published = await publishedShareDeliveryGateway(secretStore)

    if (published !== null && published !== ns.id) {
      return
    }

    await publishFor(ns)
  } catch {
    // As above.
  }
}
