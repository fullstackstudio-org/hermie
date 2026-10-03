/**
 * The server requests only the desktop app can answer: its in-app browser
 * preview (`preview.act`, `preview.read`), its terminal (`terminal.read`), the
 * window below it (`window.read`) and its guided tour (`tour`).
 *
 * A browser has none of these, so it says no at once, the way the native apps
 * do: a JSON-RPC `-32601` with the same message (`GatewayConnection+Channel.swift`,
 * `unsupportedMessage`), so the gateway stops waiting instead of holding the bot
 * for the request's whole deadline. Saying no is not enough on its own: the bot
 * stalls on it, so the chat gets one notice that names what was asked
 * (`SecureInputModel`, which routes it to its chat).
 */
import { JSON_RPC_METHOD_NOT_FOUND, type ServerRequest } from '@hermes/shared/json-rpc-channel'

/** The requests this page declines because they need the desktop app. */
export const UNSUPPORTED_METHODS: ReadonlySet<string> = new Set([
  'preview.act',
  'preview.read',
  'terminal.read',
  'window.read',
  'tour'
])

export const isUnsupportedMethod = (method: string): boolean => UNSUPPORTED_METHODS.has(method)

/** The error code a declined request is answered with: JSON-RPC "method not found". */
export const UNSUPPORTED_CODE = JSON_RPC_METHOD_NOT_FOUND

/** The `-32601` message, the native apps' word for word. */
export const unsupportedMessage = (method: string): string => `not supported by this client: ${method}`

/** Answer `request` with the error. Idempotent on the wire: the channel sends a request's first answer only. */
export function declineUnsupported(request: Pick<ServerRequest, 'method' | 'fail'>): void {
  request.fail(UNSUPPORTED_CODE, unsupportedMessage(request.method))
}
