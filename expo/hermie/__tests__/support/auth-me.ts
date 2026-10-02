/**
 * A real `GatewayHttp` whose `/api/auth/me` answers with `body`, exactly as the
 * gateway sends it — so a test goes through the one parser the app uses
 * (`GatewayHttp.authMe`) rather than a hand-built `AuthIdentity`.
 */
import { type CredentialProvider, type FetchLike, GatewayHttp } from '@hermie/gateway-client'

/**
 * What an OIDC gateway's `/api/auth/me` answers with: the provider's BARE
 * subject as `user_id`, and `provider` as a field of its own. Invented values.
 */
export const AUTH_ME_BODY = {
  user_id: '7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40',
  email: 'alex@example.test',
  display_name: 'Alex Moreno',
  org_id: '',
  provider: 'authentik',
  expires_at: 1_790_000_000
}

/** The id the gateway stamps on a row this reader wrote: `<provider>:<user_id>`. */
export const AUTH_ME_STAMP = `${AUTH_ME_BODY.provider}:${AUTH_ME_BODY.user_id}`

const anonymous: CredentialProvider = {
  mode: 'session_token',
  httpAuthHeaders: async () => ({}),
  dialPlan: async (wsUrl: string) => ({ url: wsUrl, headers: {} }),
  onRejected: async () => 'reauth' as const,
  signOut: async () => undefined
}

export function httpAnsweringAuthMe(body: Record<string, unknown> = AUTH_ME_BODY): GatewayHttp {
  const fetchImpl = (async () => ({
    status: 200,
    ok: true,
    url: 'https://gateway.example.test/api/auth/me',
    text: async () => JSON.stringify(body),
    headers: { get: () => null }
  })) as unknown as FetchLike

  return new GatewayHttp({ baseUrl: 'https://gateway.example.test', credentials: anonymous, fetchImpl })
}
