import Foundation
import HermieCore
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
  /// The cron the Crons section has open in the detail column; nil shows the "pick one" state. Not
  /// restored with the scene: a relaunch opens the list, not a cron.
  public private(set) var selectedCron: CronRef?
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
  /// A search hit in one of a bot's other conversations that was followed: the words the viewer it
  /// opened is to find. The viewer takes it and settles it (`settleConversationFind`).
  public private(set) var conversationFind: ConversationFindRequest?
  /// A chat a `hermie://ask/<bot>` link (the Action button, the control, Siri) asked to have its
  /// composer focused. The chat screen takes it and settles it (`settleCompose`).
  public private(set) var composeRequest: ComposeRequest?
  /// The words the next search sheet starts with (the chat list's field, handed on).
  public var searchSeed = ""
  /// The gateway the person agreed to add (`confirmPairing`): the setup that opens next fills it in and
  /// goes straight to sign-in. Cleared when that setup ends.
  public private(set) var pairingOffer: GatewayPairingOffer?
  /// An offer that arrived while setup, a sign-in or the emergency stop was up: shown once that sheet is gone.
  public private(set) var queuedPairing: GatewayPairingOffer?
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

    // A cron belongs to one gateway, like a chat does.
    if let cron = selectedCron, cron.gatewayId != selectedGatewayId || !index.contains(cron.gatewayId) {
      closeCron()
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
      closeCron()
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

    if conversationFind?.chat != chat {
      conversationFind = nil
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

  /// The conversation viewer dealt with a request (found the row, or said it could not). A newer one is
  /// left alone.
  public func settleConversationFind(_ id: Int) {
    if conversationFind?.id == id {
      conversationFind = nil
    }
  }

  public func closeChat() {
    selectedChat = nil
    detailPath = []
    chatFind = nil
    conversationFind = nil
    composeRequest = nil
  }

  /// The chat dealt with a compose request (put the caret in its field). A newer one is left alone.
  public func settleCompose(_ id: Int) {
    if composeRequest?.id == id {
      composeRequest = nil
    }
  }

  /**
   Open a chat the quick ask asked for ("Open in Hermie"): as a chat link does, which is why it waits
   for the gateway list, wins over a restored selection, and makes its gateway the live one. The
   quick ask only knows the gateway by its registry id, so the link carries the key of that gateway.
   A gateway this device no longer has opens nothing and says so.
   */
  @discardableResult
  public func openFromQuickAsk(_ chat: ChatRef) -> [RouterEffect] {
    var key = ""

    if let gateways {
      guard let entry = gateways.entries.first(where: { $0.id == chat.gatewayId }) else {
        notice = .gatewayNotConfigured
        return []
      }

      key = entry.key
    }

    return handle(.chat(bot: chat.bot, gatewayKey: key))
  }

  // MARK: Search results

  /**
   Follow a search result: select its gateway, open its bot's chat, and ask the screen that shows the
   conversation to find the row the words are in.

   The bot's own chat gets `openChat(_:finding:)`. Any other conversation is read in the viewer, pushed
   over the bot's Conversations page (so the viewer's way back names a page that is there) with a
   request for the viewer to find the words. A result on a gateway that is not the live one makes it the
   live one first (`RouterEffect.activateGateway`), as a chat link does, and what was open there is
   closed; the request waits in the router for the screen the new session builds.

   A gateway this device no longer has opens nothing and says so (`RouterNotice.gatewayNotConfigured`).
   */
  @discardableResult
  public func openSearchResult(_ destination: SearchDestination, finding words: String) -> [RouterEffect] {
    guard let gateways, gateways.contains(destination.gatewayID) else {
      notice = .gatewayNotConfigured
      return []
    }

    let chat = ChatRef(gatewayId: destination.gatewayID, bot: destination.bot)

    if destination.gatewayID != selectedGatewayId {
      closeChat()
      closeCron()
    }

    selectedGatewayId = destination.gatewayID

    switch destination.target {
    case .botChat:
      openChat(chat, finding: words)
    case let .conversation(id, resolvedID, title):
      openChat(chat, finding: "")
      openConversation(chat, id: id, resolvedID: resolvedID, title: title, finding: words)
    }

    // The result should be visible: a sheet (the search itself, settings, the picker) would cover it.
    // Setup and sign-in are left alone; they are a task the reader is in the middle of.
    if sheet == .search || sheet == .settings || sheet == .gatewayPicker {
      sheet = nil
    }

    return destination.gatewayID == gateways.activeId ? [] : [.activateGateway(destination.gatewayID)]
  }

  /// Open one conversation of the bot's in the viewer, under its Conversations page, and ask it to find
  /// `words` when there are any.
  private func openConversation(_ chat: ChatRef, id: String, resolvedID: String, title: String, finding words: String) {
    detailPath = [.sessions(chat), .conversation(chat, id: id, resolvedID: resolvedID, title: title)]

    let query = words.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !query.isEmpty else {
      conversationFind = nil
      return
    }

    lastFindID += 1
    conversationFind = ConversationFindRequest(id: lastFindID, chat: chat, conversationID: id, query: query)
  }

  // MARK: Crons

  /// Open a cron in the detail column.
  public func openCron(_ cron: CronRef) {
    selectedCron = cron
    section = .routines
  }

  public func closeCron() {
    selectedCron = nil
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

  /// Open a bot's Vault page over its chat (once: asking again while it is showing changes nothing).
  public func showVault(_ chat: ChatRef) {
    openChat(chat)

    if detailPath.last != .vault(chat) {
      detailPath.append(.vault(chat))
    }
  }

  /// Open one conversation of the bot's in the read-only viewer, over the Conversations page.
  public func showConversation(_ chat: ChatRef, id: String, resolvedID: String, title: String) {
    detailPath.append(.conversation(chat, id: id, resolvedID: resolvedID, title: title))
  }

  /// Back to the chat itself: every page pushed on it is closed.
  public func showChat() {
    detailPath = []
    conversationFind = nil
  }

  /// Close the page on top of the chat, back to the one under it.
  public func pop() {
    if !detailPath.isEmpty {
      detailPath.removeLast()
    }

    // A request for a viewer that is no longer there is not left for the next one.
    if !detailPath.contains(where: { if case .conversation = $0 { true } else { false } }) {
      conversationFind = nil
    }
  }

  public func requestFind() {
    findRequests += 1
  }

  /// Open the search over every conversation, starting with `seed` (the words already typed in the chat
  /// list's field).
  public func presentSearch(seed: String = "") {
    searchSeed = seed
    sheet = .search
  }

  // MARK: Sheets

  public func present(_ next: AppSheet) {
    sheet = next
    sheetChanged()
  }

  public func dismissSheet() {
    sheet = nil
    sheetChanged()
  }

  /// Close `expected` when it is still the sheet up: a flow that finishes late (setup taking
  /// gateways from iCloud, a sign-in) must not close a sheet that replaced it meanwhile.
  public func dismissSheet(_ expected: AppSheet) {
    if sheet == expected {
      sheet = nil
      sheetChanged()
    }
  }

  /**
   The sheet changed, by any road (the system closing it included; the shell calls this on every change).
   An offer that setup took is spent once setup is not the sheet any more, dismissed or replaced, so it
   cannot fill in a later setup; and an offer that waited behind a protected sheet is shown now.
   */
  public func sheetChanged() {
    if case .onboarding = sheet {
    } else {
      pairingOffer = nil
    }

    if sheet == nil, let offer = queuedPairing {
      queuedPairing = nil
      sheet = .pairing(offer)
    }
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: Links

  /// A `hermie://` URL from the system. Anything that is not one of its shapes is ignored.
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
      return openChatLink(bot: bot, key: key, gateways: gateways, composing: false)

    case let .ask(bot, key):
      return openChatLink(bot: bot, key: key, gateways: gateways, composing: true)

    case let .conversation(bot, session, key):
      guard !gateways.isEmpty else {
        notice = .noGatewayYet
        return []
      }

      let target = key.isEmpty ? (selectedGatewayId ?? gateways.activeId) : gateways.id(forKey: key)

      guard let target else {
        notice = .gatewayNotConfigured
        return []
      }

      // A link carries no title or words: the viewer reads the conversation under its id.
      return openSearchResult(
        SearchDestination(
          gatewayID: target, bot: bot, target: .conversation(id: session, resolvedID: session, title: "")),
        finding: "")

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

    case .addGateway:
      // An offer, never an add: what it names is shown, and the person decides.
      switch GatewayPairingOffer.offer(from: link) {
      case .success(let offer):
        presentPairing(offer)
      case .failure(let problem):
        notice = .pairingRefused(problem)
      }

      return []
    }
  }

  /**
   A chat link: select its gateway and open the bot's chat, asking for the caret in the composer when
   the link is an `ask` one. The chat should be visible: a settings sheet or the picker would cover it.
   Setup and sign-in are left alone; they are a task the reader is in the middle of.
   */
  private func openChatLink(bot: String, key: String, gateways: GatewayIndex, composing: Bool) -> [RouterEffect] {
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

    let chat = ChatRef(gatewayId: target, bot: bot)

    selectedGatewayId = target
    openChat(chat)

    if composing {
      // Over a page pushed on the chat (settings, conversations) the field would not be on screen.
      showChat()
      lastFindID += 1
      composeRequest = ComposeRequest(id: lastFindID, chat: chat)
    }

    if sheet == .settings || sheet == .gatewayPicker {
      sheet = nil
    }

    return target == gateways.activeId ? [] : [.activateGateway(target)]
  }

  // MARK: Handoff

  /**
   The link another device of the same Apple ID continues from (`HandoffActivity`): the chat that is
   open, or the conversation viewer over it. nil with no chat open, before the gateway list is read,
   for a chat on a gateway this device has no key for, and while the Crons section shows a cron
   instead of the chat (the chat is still selected under it, but it is not what is on screen).
   */
  public var handoffLink: DeepLink? {
    guard !(section == .routines && selectedCron != nil), let chat = selectedChat,
      let entry = gateways?.entries.first(where: { $0.id == chat.gatewayId })
    else {
      return nil
    }

    // A conversation whose id is not in the link's alphabet cannot be named: the chat is.
    if case let .conversation(_, id, _, _)? = detailPath.last {
      let conversation = DeepLink.conversation(bot: chat.bot, session: id, gatewayKey: entry.key)

      if conversation.string != nil {
        return conversation
      }
    }

    return .chat(bot: chat.bot, gatewayKey: entry.key)
  }

  // MARK: Pairing

  /**
   Show an offered gateway for the person to take or leave. A link can come from anybody at any time,
   so it does not take over what the person is in the middle of: while setup, a sign-in or the
   emergency stop is up the offer waits (the newest one, if several come) and is shown when that sheet
   is gone, as a chat link leaves setup and sign-in alone. Anything else it replaces, as a chat link does.
   */
  public func presentPairing(_ offer: GatewayPairingOffer) {
    switch sheet {
    case .onboarding?, .signIn?, .emergencyStop?:
      queuedPairing = offer
    default:
      queuedPairing = nil
      sheet = .pairing(offer)
    }
  }

  /// The person took the offer: setup opens for a new gateway, fills it in and goes on to sign-in.
  public func confirmPairing(_ offer: GatewayPairingOffer) {
    pairingOffer = offer
    sheet = .onboarding((gateways?.isEmpty ?? true) ? .firstGateway : .additionalGateway)
  }

  /// Setup ended: the offer it took is spent.
  public func clearPairing() {
    pairingOffer = nil
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
