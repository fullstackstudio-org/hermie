import Foundation
import HermieProtocol
import Observation

/// The interactive requests of one chat (`input.form`, `input.file`, `review.draft`), for its
/// screen: which request the sheet shows, how its answer is doing, and the notice left when one
/// ended without the person's answer or could not be shown.
///
/// It holds what was asked, never what is answered: the values live in the sheet's state and go
/// straight from there to `answer(_:)`. A sheet that cannot go on (a refused permission, a failed
/// upload, no camera) says so with `cannotShow(reason:)`, which answers the error the contract
/// has for it.
@MainActor
@Observable
public final class InteractiveModel {
  public let center: InteractiveRequestCenter
  /// The bot's name, which is also its chat's key.
  public let bot: String

  /// The request the sheet shows, by request id; nil when no sheet is up. It stays set after the
  /// request ends without the person's answer, so the sheet can say so until it is closed.
  public private(set) var presentedID: String?
  /// The request last shown, kept for the sheet's chrome while it says how it ended.
  public private(set) var presentedPrompt: InteractivePrompt?

  public init(center: InteractiveRequestCenter, bot: String) {
    self.center = center
    self.bot = bot
  }

  public convenience init(session: GatewaySession, bot: String) {
    self.init(center: session.interactive, bot: bot)
  }

  // MARK: - What the views read

  public var gatewayName: String { center.gatewayName }

  /// The bot's name for display: cleaned and bounded like the request's own texts, since the
  /// gateway names its bots.
  public var botName: String { SecurePrompt.displayText(bot, limit: SecurePrompt.nameLimit) }

  /// The requests still waiting, oldest first.
  public var openPrompts: [InteractivePrompt] { center.prompts(for: bot) }

  /// The oldest open request the sheet is not showing yet.
  public var nextToPresent: String? {
    presentedID == nil ? openPrompts.first?.id : nil
  }

  /// The request the sheet shows while it is open.
  public var presented: InteractivePrompt? {
    guard let presentedID else {
      return nil
    }

    return openPrompts.first { $0.id == presentedID }
  }

  /// How the shown request ended, when it ended without the person's answer.
  public var presentedOutcome: InteractiveNotice? {
    guard let presentedID, presented == nil, let entry = center.notices[bot], entry.requestID == presentedID else {
      return nil
    }

    return entry.notice
  }

  /// The chat's notice, unless the sheet is saying it already.
  public var notice: InteractiveNoticeEntry? {
    guard let entry = center.notices[bot], entry.requestID != presentedID else {
      return nil
    }

    return entry
  }

  public func phase(of id: String) -> InteractivePhase? {
    center.phases[id]
  }

  public var isSending: Bool {
    presentedID.map { center.phases[$0] == .sending } ?? false
  }

  public var hasFailed: Bool {
    presentedID.map { center.phases[$0] == .failed } ?? false
  }

  /// Whole seconds before the shown request is hidden; nil when unknown.
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

  /// Show a request in the sheet.
  public func present(_ id: String) {
    guard let prompt = openPrompts.first(where: { $0.id == id }) else {
      return
    }

    presentedID = id
    presentedPrompt = prompt
  }

  /// The sheet went away after the request ended. Not an answer: while the request is open the
  /// sheet only goes by an answer, Skip or `cannotShow`.
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

  /// Send an answer. Answers whether it went out; when it did, the sheet's request is done and
  /// the sheet closes.
  @discardableResult
  public func answer(_ answer: InteractiveAnswer) async -> Bool {
    guard let id = presentedID else {
      return false
    }

    return finish(id, await center.answer(id, answer))
  }

  /// Skip (the Skip button, Esc), for a request that offers it. Answers whether it went out.
  @discardableResult
  public func skip() async -> Bool {
    await answer(.skip)
  }

  /// The sheet cannot show the request (`reason`: `permission_denied`, `upload_failed`,
  /// `no_camera`, ...): answer the error `4041 cannot_show`. Answers whether it went out.
  @discardableResult
  public func cannotShow(reason: String) async -> Bool {
    guard let id = presentedID else {
      return false
    }

    return finish(id, await center.cannotShow(id, reason: reason))
  }

  /// Whether `answer` can answer the shown request at all (the sheet's Send button).
  public func canAnswer(_ answer: InteractiveAnswer) -> Bool {
    guard let presented, !isSending else {
      return false
    }

    return presented.reply(to: answer) != nil
  }

  private func finish(_ id: String, _ sent: Bool) -> Bool {
    if sent, presentedID == id {
      presentedID = nil
      presentedPrompt = nil
    }

    return sent
  }
}
