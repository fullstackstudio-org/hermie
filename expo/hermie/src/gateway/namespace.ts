/**
 * One gateway's corner of the disk.
 *
 * Before there was a list of gateways, every stored thing had exactly one
 * meaning: `hermie.auth.access_token` was THE access token, `hermie.chat.view`
 * was THE chat settings. With two gateways configured, each of those names is a
 * question with two answers, and a store that cannot tell them apart is a store
 * that hands one gateway's token to another.
 *
 * So everything gateway-specific is suffixed with the gateway's id, and it goes
 * through this one helper rather than through a suffix spelled out at each call
 * site. That is not tidiness: the migration in `migrate.ts` has to be able to
 * name every key it is moving, and a suffix somebody typed by hand in one more
 * place is a key that is left behind and then silently starts a second life as
 * "the one nobody claimed".
 *
 * **What is NOT namespaced**, and why each one:
 *
 *  - The registry itself (`hermie.gateways`). It is the thing that knows the
 *    ids; keying it by one would be circular.
 *  - The app lock (`hermie.lock`). It is about the device in somebody's hand,
 *    not about a machine on the other end of a socket, and a phone that
 *    unlocked itself by switching gateway would not be a lock.
 *  - The push installation id (`hermie.installation`). ADR-0017 keys a device's
 *    registration by an id minted once; a device that re-minted it per gateway
 *    would leave a dead registration on every gateway it ever visited.
 *  - The appearance preference (`hermie.appearance`). Light or dark is about
 *    the eyes in front of the screen. Everything else in the settings blob
 *    follows the account (ADR-0016) and is therefore namespaced with it.
 *  - The reader's own context switches (`hermie.context`). They are decisions
 *    about what this person is willing to tell a bot, and they already carry
 *    the one gateway-specific thing they have — which gateway's sharing notice
 *    was accepted — inside the value.
 *
 * **The separator is `@` and the id is hex.** Every base key here is dotted, no
 * id can contain an `@` (see `newGatewayId`), so a namespaced key splits one
 * way and only one way. That matters for the migration and for anybody reading
 * a support log.
 */

export const NAMESPACE_SEPARATOR = '@'

/**
 * The same suffix for the SECRET store, which will not accept an `@`.
 *
 * `expo-secure-store` validates every key against `/^[\w.-]+$/` and throws
 * before it reaches the keychain at all. So from the moment the registry
 * started suffixing keys, every namespaced credential write threw
 * _"Invalid key provided to SecureStore"_ — on every platform, not only on the
 * unsigned builds this was first blamed on. Onboarding could not finish, the
 * one-time move in `migrate.ts` silently carried nothing across (it catches per
 * item, which is how this stayed quiet), and the configuration written just
 * before the throw was left behind under an id nothing recorded.
 *
 * `-` rather than a cleverer escape, because the split has to stay
 * unambiguous and this is the one character that is legal there and cannot
 * appear on either side of it: every base key is dotted with underscores
 * (`hermie.auth.access_token`) and every id is `g` followed by hex.
 *
 * It is spelled HERE, beside the other one, rather than in `config.ts` or
 * inside the secret-store seam. The whole argument of this file is that a
 * suffix written down in a second place is a key that gets left behind; a
 * second suffix is not an exception to that, it is the case that most needs
 * the rule.
 */
export const SECRET_NAMESPACE_SEPARATOR = '-'

export interface GatewayNamespace {
  /** The gateway this namespace belongs to. */
  readonly id: string
  /** One stored key, scoped to that gateway. */
  key(base: string): string
  /** The same, for a key going to the secret store. See the separator above. */
  secretKey(base: string): string
}

/**
 * The namespace for one gateway.
 *
 * Takes the id rather than the record, because the only thing a key needs is
 * the id and handing a whole record around would let a caller key something by
 * an address by mistake — which is the bug this whole file exists to make
 * impossible.
 */
export function namespace(gatewayId: string): GatewayNamespace {
  return {
    id: gatewayId,
    key: (base: string) => `${base}${NAMESPACE_SEPARATOR}${gatewayId}`,
    secretKey: (base: string) => `${base}${SECRET_NAMESPACE_SEPARATOR}${gatewayId}`
  }
}

/** Split a namespaced key back into its two halves, or `null` when it is not one. */
export function splitNamespacedKey(key: string): { base: string; id: string } | null {
  const at = key.indexOf(NAMESPACE_SEPARATOR)

  return at === -1 ? null : { base: key.slice(0, at), id: key.slice(at + NAMESPACE_SEPARATOR.length) }
}
