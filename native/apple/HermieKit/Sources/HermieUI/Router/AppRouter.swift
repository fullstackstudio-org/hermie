import Foundation
import HermieShared
import Observation

/**
 One scene's navigation: which gateway and chat are selected, which sidebar section shows, what is
 pushed on the chat, which sheet is up, and what a deep link asked for (D13).

 Every transition is a plain method on plain state, so the rules are unit-tested without a view.
 A transition that needs the outside world returns `RouterEffect`s and the scene carries them out;
 the router never touches a store, so a test reads exactly what it would have done.

 ## Links

 `handle(_:)` follows `useChatLinkOpener` in the Expo app with one difference the native shell
 owes the reader: a key this device has not configured opens nothing and says so
 (`RouterNotice.gatewayNotConfigured`), instead of opening a chat of the same name on whichever
 gateway is live. A link with no key opens the chat on the live gateway. A link that arrives before
 the gateway list has been read waits in `pendingLinks` and is replayed, in order, by the first
 `gatewaysChanged(_:)`.

 Links reach the router whether or not the app is locked; what they select is drawn only after
 the lock gate opens.
 */
@MainActor
@Observable
public final class AppRouter {
  public var section: SidebarSection = .chats
  /// The live gateway as this scene shows it. Follows the registry's active gateway.
  public private(set) var selectedGatewayId: String?
  public private(set) var selectedChat: ChatRef?
  public var detailPath: [DetailRoute] = []
  public var sheet: AppSheet?
  public var notice: RouterNotice?
  /// A folder a `hermie://folder/<id>` link asked the chat list to reveal. The chat list clears it.
  public var focusedFolderId: String?
  /// Requests for the share and Shortcut tasks, in arrival order. Each consumer removes its own.
  public var pendingShares: [String] = []
  public var pendingIntents: [String] = []
  /// Bumped by the Find command; the search task watches it.
  public private(set) var findRequests = 0
  /// A search hit that was followed: the words the chat it opened is to find. The chat screen takes it
  /// and settles it (`settleFind`); see `openChat(_:finding:)`.
  public private(set) var chatFind: ChatFindRequest?
  private var lastFindID = 0

  /// Links waiting for the gateway list.
  public private(set) var pendingLinks: [DeepLink] = []
  /// nil until the gateway list has been read once.
  public private(set) var gateways: GatewayIndex?
  /// True once a link has been handled, so a restored snapshot never overrides it.
  private var linkArrived = false

  public init() {}

  public var isReady: Bool {
    gateways != nil
  }

  // MARK: Gateways

  /**
   The gateway list changed (or was read for the first time). Keeps the selection consistent with
   it, then replays any links that were waiting.
   */
  @discardableResult
  public func gatewaysChanged(_ index: GatewayIndex) -> [RouterEffect] {
    let previousActive = gateways?.activeId
    let first = gateways == nil

    gateways = index

    if first || index.activeId != previousActive || !(selectedGatewayId.map(index.contains) ?? false) {
      selectedGatewayId = index.activeId
    }

    // One live gateway at a time (ADR-0024): a chat on any other is not shown.
    if let chat = selectedChat, chat.gatewayId != selectedGatewayId || !index.contains(chat.gatewayId) {
      closeChat()
    }

    var effects: [RouterEffect] = []
    let waiting = pendingLinks

    pendingLinks = []

    for link in waiting {
      effects += handle(link)
    }

    return effects
  }

  /// Switch the live gateway from the picker or the switcher menu.
  @discardableResult
  public func switchGateway(to id: String) -> [RouterEffect] {
    guard let gateways, gateways.contains(id) else {
      return []
    }

    if id != selectedGatewayId {
      closeChat()
    }

    selectedGatewayId = id

    if sheet == .gatewayPicker {
      sheet = nil
    }

    return id == gateways.activeId ? [] : [.activateGateway(id)]
  }

  /**
   A notification about the person's own account on a gateway (`PushRoute.security`): select that
   gateway, as a chat link would, so Settings shows its account page. Presenting Settings is the
   scene's (a sheet on iPhone and iPad, the Settings window on the Mac). False when the gateway is
   not configured, and nothing changes.
   */
  public func showAccount(of gatewayId: String) -> (shown: Bool, effects: [RouterEffect]) {
    guard let gateways, gateways.contains(gatewayId) else {
      return (false, [])
    }

    if gatewayId != selectedGatewayId {
      closeChat()
    }

    selectedGatewayId = gatewayId

    return (true, gatewayId == gateways.activeId ? [] : [.activateGateway(gatewayId)])
  }

  // MARK: Chats

  public func openChat(_ chat: ChatRef) {
    if chat != selectedChat {
      detailPath = []
    }

    // A search hit's words belong to the chat the hit named: another chat that opens first drops them,
    // so they are not found in it when that chat is opened later.
    if chatFind?.chat != chat {
      chatFind = nil
    }

    selectedChat = chat
    section = .chats
  }

  /// Open the chat of a message search hit and ask it to show the newest row holding `words`. The
  /// request is left for that chat's screen, which may not exist yet (it is made when the chat opens)
  /// or may be on screen already (a hit for the chat that is open changes no selection).
  public func openChat(_ chat: ChatRef, finding words: String) {
    openChat(chat)

    let query = words.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !query.isEmpty else {
      chatFind = nil
      return
    }

    lastFindID += 1
    chatFind = ChatFindRequest(id: lastFindID, chat: chat, query: query)
  }

  /// The chat dealt with a request (found the row, or said it could not). A newer one is left alone.
  public func settleFind(_ id: Int) {
    if chatFind?.id == id {
      chatFind = nil
    }
  }

  public func closeChat() {
    selectedChat = nil
    detailPath = []
    chatFind = nil
  }

  /// The selection as a list binding writes it: nil closes, anything else opens.
  public func select(_ chat: ChatRef?) {
    if let chat {
      openChat(chat)
    } else {
      closeChat()
    }
  }

  /// Something of this router's stands over `chat`'s screen: a page pushed on it, or a sheet. A
  /// chat this router does not show (another window's) is never covered by it.
  public func covers(_ chat: ChatRef) -> Bool {
    selectedChat == chat && (!detailPath.isEmpty || sheet != nil)
  }

  public func push(_ route: DetailRoute) {
    detailPath.append(route)
  }

  /// Open a bot's settings: its chat is selected, as a row's tap would, and the settings page is
  /// pushed over it (once: asking again while they are showing changes nothing).
  public func showBotSettings(_ chat: ChatRef) {
    openChat(chat)

    if detailPath.last != .botProfile(chat) {
      detailPath.append(.botProfile(chat))
    }
  }

  /// Open a bot's Conversations page over its chat (once: asking again while it is showing
  /// changes nothing).
  public func showConversations(_ chat: ChatRef) {
    openChat(chat)

    if detailPath.last != .sessions(chat) {
      detailPath.append(.sessions(chat))
    }
  }

  /// Open one conversation of the bot's in the read-only viewer, over the Conversations page.
  public func showConversation(_ chat: ChatRef, id: String, resolvedID: String, title: String) {
    detailPath.append(.conversation(chat, id: id, resolvedID: resolvedID, title: title))
  }

  /// Back to the chat itself: every page pushed on it is closed.
  public func showChat() {
    detailPath = []
  }

  /// Close the page on top of the chat, back to the one under it.
  public func pop() {
    if !detailPath.isEmpty {
      detailPath.removeLast()
    }
  }

  public func requestFind() {
    findRequests += 1
  }

  // MARK: Sheets

  public func present(_ next: AppSheet) {
    sheet = next
  }

  public func dismissSheet() {
    sheet = nil
  }

  /// Close `expected` when it is still the sheet up: a flow that finishes late (setup taking
  /// gateways from iCloud, a sign-in) must not close a sheet that replaced it meanwhile.
  public func dismissSheet(_ expected: AppSheet) {
    if sheet == expected {
      sheet = nil
    }
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: Links

  /// A `hermie://` URL from the system. Anything that is not one of the four shapes is ignored.
  @discardableResult
  public func handle(url: URL) -> [RouterEffect] {
    guard let link = DeepLink(url: url) else {
      return []
    }

    return handle(link)
  }

  @discardableResult
  public func handle(_ link: DeepLink) -> [RouterEffect] {
    linkArrived = true

    guard let gateways else {
      pendingLinks.append(link)
      return []
    }

    switch link {
    case let .chat(bot, key):
      guard !gateways.isEmpty else {
        notice = .noGatewayYet
        return []
      }

      let target: String?

      if key.isEmpty {
        target = selectedGatewayId ?? gateways.activeId
      } else {
        target = gateways.id(forKey: key)
      }

      guard let target else {
        notice = .gatewayNotConfigured
        return []
      }

      selectedGatewayId = target
      openChat(ChatRef(gatewayId: target, bot: bot))

      // The chat should be visible: a settings sheet or the picker would cover it. Setup and
      // sign-in are left alone; they are a task the reader is in the middle of.
      if sheet == .settings || sheet == .gatewayPicker {
        sheet = nil
      }

      return target == gateways.activeId ? [] : [.activateGateway(target)]

    case let .folder(id):
      section = .chats
      focusedFolderId = id
      return []

    case let .share(id):
      pendingShares.append(id)
      return []

    case let .intent(id):
      pendingIntents.append(id)
      return []
    }
  }

  // MARK: Restoration

  public var snapshot: RouterSnapshot {
    RouterSnapshot(section: section, selectedChat: selectedChat, detailPath: detailPath)
  }

  /**
   Bring back what the scene showed last time. Ignored once a link has arrived, which always wins.
   A chat on a gateway that is gone, or not the live one, is dropped as soon as the list is known.
   */
  public func restore(_ snapshot: RouterSnapshot) {
    guard !linkArrived else {
      return
    }

    section = snapshot.section
    selectedChat = snapshot.selectedChat
    detailPath = snapshot.selectedChat == nil ? [] : snapshot.detailPath

    if let gateways, let chat = selectedChat, chat.gatewayId != gateways.activeId || !gateways.contains(chat.gatewayId) {
      closeChat()
    }
  }
}
