import Foundation
import HermieProtocol
import HermieTranscript
import Observation

/// Where the reader's answer to one request is.
public enum RequestPhase: Sendable, Equatable {
  /// On its way: re-validated, then sent. The card's controls are off.
  case sending
  /// It did not go out. The question is still open; `retry` sends it again.
  /// `reason` is the gateway's error, or nil when the answer never left the
  /// device: the socket that delivered the question is gone, and
  /// `ChatModel.cardNotices` holds the card's notice.
  case failed(reason: String?)
}

/// An answer, kept so a failed one can be sent again as it was.
public enum RequestAnswerDraft: Sendable, Equatable {
  case approval(choice: String)
  case clarify(answers: [String: String])
}

/// A short line about a request that ended without the reader's answer.
public enum RequestNotice: Sendable, Equatable {
  /// The gateway no longer waits for it (answered elsewhere, timed out or
  /// withdrawn); its card was closed instead of sending.
  case noLongerPending
}

/// One notice, with a counter so the same notice twice is shown twice.
public struct RequestNoticeEntry: Sendable, Equatable {
  public var notice: RequestNotice
  public var requestID: String
  public var serial: Int
}

/// An answer that went out, for a VoiceOver announcement.
public struct AnsweredEntry: Sendable, Equatable {
  public var requestID: String
  public var serial: Int
}

/// Answering what one chat's bot asks: approvals and clarify questions, from
/// the inline cards and from a sheet.
///
/// Every answer goes through the session layer (`TranscriptStore`), which
/// marks a card answered only once its answer went out, and sends nothing for
/// a second tap. On top of that this model:
///
/// - re-validates an approval against `approval.pending` before answering it;
///   one the gateway no longer lists is closed with a notice and nothing is sent;
/// - answers only with a choice the request offered (never an invented one);
/// - keeps an in-flight state per request (the controls are off meanwhile) and
///   a failed state with the answer kept, for a retry;
/// - picks the request a sheet shows, and counts down to a request's deadline
///   when it carries one.
@MainActor
@Observable
public final class RequestsModel {
  public let chat: ChatModel

  /// Per request id: an answer on its way, or one that did not go out.
  public private(set) var phases: [String: RequestPhase] = [:]
  /// The answer last tried per request, for `retry`.
  public private(set) var attempts: [String: RequestAnswerDraft] = [:]
  /// The last request that closed without the reader's answer.
  public private(set) var notice: RequestNoticeEntry?
  /// The request the sheet shows, by request id; nil when no sheet is up.
  public var presentedRequestID: String?
  /// The last answer that went out, for a VoiceOver announcement.
  public private(set) var lastAnswered: AnsweredEntry?

  /// Deadlines by request id, when a request carries one.
  public private(set) var deadlines: [String: Date] = [:]
  @ObservationIgnored private var serial = 0
  @ObservationIgnored private var dismissed: Set<String> = []

  public init(chat: ChatModel) {
    self.chat = chat
  }

  public convenience init(session: GatewaySession, bot: String) {
    self.init(chat: session.chat(bot))
  }

  // MARK: - What the views read

  public var bot: String { chat.key }

  /// The questions still waiting, oldest first.
  public var openRequests: [TranscriptItem] { chat.openRequests }

  /// The request the sheet shows, while it is still in the transcript.
  public var presentedRequest: TranscriptItem? {
    guard let id = presentedRequestID else {
      return nil
    }

    return chat.items.first { $0.item.requestID == id }?.item ?? openRequests.first { $0.requestID == id }
  }

  public func phase(of requestID: String) -> RequestPhase? {
    phases[requestID]
  }

  public func isSending(_ requestID: String) -> Bool {
    phases[requestID] == .sending
  }

  /// Whether the last attempt failed and can be retried.
  public func hasFailed(_ requestID: String) -> Bool {
    if case .failed? = phases[requestID] {
      return true
    }

    return false
  }

  /// Give a request a deadline; its card counts down to it and closes as a
  /// timeout when it passes (`expire`).
  ///
  /// No request in today's gateway contract carries one: the gateway times a
  /// question out itself and says so with `request.cancel` (reason `timeout`).
  /// This is the seam for one that does, and for a notification that knows it.
  public func setDeadline(_ requestID: String, _ deadline: Date?) {
    deadlines[requestID] = deadline
  }

  /// When the request stops waiting, if it says so.
  public func deadline(of requestID: String) -> Date? {
    deadlines[requestID]
  }

  /// Seconds left before `requestID`'s deadline at `now`, never below zero;
  /// nil when the request carries no deadline.
  public func secondsLeft(_ requestID: String, at now: Date) -> Int? {
    guard let deadline = deadlines[requestID] else {
      return nil
    }

    return max(0, Int(deadline.timeIntervalSince(now).rounded(.up)))
  }

  // MARK: - The sheet

  /// Show the sheet for a request (from a card, a notification, the list).
  public func present(_ requestID: String) {
    dismissed.remove(requestID)
    presentedRequestID = requestID
  }

  /// The reader put the sheet away. Not an answer: the question stays open in
  /// the transcript, and the sheet does not come back for it by itself.
  public func dismissSheet() {
    if let id = presentedRequestID {
      dismissed.insert(id)
    }

    presentedRequestID = nil
  }

  /// The oldest open request the reader has not put away, for a screen that
  /// raises the sheet as questions arrive.
  public var nextToPresent: String? {
    openRequests.first { !dismissed.contains($0.requestID ?? "") }?.requestID
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: - Answering

  /// Answer an approval with one of the choices it offered.
  public func answerApproval(_ requestID: String, choice: String) async {
    guard let item = openItem(requestID)?.asApproval, item.choices.contains(choice) else {
      return
    }

    await answer(requestID, .approval(choice: choice))
  }

  /// Answer a clarify: qid → answer, for questions the request asked.
  public func answerClarify(_ requestID: String, answers: [String: String]) async {
    guard let item = openItem(requestID)?.asClarify else {
      return
    }

    let asked = Set(item.questions.map(\.qid))
    let kept = answers.filter { asked.contains($0.key) }

    guard !kept.isEmpty else {
      return
    }

    await answer(requestID, .clarify(answers: kept))
  }

  /// Send the answer that failed again.
  public func retry(_ requestID: String) async {
    guard case .failed? = phases[requestID], let attempt = attempts[requestID] else {
      return
    }

    await answer(requestID, attempt)
  }

  /// The deadline passed: the gateway stops waiting, so the card closes the way
  /// a timeout does. Nothing is sent.
  public func expire(_ requestID: String) async {
    guard openItem(requestID) != nil, phases[requestID] != .sending else {
      return
    }

    deadlines[requestID] = nil
    await chat.store.withdrawRequest(bot, requestID: requestID, reason: "timeout")
    finish(requestID, closingSheet: false)
  }

  private func answer(_ requestID: String, _ draft: RequestAnswerDraft) async {
    // A second tap, or a tap on a card whose answer is already on its way.
    guard phases[requestID] != .sending else {
      return
    }

    phases[requestID] = .sending
    attempts[requestID] = draft
    let store = chat.store
    let key = bot

    if case .approval = draft, await store.approvalStanding(key, requestID: requestID) == .gone {
      await store.withdrawRequest(key, requestID: requestID, reason: "gone")
      // A sheet that is up stays, showing the outcome, until the reader closes it.
      finish(requestID, closingSheet: false)
      show(.noLongerPending, requestID)
      return
    }

    // Through the chat model, whose `cardNotices` is the one record of an
    // answer that did not go out; what it leaves behind says how this went.
    switch draft {
    case .approval(let choice):
      await chat.respondApproval(requestID, choice: choice)
    case .clarify(let answers):
      await chat.respondClarify(requestID, answers: ordered(answers, for: requestID))
    }

    // Set by the call that just returned (nil when it did not throw).
    let failure = chat.lastError

    if await !store.isOpenCard(key, requestID) {
      finish(requestID)
      serial += 1
      lastAnswered = AnsweredEntry(requestID: requestID, serial: serial)
    } else if chat.cardNotices[requestID] != nil {
      // Still open, nothing went out: the socket that delivered it is gone, and
      // its re-delivered copy will take the retry.
      phases[requestID] = .failed(reason: nil)
    } else if let failure {
      phases[requestID] = .failed(reason: failure)
    } else {
      // Open and nothing failed: a batch with answers locked and more to give.
      phases[requestID] = nil
    }
  }

  private func finish(_ requestID: String, closingSheet: Bool = true) {
    phases[requestID] = nil
    attempts[requestID] = nil
    deadlines[requestID] = nil

    if closingSheet, presentedRequestID == requestID {
      presentedRequestID = nil
    }
  }

  private func show(_ notice: RequestNotice, _ requestID: String) {
    serial += 1
    self.notice = RequestNoticeEntry(notice: notice, requestID: requestID, serial: serial)
  }

  /// The answers in the order the request asked its questions.
  private func ordered(_ answers: [String: String], for requestID: String) -> JSRecord<String> {
    let order = openItem(requestID)?.asClarify?.questions.map(\.qid) ?? answers.keys.sorted()
    return JSRecord(order.compactMap { qid in answers[qid].map { (qid, $0) } })
  }

  private func openItem(_ requestID: String) -> TranscriptItem? {
    openRequests.first { $0.requestID == requestID }
  }
}

extension TranscriptItem {
  /// The request id of an approval or clarify card.
  public var requestID: String? {
    switch self {
    case .approval(let item): item.requestID
    case .clarify(let item): item.requestID
    default: nil
    }
  }
}
