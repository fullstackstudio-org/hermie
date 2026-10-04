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

  /// What the person put away, kept by the session so it outlives this chat screen.
  @ObservationIgnored public let shelf: RequestShelf

  public init(center: InteractiveRequestCenter, bot: String, shelf: RequestShelf = RequestShelf()) {
    self.center = center
    self.bot = bot
    self.shelf = shelf
  }

  public convenience init(session: GatewaySession, bot: String) {
    self.init(center: session.interactive, bot: bot, shelf: session.requestShelf)
  }

  // MARK: - What the views read

  public var gatewayName: String { center.gatewayName }

  /// The bot's name for display: cleaned and bounded like the request's own texts, since the
  /// gateway names its bots.
  public var botName: String { SecurePrompt.displayText(bot, limit: SecurePrompt.nameLimit) }

  /// The requests still waiting, oldest first.
  public var openPrompts: [InteractivePrompt] { center.prompts(for: bot) }

  /// The requests the person put away with Later or by leaving the chat: still open, in the
  /// transcript, and not raised again by themselves, not even when the chat is opened again. The
  /// session's (`RequestShelf`), so a chat screen made again still knows them.
  public var putAway: Set<String> { shelf.ids(chat: bot, kind: .interactive) }

  /// The oldest open request the sheet is not showing yet and the person has not put away.
  public var nextToPresent: String? {
    let shelved = putAway
    return presentedID == nil ? openPrompts.first { !shelved.contains($0.id) }?.id : nil
  }

  /// The requests the person put away that are still open, oldest first.
  public var waiting: [String] {
    let shelved = putAway
    return openPrompts.filter { shelved.contains($0.id) }.map(\.id)
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

  /// The answer did not reach the gateway, or its verdict did not come back: Send again.
  public var hasFailed: Bool {
    presentedID.map { center.phases[$0] == .failed } ?? false
  }

  /// Why the gateway refused the shown request's last answer (`4034`, its machine reason:
  /// `field:guests:below_min`, `not_optional`, ...), while the request is still open; the sheet shows
  /// it next to the input. Nil when nothing was refused, or once the answer is sent again.
  public var refusal: String? {
    guard let presentedID, case .refused(let reason)? = center.phases[presentedID] else {
      return nil
    }

    return reason
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

  /// Show a request in the sheet (it came up, or the person opened it from its card).
  public func present(_ id: String) {
    guard let prompt = openPrompts.first(where: { $0.id == id }) else {
      return
    }

    shelf.bringBack(id, chat: bot, kind: .interactive)
    presentedID = id
    presentedPrompt = prompt
  }

  /// Later: the person puts the sheet away. Not an answer: the request stays open, in the
  /// transcript, and the sheet does not come back for it by itself (`present(_:)` opens it again).
  ///
  /// Not while an answer or an upload is on its way (`canYield`): the sheet stays until that is done,
  /// whatever asked (Esc on the Mac's pane, where no system sheet holds it back).
  public func later() {
    if presented != nil, !canYield {
      return
    }

    if let presentedID, presented != nil {
      shelf.putAway(presentedID, chat: bot, kind: .interactive)
    }

    shelf.keep(only: Set(openPrompts.map(\.id)), chat: bot, kind: .interactive)
    dismiss()
  }

  /// The chat screen goes (another chat was chosen, the chat was closed): the request its sheet
  /// showed is put away, as with Later. Nothing is answered.
  public func leave() {
    shelf.keep(only: Set(openPrompts.map(\.id)), chat: bot, kind: .interactive)

    if let presentedID, presented != nil {
      shelf.putAway(presentedID, chat: bot, kind: .interactive)
    }

    presentedID = nil
    presentedPrompt = nil
    isWorking = false
  }

  /// The sheet is doing work that must not be cut off: files are on their way (set by the file sheet).
  public private(set) var isWorking = false

  public func setWorking(_ working: Bool) {
    isWorking = working
  }

  /// The sheet is not in the middle of anything: no answer is on its way and no upload is running.
  public var canYield: Bool {
    !isWorking && !isSending
  }

  /// Something time-critical wants the screen (an approval, a confirmation, a secure prompt): the
  /// sheet steps aside without putting the request away, so it comes back by itself once the screen
  /// is free (`nextToPresent`). What was typed in it is gone, as with Later. Not while an answer or an
  /// upload is on its way (`canYield`): the approval then waits until that is done. A sheet that
  /// already says how its request ended closes, and the outcome stays as the chat's notice.
  public func yield() {
    guard presentedID != nil, canYield else {
      return
    }

    presentedID = nil
    presentedPrompt = nil
  }

  /// Where an `input.file` request's files are uploaded to.
  public var uploader: InteractiveUploader { center.uploader }

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

  /// Send an answer. Answers whether the gateway took it; when it did, the sheet's request is done
  /// and the sheet closes. A refused answer leaves the sheet up with `refusal`, one without a verdict
  /// with `hasFailed`, and one the gateway no longer waits for with `presentedOutcome`.
  @discardableResult
  public func answer(_ answer: InteractiveAnswer) async -> Bool {
    guard let id = presentedID else {
      return false
    }

    return finish(id, await center.answer(id, answer))
  }

  /// Skip (the Skip button), for a request that offers it; Esc is Later, never Skip. Answers whether
  /// the gateway took it.
  @discardableResult
  public func skip() async -> Bool {
    await answer(.skip)
  }

  /// The sheet cannot show the request (`reason`: `permission_denied`, `upload_failed`,
  /// `no_camera`, ...): answer the error `4041 cannot_show`. Answers whether it went out. With
  /// `notify` the chat keeps a notice about it once the sheet is gone (a refused permission).
  @discardableResult
  public func cannotShow(reason: String, notify: Bool = false) async -> Bool {
    guard let id = presentedID else {
      return false
    }

    return finish(id, await center.cannotShow(id, reason: reason, notify: notify))
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
