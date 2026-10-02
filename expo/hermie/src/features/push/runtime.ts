/**
 * One seam, for one ordering problem.
 *
 * ADR-0017: "a sign-out or a change of gateway removes this installation's entry
 * — a registration is only meaningful for the gateway it was made on". Removing
 * it is a WRITE, and a write needs the socket. `GatewayProvider.signOut` tears
 * the connection down as its first act, and the thing that would do the write —
 * the `UiMetaBridge` — lives inside `ChatRuntimeProvider`, which is a child of
 * that provider and is unmounted by the same change.
 *
 * So the provider that knows when has no way to reach the object that knows how.
 * A context cannot cross that direction, and threading the bridge up through
 * `GatewayProvider` would give the connection's owner a dependency on the chat
 * layer for one line.
 *
 * This is a module-level slot instead, deliberately tiny: `ChatRuntimeProvider`
 * puts a function in it while it is mounted and takes it out when it is not, and
 * `signOut` / `changeGateway` await whatever is there before they touch the
 * socket. It is the same shape as a `beforeunload` handler and it is written
 * down here rather than discovered as a global later.
 */

type Retire = () => Promise<void>

let retire: Retire | null = null

/** Register the teardown, or clear it with `null`. Last writer wins. */
export function setPushRetire(fn: Retire | null): void {
  retire = fn
}

/**
 * Take this device out of the gateway's push section, and wait for it.
 *
 * Never rejects. A sign-out that failed because the registration could not be
 * removed would be a sign-out that did not happen, and the worse of the two
 * outcomes: the daemon going on sending to a device that has left is noise, and
 * the daemon's own receipts retire a dead address anyway.
 */
export async function retirePushRegistration(): Promise<void> {
  try {
    await retire?.()
  } catch {
    // As above.
  }
}
