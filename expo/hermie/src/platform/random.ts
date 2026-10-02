import type { RandomBytes } from '@hermie/gateway-client'
import * as Crypto from 'expo-crypto'

/**
 * Cryptographically strong random bytes for PKCE.
 *
 * `@hermie/gateway-client` takes entropy as a function so it can stay free of
 * React Native, and this is the app's answer: `expo-crypto`, which is a native
 * module on both platforms and therefore present whenever the app itself is.
 *
 * It used to probe the module once and fall back to the runtime's own
 * `crypto.getRandomValues`, because on macOS `expo-crypto` linked without any
 * guarantee that it ran. That platform is gone (ADR-0011) and the fallback with
 * it: a missing native module is now a build failure, not something a sign-in
 * has to survive.
 */
export const randomBytes: RandomBytes = length => Crypto.getRandomBytes(length)
