import { namespace } from '../../src/gateway/namespace'

/**
 * A gateway id for a suite that needs one but is not about the registry.
 *
 * Every store and every credential is keyed by a gateway now, so a test that
 * hydrates one has to say which. Two of them, because "does A's value reach B"
 * is the question most of those tests are actually asking.
 */
export const GATEWAY_A = 'gaaaaaaaaaaaaaaaa'
export const GATEWAY_B = 'gbbbbbbbbbbbbbbbb'

export const NS_A = namespace(GATEWAY_A)
export const NS_B = namespace(GATEWAY_B)
