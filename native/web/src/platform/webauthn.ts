/**
 * The browser's passkey ceremonies and its SHA-256, for `core/passkey`.
 *
 * `navigator.credentials.create/get` and `crypto.subtle` are reached here and
 * nowhere else, so the passkey model runs in a test with a software
 * authenticator in their place. The model computes every challenge itself and
 * hands over the 32 bytes: an authenticator never sees the text it commits to,
 * and never chooses what it signs.
 *
 * The rules every implementation of `WebAuthnSeam` keeps (the native apps'
 * `PasskeyAuthenticator`):
 *
 *  - one ceremony at a time; a second call while one runs fails `busy`;
 *  - an assertion is always restricted to the credential ids it is given, which
 *    are never empty (an unfiltered sheet would list the person's passkeys of
 *    every site);
 *  - user verification is required and attestation is `none`;
 *  - the person closing the browser's sheet is `cancelled`, and so is `cancel()`
 *    (the gateway withdrew the request): nothing is sent to the gateway;
 *  - nothing it receives or returns is logged.
 *
 * The RP is the page's own hostname (contract §10: a web RP is the exact host of
 * the gateway's base URL, never the registrable domain), and the level is only
 * offered in a secure context.
 */
import type { Sha256 } from '../core/passkey/challenge'

/** What a registration ceremony is asked to create. */
export interface RegistrationCeremony {
  rpId: string
  challenge: Uint8Array
  /** The gateway's user handle for the signed-in user (`user.handle`). */
  userHandle: Uint8Array
  /** The credential's name, built by the client (`<display name> — <host>`), which the browser shows. */
  name: string
  /** Credentials the person already has for this RP on this gateway: the authenticator refuses a second. */
  excludeCredentialIds: readonly Uint8Array[]
}

export interface RegistrationResult {
  credentialId: Uint8Array
  clientDataJSON: Uint8Array
  attestationObject: Uint8Array
  transports: string[]
}

/** What an assertion ceremony is asked to sign. */
export interface AssertionCeremony {
  rpId: string
  challenge: Uint8Array
  /** Never empty. */
  allowCredentialIds: readonly Uint8Array[]
}

export interface AssertionResult {
  credentialId: Uint8Array
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
  /** ASN.1 DER ECDSA. */
  signature: Uint8Array
  userHandle: Uint8Array | null
}

/** Why a ceremony produced nothing. */
export type CeremonyProblem =
  /** The person closed the browser's sheet, it timed out, or `cancel()` ended it. Nothing is sent. */
  | { kind: 'cancelled' }
  /** Another ceremony is running. */
  | { kind: 'busy' }
  /** Registration: this authenticator already holds a passkey of this account for this gateway. */
  | { kind: 'exists' }
  /** The ceremony cannot run here (`reason` is the 4040 reason sent to the gateway). */
  | { kind: 'unavailable'; reason: string }
  /** Anything else the browser reported; the text is for the person's "try again". */
  | { kind: 'failed'; message: string }

export class CeremonyError extends Error {
  constructor(readonly problem: CeremonyProblem) {
    super(problem.kind === 'failed' ? problem.message : problem.kind)
    this.name = 'CeremonyError'
  }
}

export interface WebAuthnSeam {
  /** A secure context with the WebAuthn API: without both, the level is never advertised. */
  readonly available: boolean
  /** The page's hostname: the RP id of every ceremony. */
  readonly rpId: string
  readonly sha256: Sha256
  create(request: RegistrationCeremony): Promise<RegistrationResult>
  get(request: AssertionCeremony): Promise<AssertionResult>
  /** End the running ceremony, if any (as `cancelled`). */
  cancel(): void
}

/** How long the browser's sheet may stay up, in milliseconds: the gateway's own deadline. */
export const CEREMONY_TIMEOUT_MS = 120_000

/** The parts of the page the seam reads, so a test can hand in its own. */
export interface WebAuthnEnvironment {
  credentials: Pick<CredentialsContainer, 'create' | 'get'> | null
  subtle: Pick<SubtleCrypto, 'digest'> | null
  hostname: string
  secure: boolean
}

function pageEnvironment(): WebAuthnEnvironment {
  const secure = typeof window !== 'undefined' && window.isSecureContext === true
  const hasApi =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.get === 'function'

  return {
    credentials: hasApi ? navigator.credentials : null,
    subtle: typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null,
    hostname: typeof location !== 'undefined' ? location.hostname : '',
    secure
  }
}

/** A fresh `ArrayBuffer` with the bytes: what `BufferSource` wants, never a view of somebody else's buffer. */
const buffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.length)

  new Uint8Array(copy).set(bytes)

  return copy
}

const bytesOf = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value.slice(0))
    : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))

/** What a rejected `navigator.credentials` call means. */
export function problemOf(error: unknown, registration: boolean): CeremonyProblem {
  const name = (error as { name?: unknown } | null)?.name

  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return { kind: 'cancelled' }
    case 'InvalidStateError':
      return registration ? { kind: 'exists' } : { kind: 'failed', message: String((error as Error).message) }
    case 'SecurityError':
    case 'NotSupportedError':
      // The page's host is not a valid RP here (an IP address, a scheme the browser will not use).
      return { kind: 'unavailable', reason: 'rp_not_configured' }
    default:
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

export function createWebAuthn(environment: WebAuthnEnvironment = pageEnvironment()): WebAuthnSeam {
  let running: AbortController | null = null

  const sha256: Sha256 = async data => {
    if (!environment.subtle) {
      throw new CeremonyError({ kind: 'unavailable', reason: 'rp_not_configured' })
    }

    return new Uint8Array(await environment.subtle.digest('SHA-256', buffer(data)))
  }

  /** Run one ceremony: one at a time, cancellable, every rejection mapped to a `CeremonyProblem`. */
  async function ceremony<T>(registration: boolean, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!environment.credentials || !environment.secure) {
      throw new CeremonyError({ kind: 'unavailable', reason: 'rp_not_configured' })
    }

    if (running) {
      throw new CeremonyError({ kind: 'busy' })
    }

    const controller = new AbortController()

    running = controller

    try {
      return await run(controller.signal)
    } catch (error) {
      throw error instanceof CeremonyError ? error : new CeremonyError(problemOf(error, registration))
    } finally {
      if (running === controller) {
        running = null
      }
    }
  }

  return {
    available: environment.secure && environment.credentials !== null && environment.subtle !== null,
    rpId: environment.hostname,
    sha256,

    create: request =>
      ceremony(true, async signal => {
        const credential = (await environment.credentials?.create({
          signal,
          publicKey: {
            rp: { id: request.rpId, name: request.rpId },
            user: { id: buffer(request.userHandle), name: request.name, displayName: request.name },
            challenge: buffer(request.challenge),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            excludeCredentials: request.excludeCredentialIds.map(id => ({ type: 'public-key', id: buffer(id) })),
            authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
            attestation: 'none',
            timeout: CEREMONY_TIMEOUT_MS
          }
        })) as PublicKeyCredential | null

        if (!credential) {
          throw new CeremonyError({ kind: 'cancelled' })
        }

        const response = credential.response as AuthenticatorAttestationResponse

        return {
          credentialId: bytesOf(credential.rawId),
          clientDataJSON: bytesOf(response.clientDataJSON),
          attestationObject: bytesOf(response.attestationObject),
          transports: typeof response.getTransports === 'function' ? response.getTransports() : []
        }
      }),

    get: request =>
      ceremony(false, async signal => {
        if (request.allowCredentialIds.length === 0) {
          throw new CeremonyError({ kind: 'unavailable', reason: 'no_credential' })
        }

        const credential = (await environment.credentials?.get({
          signal,
          publicKey: {
            rpId: request.rpId,
            challenge: buffer(request.challenge),
            allowCredentials: request.allowCredentialIds.map(id => ({ type: 'public-key', id: buffer(id) })),
            userVerification: 'required',
            timeout: CEREMONY_TIMEOUT_MS
          }
        })) as PublicKeyCredential | null

        if (!credential) {
          throw new CeremonyError({ kind: 'cancelled' })
        }

        const response = credential.response as AuthenticatorAssertionResponse

        return {
          credentialId: bytesOf(credential.rawId),
          authenticatorData: bytesOf(response.authenticatorData),
          clientDataJSON: bytesOf(response.clientDataJSON),
          signature: bytesOf(response.signature),
          userHandle: response.userHandle ? bytesOf(response.userHandle) : null
        }
      }),

    cancel() {
      running?.abort()
    }
  }
}
