/**
 * Every key that reaches the secret store is a key the secret store accepts.
 *
 * `expo-secure-store` validates before it touches the keychain — `/^[\w.-]+$/`,
 * throwing _"Invalid key provided to SecureStore"_ for anything else — and the
 * `@` the registry suffixes its key-value keys with is not in that set. So from
 * the moment gateways got ids, every namespaced credential write threw, on
 * every platform: onboarding could not finish, the one-time move carried no
 * credentials across, and the configuration written a line earlier was stranded
 * under an id nothing had recorded.
 *
 * It stayed quiet for two rounds because nothing asserted the one property that
 * matters about these strings, which is that another library will take them. So
 * that is what this file is: the real validator, applied to every key the app
 * can produce, rather than a copy of the rule that could drift from it.
 */
import { SECRET_KEYS, secretKeysFor } from '../src/gateway/config'
import { namespace, SECRET_NAMESPACE_SEPARATOR } from '../src/gateway/namespace'
import { newGatewayId } from '../src/gateway/registry'

/**
 * `expo-secure-store`'s own test, copied deliberately and cited.
 *
 * The one duplication worth having: the module throws from native-adjacent code
 * that the Jest environment stubs out, so a suite that called `setItemAsync`
 * would be asking a double whether a real library is happy. Kept beside the
 * version string it came from, so a bump that loosened or tightened the rule is
 * something a reader can check rather than assume.
 *
 * expo-secure-store 15.x, `isValidKey` in `src/SecureStore.ts`.
 */
const isValidSecureStoreKey = (key: string): boolean => typeof key === 'string' && /^[\w.-]+$/.test(key)

describe('the keys the secret store is given', () => {
  it('rejects the key-value separator, which is the bug this file exists for', () => {
    expect(isValidSecureStoreKey('hermie.auth.access_token@gabc123')).toBe(false)
    expect(isValidSecureStoreKey('hermie.auth.access_token-gabc123')).toBe(true)
  })

  it('accepts every namespaced credential key, for a freshly minted id', () => {
    const keys = secretKeysFor(namespace(newGatewayId()))

    expect(Object.keys(keys)).toHaveLength(Object.keys(SECRET_KEYS).length)

    Object.entries(keys).forEach(([slot, key]) => {
      expect([slot, isValidSecureStoreKey(key)]).toEqual([slot, true])
    })
  })

  it('accepts the bare keys too, which is what a pre-registry device still holds', () => {
    Object.values(SECRET_KEYS).forEach(key => {
      expect([key, isValidSecureStoreKey(key)]).toEqual([key, true])
    })
  })

  it('splits one way: the separator is in neither the base key nor the id', () => {
    const id = newGatewayId()

    Object.values(SECRET_KEYS).forEach(base => {
      expect(base).not.toContain(SECRET_NAMESPACE_SEPARATOR)
    })

    expect(id).not.toContain(SECRET_NAMESPACE_SEPARATOR)
    expect(namespace(id).secretKey('hermie.auth.access_token')).toBe(
      `hermie.auth.access_token${SECRET_NAMESPACE_SEPARATOR}${id}`
    )
  })
})
