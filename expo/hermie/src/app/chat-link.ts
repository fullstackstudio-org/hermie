/**
 * `hermie://chat/<bot>?gateway=<key>`, resolved against the list of gateways.
 *
 * `useHermieLink` in `platform/deep-link.ts` is deliberately ignorant of
 * gateways: it parses a URL and hands over what it found, which keeps every way
 * a link can be malformed a table in a test. This is the half that knows what
 * the app should DO about the key, and it lives here rather than as a line in
 * each shell so that the two shells cannot drift apart on the question — they
 * each dispatch the four link kinds themselves, because what a share, a
 * Shortcut or a folder means differs between a phone stack and a sidebar, but
 * the chat kind goes through this one function in both.
 *
 * The rule is the same one a push tap follows: a key can only SELECT a gateway
 * the owner has already configured. A link with no key, a key this device does
 * not recognise, or the key of the gateway that is already live all open the
 * chat where the reader already is — which is also what every build before this
 * one did with every link.
 */
import { gatewayForKey, useGateway } from '../gateway'

/**
 * A function that opens the chat a link names, switching gateway first where it
 * names one.
 *
 * `open` is called AFTER the switch, and on the far side of a teardown: the
 * shell that receives it is the one mounted over the new connection. A switch
 * that fails leaves the app where it was and the chat is opened there, which is
 * the honest outcome — the reader asked for a conversation, and the one on
 * screen is the only one this app can currently show them.
 *
 * The returned function is deliberately NOT memoised: `useHermieLink` reads its
 * handler through a ref it refreshes on every render, so a fresh closure costs
 * nothing and a stale registry would cost a link.
 */
export function useChatLinkOpener(open: (bot: string) => void): (bot: string, gatewayKey: string) => void {
  const { gatewayId, registry, switchGateway } = useGateway()

  return (bot, gatewayKey) => {
    const target = gatewayForKey(registry, gatewayKey)

    if (!target || target.id === gatewayId) {
      open(bot)

      return
    }

    void switchGateway(target.id).then(() => open(bot))
  }
}
