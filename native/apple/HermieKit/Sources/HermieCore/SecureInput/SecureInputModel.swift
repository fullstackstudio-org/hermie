import Foundation
import Observation

/// The one-string prompts of one chat (`secret`, `sudo`, `vault.*`), for its
/// screen: which prompt the sheet shows, how its answer is doing, and the notice
/// left when one ended without the person's answer or could not be shown.
///
/// It holds what was asked, never what is answered: the typed value lives in the
/// sheet's state and goes straight from there to `send(_:)`.
///
/// A prompt can be put away (`later()`, and leaving the chat while its sheet is up: `leave()`). That
/// answers nothing: the gateway keeps waiting until Send, Skip or its own deadline, and the sheet does
/// not come back by itself, not even when the chat is opened again (`waiting` lists it).
@MainActor
@Observable
public final class SecureInputModel {
  public let center: SecureInputCenter
  /// The bot's name, which is also its chat's key.
  public let bot: String
  /// What the person put away, kept by the session so it outlives this chat screen.
  @ObservationIgnored public let shelf: RequestShelf

  /// The prompt the sheet shows, by request id; nil when no sheet is up. It
  /// stays set after the prompt ends without the person's answer, so the sheet
  /// can say so until it is closed.
  public private(set) var presentedID: String?
  /// The prompt last shown, kept for the sheet's chrome while it says how it ended.
  public private(set) var presentedPrompt: SecurePrompt?

  public init(center: SecureInputCenter, bot: String, shelf: RequestShelf = RequestShelf()) {
    self.center = center
    self.bot = bot
    self.shelf = shelf
  }

  public convenience init(session: GatewaySession, bot: String) {
    self.init(center: session.secureInput, bot: bot, shelf: session.requestShelf)
  }

  // MARK: - What the views read

  public var gatewayName: String { center.gatewayName }

  /// The bot's name for display: cleaned and bounded like the request's own
  /// texts, since the gateway names its bots.
  public var botName: String { SecurePrompt.displayText(bot, limit: SecurePrompt.nameLimit) }

  /// The prompts still waiting, oldest first.
  public var openPrompts: [SecurePrompt] { center.prompts(for: bot) }

  /// The oldest open prompt the sheet is not showing yet and the person has not put away.
  public var nextToPresent: String? {
    presentedID == nil ? openPrompts.first { !isPutAway($0.id) }?.id : nil
  }

  /// The prompts the person put away that are still open, oldest first.
  public var waiting: [String] {
    openPrompts.filter { isPutAway($0.id) }.map(\.id)
  }

  private func isPutAway(_ id: String) -> Bool {
    shelf.contains(id, chat: bot, kind: .secure)
  }

  /// The prompt the sheet shows while it is open.
  public var presented: SecurePrompt? {
    guard let presentedID else {
      return nil
    }

    return openPrompts.first { $0.id == presentedID }
  }

  /// How the shown prompt ended, when it ended without the person's answer.
  public var presentedOutcome: SecureInputNotice? {
    guard let presentedID, presented == nil, let entry = center.notices[bot], entry.requestID == presentedID else {
      return nil
    }

    return entry.notice
  }

  /// The chat's notice, unless the sheet is saying it already.
  public var notice: SecureInputNoticeEntry? {
    guard let entry = center.notices[bot], entry.requestID != presentedID else {
      return nil
    }

    return entry
  }

  public func phase(of id: String) -> SecureInputPhase? {
    center.phases[id]
  }

  public var isSending: Bool {
    presentedID.map { center.phases[$0] == .sending } ?? false
  }

  public var hasFailed: Bool {
    presentedID.map { center.phases[$0] == .failed } ?? false
  }

  /// Whole seconds before the gateway stops waiting for the shown prompt; nil
  /// when unknown.
  public var secondsLeft: Int? {
    presentedID.flatMap { center.secondsLeft($0) }
  }

  public var lastAnswered: AnsweredEntry? {
    guard let entry = center.lastAnswered, entry.requestID == presentedID || presentedID == nil else {
      return nil
    }

    return entry
  }

  // MARK: - The sheet

  /// Show a prompt in the sheet.
  public func present(_ id: String) {
    guard let prompt = openPrompts.first(where: { $0.id == id }) else {
      return
    }

    shelf.bringBack(id, chat: bot, kind: .secure)
    presentedID = id
    presentedPrompt = prompt
  }

  /// Later (the button, Esc): the person puts the sheet away. Not an answer, and nothing is sent: the
  /// prompt stays open at the gateway until its deadline, and the sheet does not come back for it by
  /// itself (`present(_:)` opens it again). Once the prompt has ended it is Close.
  public func later() {
    guard let presentedID, presented != nil else {
      dismiss()
      return
    }

    // Not while the answer is on its way: the sheet says how that went.
    guard !isSending else {
      return
    }

    shelf.keep(only: Set(openPrompts.map(\.id)), chat: bot, kind: .secure)
    shelf.putAway(presentedID, chat: bot, kind: .secure)
    self.presentedID = nil
    presentedPrompt = nil
  }

  /// The chat screen goes (another chat was chosen, the chat was closed): the prompt it showed is put
  /// away, as with Later, and nothing is sent.
  public func leave() {
    shelf.keep(only: Set(openPrompts.map(\.id)), chat: bot, kind: .secure)

    if let presentedID, presented != nil {
      shelf.putAway(presentedID, chat: bot, kind: .secure)
    }

    presentedID = nil
    presentedPrompt = nil
  }

  /// The sheet went away after the prompt ended. Not an answer: while the
  /// prompt is open the sheet goes by Send, Skip or Later.
  public func dismiss() {
    if let presentedID, center.notices[bot]?.requestID == presentedID {
      center.dismissNotice(bot)
    }

    presentedID = nil
    presentedPrompt = nil
  }

  public func dismissNotice() {
    center.dismissNotice(bot)
  }

  // MARK: - Answering

  /// Send what the person typed. Answers whether it went out; when it did, the
  /// sheet's prompt is done and the sheet closes.
  @discardableResult
  public func send(_ value: SecretValue, identifier: String = "", via method: DecisionMethod = .tap) async -> Bool {
    guard let id = presentedID else {
      return false
    }

    let sent = await center.send(id, value: value, identifier: identifier, via: method)

    if sent, presentedID == id {
      presentedID = nil
      presentedPrompt = nil
    }

    return sent
  }

  /// Skip: answer `''` (Skip, Esc). Answers whether it went out.
  @discardableResult
  public func skip() async -> Bool {
    guard let id = presentedID else {
      return false
    }

    let sent = await center.skip(id)

    if sent, presentedID == id {
      presentedID = nil
      presentedPrompt = nil
    }

    return sent
  }

  /// Whether `value` (and `identifier`, for a login) can answer the shown prompt.
  public func canSend(_ value: SecretValue, identifier: String = "") -> Bool {
    guard let presented, !isSending else {
      return false
    }

    return presented.answer(value, identifier: identifier) != nil
  }
}
