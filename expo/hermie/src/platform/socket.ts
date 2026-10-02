import type { WebSocketConstructorLike } from '@hermie/gateway-client'

/**
 * React Native's global `WebSocket` accepts a third argument the DOM one does
 * not: `new WebSocket(url, protocols, { headers })`. Extra request headers are
 * how a gateway behind Cloudflare Access is reached, so the gateway client is
 * typed against that 3-argument shape and gets the constructor from here.
 *
 * Taking it off `globalThis` keeps the platform detail in one file and avoids a
 * `react-native` import inside code that also has to run under Node in tests.
 */
export const PlatformWebSocket = WebSocket as unknown as WebSocketConstructorLike
