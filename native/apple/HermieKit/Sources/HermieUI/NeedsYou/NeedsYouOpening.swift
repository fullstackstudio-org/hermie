import HermieCore
import HermieShared

/// Where a tap on a row of the "Needs you" list leads.
@MainActor
enum NeedsYouOpening {
  /// The link that opens the request's chat: the same one a tap on its notification follows
  /// (`PushPayload`), so a row and a banner end in the same place.
  static func link(for item: NeedsYouItem) -> DeepLink {
    .chat(bot: item.bot, gatewayKey: item.gatewayKey)
  }

  /**
   Open the chat the request is in, with its sheet up: a request the person had put away (Later,
   Esc) comes up again because they asked for it. The list's own sheet goes first, since it would
   stand over the chat.

   - Parameters:
     - bringBack: takes the request off the session's shelf (`LiveWiring.bringBack`).
     - activate: what the router asks for when the chat is on another gateway than the live one.
   */
  static func open(
    _ item: NeedsYouItem,
    in router: AppRouter,
    bringBack: (_ gatewayKey: String, _ bot: String, _ requestId: String) -> Void,
    activate: ([RouterEffect]) -> Void
  ) {
    bringBack(item.gatewayKey, item.bot, item.requestId)

    if router.sheet == .needsYou {
      router.dismissSheet()
    }

    activate(router.handle(link(for: item)))
  }
}
