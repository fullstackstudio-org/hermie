import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript

/// A `/background` task that finished in a chat (`background.complete`).
public struct BackgroundTaskFinished: Sendable, Equatable {
  public var chat: String
  public var taskID: String
  /// The task's answer, as the gateway sent it. Untrusted text.
  public var text: String
}

// What the session knows beside the transcript: who it is, what the gateway
// can do, and the signals the store hands over (notices, connection cards,
// resume progress, finished background tasks).
extension GatewaySession {
  /// How many finished background tasks are remembered, so a replayed one is not reported twice.
  static let reportedBackgroundTaskLimit = 256

  // MARK: - Identity

  /// The identity, when the gateway has given one.
  public var identity: GatewayIdentity? { identityState.identity }

  /// Whether this gateway stamps who wrote each message (`per_message_author`).
  /// Without that, an author on a row is not the gateway's word, and nothing may
  /// be drawn as somebody else's on the strength of it.
  public var rowAuthorsTrusted: Bool { capabilities?.perMessageAuthor == true }

  /// The id a view compares a row's author with to tell the reader's own
  /// messages from a colleague's (`transcriptOwnAuthorID`). `nil` (every row
  /// drawn as the reader's own, as before authors existed) until the identity is
  /// known and the gateway vouches for row authors.
  public var ownAuthorID: String? { rowAuthorsTrusted ? identity?.authorID : nil }

  /// Ask the gateway who this is now: after a sign-in, and by itself after
  /// every connect. Only the newest read is applied.
  public func refreshIdentity() async {
    identityReads += 1
    let read = identityReads
    let probe = await link.probeIdentity()

    guard read == identityReads, !isShutDown else {
      return
    }

    let next = identityState.after(probe)

    if case .failed(let reason) = probe {
      identityFailure = reason
    } else {
      identityFailure = nil
    }

    // The person the app-wide ui_meta key is named after (`hermie-app:<user>`), as the reference
    // reads it: the owner on a session-token gateway, the user id (or the email) the gateway
    // answered otherwise, and nobody after a read that failed, also when an earlier read named
    // somebody (a bridge that has no person yet stays on the local-only path). Not the author stamp,
    // which keeps the last answer (`GatewayIdentityState.after`).
    switch probe {
    case .sessionToken:
      uiMetaUser = Self.sessionTokenUser
    case .answered(let me):
      uiMetaUser = me.userID.isEmpty ? me.email : me.userID
    case .failed:
      uiMetaUser = nil
    }

    await adopt(next)
  }

  /// Signed out: nothing is known any more, here or on disk.
  public func forgetIdentity() async {
    identityReads += 1
    identityFailure = nil
    uiMetaUser = nil
    await adopt(.unknownYet)
  }

  /// Before the first answer: the last good one, shown while the read is in
  /// flight so a cold start does not draw a colleague's bubbles as the reader's
  /// (the reference's `useOwnAuthorStore.hydrate`). Marked unverified.
  func loadRememberedIdentity() async {
    guard case .unknownYet = identityState, let keyValues else {
      return
    }

    let key = GatewayNamespace(gatewayID).key(StoreKeys.ownAuthor)

    guard let stored = try? await keyValues.value(StoredOwnAuthor.self, forKey: key), !stored.id.isEmpty,
      case .unknownYet = identityState
    else {
      return
    }

    let remembered = GatewayIdentity(authorID: stored.id, displayName: stored.name, verified: false)
    identityState = .known(remembered)
    ownAuthorCell.set(remembered.author)
  }

  private func adopt(_ next: GatewayIdentityState) async {
    let previous = identityState

    if previous != next {
      identityState = next
    }

    ownAuthorCell.set(next.identity?.author)

    guard let keyValues else {
      return
    }

    let key = GatewayNamespace(gatewayID).key(StoreKeys.ownAuthor)

    switch next {
    case .known(let identity) where identity.verified && previous.identity != identity:
      try? await keyValues.set(StoredOwnAuthor(id: identity.authorID, name: identity.displayName), forKey: key)
    case .anonymous, .unknownYet:
      if previous.identity != nil {
        try? await keyValues.removeValue(forKey: key)
      }
    default:
      break
    }
  }

  // MARK: - Capabilities

  /// `gateway.capabilities`. A gateway without the method, or one that does not
  /// answer, leaves what was known (nothing, on a first connect).
  func readCapabilities() async {
    guard let reply = try? await link.requestReply(RPC.GatewayCapabilities.name, params: .object([:])),
      let result = GatewayCapabilitiesResult(jsonValue: reply.result), !isShutDown
    else {
      return
    }

    capabilities = result
  }

  // MARK: - Developer detail

  /// Event types this build cannot read, with how often each came in (debug builds only).
  public func unknownEventCounts() async -> [String: Int] {
    await store.unknownEventCounts
  }

  // MARK: - Signals

  func receive(_ signal: SessionSignal) {
    switch signal {
    case .noticeShown(let payload, let chat):
      notices.show(payload, chat: chat)
    case .noticeCleared(let key):
      notices.clear(key: key)
    case .connectionRequested(let chat, let runtimeID, let payload):
      connectionRequests.requested(chat: chat, runtimeSessionID: runtimeID, payload)
    case .connectionUpdated(let chat, let payload):
      connectionRequests.updated(chat: chat, payload)
    case .connectionSnapshot(let chat, let runtimeID, let payload):
      connectionRequests.restored(chat: chat, runtimeSessionID: runtimeID, payload)
    case .resumeProgress(let chat, let payload):
      let progress = ResumeProgress(payload)
      resumeProgress[chat] = progress
      models[chat]?.resumeProgress = progress
    case .backgroundTaskFinished(let chat, let payload):
      reportBackgroundTask(chat, payload)
    case .chatForgotten(let chat):
      connectionRequests.forget(chat: chat)
      resumeProgress[chat] = nil
      models[chat]?.resumeProgress = nil
    case .sessionsChanged:
      onSessionsChanged?()
    }
  }

  private func reportBackgroundTask(_ chat: String, _ payload: SideAgentCompletePayload) {
    let taskID = payload.taskID ?? ""
    let token = "\(chat)\u{1F}\(taskID)"

    if !taskID.isEmpty {
      guard !reportedBackgroundTasks.contains(token) else {
        return
      }

      reportedBackgroundTasks.append(token)

      if reportedBackgroundTasks.count > Self.reportedBackgroundTaskLimit {
        reportedBackgroundTasks.removeFirst()
      }
    }

    onBackgroundTaskFinished?(BackgroundTaskFinished(chat: chat, taskID: taskID, text: payload.text ?? ""))
  }
}

/// `session.resume_progress` for one chat: a deferred resume loading its transcript.
public struct ResumeProgress: Sendable, Equatable {
  public var status: ResumePhaseStatus
  /// `history` today.
  public var phase: String
  /// On `complete`: the rows the transcript has.
  public var messageCount: Int?
  /// On `failed`: why. Untrusted text.
  public var message: String?

  public init(status: ResumePhaseStatus, phase: String = "history", messageCount: Int? = nil, message: String? = nil) {
    self.status = status
    self.phase = phase
    self.messageCount = messageCount
    self.message = message
  }

  init(_ payload: SessionResumeProgressPayload) {
    self.init(
      status: payload.status ?? .unknown(""),
      phase: payload.phase ?? "",
      messageCount: payload.messageCount,
      message: payload.message
    )
  }

  /// Still loading.
  public var isLoading: Bool { status == .loading }
}
