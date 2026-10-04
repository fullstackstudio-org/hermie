import Foundation
import HermieGateway
import HermieProtocol

/**
 A bot's two kinds of chat on one gateway (ADR-0007, amended 2026-09-22): the shared Bot Chat everybody
 who can reach the bot types into, and the reader's own, which nobody else reads and the bot keeps a
 separate memory of. The reader chooses per bot, the choice is remembered in their `ui_meta` app section
 (`current`, with `myChats` beside it as older builds read it) so it follows them to their other devices
 and to the other Hermie apps, and the chat opens on whichever it is.

 There is a switch only where the gateway has said who the reader is (`ownChatsAvailable`): with no
 name to write a title from there is no private chat, and nothing here changes for that gateway.
 */
extension GatewaySession {
  /// The title the reader's own chats start with, or empty while nobody is named.
  public var ownChatLead: String {
    OwnChatTitle.lead(for: ownChatIdentity)
  }

  /// This gateway has said who the reader is, so they can have chats of their own.
  public var ownChatsAvailable: Bool {
    !ownChatLead.isEmpty
  }

  /// Where the reader's memory puts this bot; always the shared chat while nobody is named.
  public func chatTarget(_ name: String) -> ChatListArrangement.Target {
    ownChatsAvailable ? arrangement.target(of: name) : .shared
  }

  var ownChats: OwnChatService {
    OwnChatService(link: link, resolver: roster.resolver)
  }

  private var nowMilliseconds: Double {
    Date().timeIntervalSince1970 * 1000
  }

  // MARK: Opening

  /**
   Open a bot's chat on the one the reader's memory names (`open(_:)` calls this).

   The chat the memory names is looked up before it is opened, because an id is an address: a chat
   that was deleted on another device, or renamed out of the reader's title family, is no longer
   theirs, and the memory of it is forgotten (as housekeeping, not a choice) rather than opened.
   A lookup that FAILS is not "gone": it throws, and the memory is kept.
   */
  func openRemembered(_ bot: Bot) async throws {
    let name = bot.name
    var memory = arrangement.target(of: name)

    // The identity may not have been read yet on a cold start; an own chat cannot be found without it.
    if memory != .shared, ownChatIdentity == nil {
      await refreshIdentity()
      memory = arrangement.target(of: name)
    }

    guard ownChatsAvailable else {
      // Nobody is named: no own chat can be found or made. One already open stays where it is.
      if let id = await store.ownChatStoredID(name) {
        try await store.showChat(name, bot: bot, own: CanonicalSession(id: id, resolvedID: id))
      } else {
        try await store.open(bot)
      }

      return
    }

    switch memory {
    case .shared:
      if await store.isOwnChat(name) {
        try await store.showChat(name, bot: bot, own: nil)
      } else {
        try await store.open(bot)
      }
    case .chat(let id):
      if await store.ownChatStoredID(name) == id {
        try await store.showChat(name, bot: bot, own: CanonicalSession(id: id, resolvedID: id))
      } else if let found = try await ownChats.lookup(profile: name, lead: ownChatLead, storedID: id) {
        try await store.showChat(name, bot: bot, own: found)
      } else {
        arrangement.setCurrent(name, nil, chore: true)
        try await store.showChat(name, bot: bot, own: nil)
      }
    case .legacy:
      // A build that kept no id chose "my chat": the bare-lead chat, found by its title.
      if let found = try await ownChats.lookup(profile: name, title: ownChatLead) {
        arrangement.setCurrent(name, found.id, chore: true)
        try await store.showChat(name, bot: bot, own: found)
      } else {
        arrangement.setCurrent(name, nil, chore: true)
        try await store.showChat(name, bot: bot, own: nil)
      }
    }
  }

  /// The chat on screen is not the one the memory names any more (another device chose, or the
  /// identity arrived after the chat opened): follow it. A refusal (a reply streaming) leaves the chat
  /// where it is; the next change tries again.
  public func followChoice(_ name: String) async {
    guard let bot = await roster.bot(named: name), await store.sessionIDs()[name] != nil else {
      return
    }

    try? await openRemembered(bot)
  }

  // MARK: Choosing

  /// The reader's own chat on this bot, or the shared one (the switch of the chat's options). Choosing
  /// their own the first time finds their chat or makes it; choosing the one a bot is on changes
  /// nothing. Throws `ConversationBusyError` while a reply streams or messages wait, and nothing is
  /// remembered for a switch that did not happen.
  public func chooseChat(_ name: String, mine: Bool) async throws {
    guard let bot = await roster.bot(named: name) else {
      throw ChatRuntimeError(message: "\(name) is not on this gateway.")
    }

    if !mine {
      try await store.showChat(name, bot: bot, own: nil)
      arrangement.setCurrent(name, nil)
      return
    }

    guard ownChatsAvailable else {
      throw ChatResolver.ResolutionError(message: OwnChatService.noIdentity)
    }

    if case .chat = arrangement.target(of: name), await store.isOwnChat(name) {
      return
    }

    try await store.assertCanLeave(name)

    let chat: CanonicalSession

    if case .chat(let id) = arrangement.target(of: name),
      let known = try await ownChats.lookup(profile: name, lead: ownChatLead, storedID: id)
    {
      chat = known
    } else {
      chat = try await ownChats.resolve(profile: name, lead: ownChatLead, parentSessionID: bot.canonical?.id)
    }

    try await store.showChat(name, bot: bot, own: chat)
    arrangement.setCurrent(name, chat.id)
  }

  /// Another chat of the reader's own on this bot, opened at once (`startOwnChat`). `label` names it;
  /// without one it carries the time it was started until the reader renames it. The chat being left
  /// is kept exactly as it is, and the Bot Chat is never touched. Refused BEFORE anything is made
  /// while the chat on screen could not be left.
  @discardableResult
  public func startOwnChat(_ name: String, label: String = "") async throws -> OwnChatService.Made {
    guard ownChatsAvailable else {
      throw ChatResolver.ResolutionError(message: OwnChatService.noIdentity)
    }

    guard let bot = await roster.bot(named: name) else {
      throw ChatRuntimeError(message: "\(name) is not on this gateway.")
    }

    try await store.assertCanLeave(name)

    let group = try await roster.resolveCanonical(bot)
    let made = try await ownChats.make(
      profile: name, lead: ownChatLead, label: label, parentSessionID: group.id, now: nowMilliseconds)

    try await store.showChat(name, bot: bot, own: made.chat)
    arrangement.setCurrent(name, made.chat.id)

    return made
  }

  /// One of the reader's own chats from the Conversations page, opened as the bot's chat.
  public func useOwnChat(_ name: String, _ chat: CanonicalSession) async throws {
    guard let bot = await roster.bot(named: name) else {
      throw ChatRuntimeError(message: "\(name) is not on this gateway.")
    }

    try await store.showChat(name, bot: bot, own: chat)
    arrangement.setCurrent(name, chat.id)
  }

  /// `/new` in an own chat: another own chat beside it. What happened is said in the chat the reader is
  /// left in, as every command's answer is; a refusal leaves them in the one they were in.
  func startOwnChat(fromCommand command: String, bot name: String, label: String) async throws {
    do {
      let made = try await startOwnChat(name, label: label)
      let shown = OwnChatTitle.label(of: made.title, lead: ownChatLead)

      await store.noteCommand(
        name, command: command,
        body: "New chat started: “\(shown)”. The one you were in is still in your chats.")
    } catch {
      await store.noteCommand(
        name, command: command,
        body:
          "The gateway would not start a new chat (\(ChatResolver.describe(error))). You are still in the one you were in."
      )
    }
  }
}
