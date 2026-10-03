import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

/// What the store hands the session beside the transcript, in order.
///
/// The transcript engine is a parity port and reads none of these (an event it
/// does not know only moves `lastSeq`), so they are picked off the ingest path
/// here and handed to the session's own models: notices
/// (`GatewayNoticesModel`), connector authorisation cards
/// (`ConnectionRequestsModel`), deferred resume progress and finished
/// background tasks.
enum SessionSignal: Sendable {
  /// `notification.show`, as it was taken in. `chat` is the chat its session is bound to, if any.
  case noticeShown(NotificationShowPayload, chat: String?)
  /// `notification.clear`.
  case noticeCleared(key: String)
  /// `connection.request` on a chat's session.
  case connectionRequested(chat: String, runtimeSessionID: String, ConnectionRequestPayload)
  /// `connection.update` on a chat's session.
  case connectionUpdated(chat: String, ConnectionUpdatePayload)
  /// A resume's `pending_connection`: the operation still open, or `nil` when none is. A resume
  /// is applied at its place among the chat's frames, so `nil` withdraws whatever the chat held.
  case connectionSnapshot(chat: String, runtimeSessionID: String, ConnectionRequestPayload?)
  /// `session.resume_progress` on a chat's session.
  case resumeProgress(chat: String, SessionResumeProgressPayload)
  /// `background.complete` on a chat's session (the transcript shows it as well).
  case backgroundTaskFinished(chat: String, SideAgentCompletePayload)
  /// The chat is gone (`forget`): whatever is kept for it goes too.
  case chatForgotten(chat: String)
  /// A `sessions.changed` sweep ran (debounced): another client changed the roster or a session.
  case sessionsChanged
}

extension TranscriptStore {
  /// The chat-scoped event types handed to the session at their place in a lane.
  static let chatSignalTypes: Set<String> = [
    GatewayEventType.connectionRequest,
    GatewayEventType.connectionUpdate,
    GatewayEventType.sessionResumeProgress,
    GatewayEventType.backgroundComplete
  ]

  /// At ingest, before routing: the gateway-wide notices, which belong to no
  /// chat's order, and the developer count of event types this build cannot read.
  func noteBeside(_ event: GatewayEvent) {
    let type = event.type

    switch type {
    case GatewayEventType.notificationShow:
      let payload = NotificationShowPayload(json: event.payload?.objectValue ?? [:])
      let chat = event.sessionID.flatMap { routes[$0] }
      signalSink.yield(.noticeShown(payload, chat: chat))
    case GatewayEventType.notificationClear:
      if let key = event.payload?["key"]?.stringValue, !key.isEmpty {
        signalSink.yield(.noticeCleared(key: key))
      }
    default:
      countIfUnknown(type)
    }
  }

  func countIfUnknown(_ type: String) {
    #if DEBUG
      guard !GatewayEventType.known.contains(type) else {
        return
      }

      if unknownEvents[type] != nil || unknownEvents.count < ChatRuntimeLimits.maxUnknownEventNames {
        unknownEvents[type, default: 0] += 1
      }
    #endif
  }

  /// Every event type this build has no typed case for, with how often it came in.
  /// Empty in a release build: it is for the developer detail, not for the person.
  public var unknownEventCounts: [String: Int] { unknownEvents }

  /// Whether `event` is newer than what the chat has applied: the engine drops a
  /// frame at or below `lastSeq`, and so must everything beside it.
  func isNew(_ event: GatewayEvent, in key: String) -> Bool {
    guard let seq = event.json["seq"]?.doubleValue else {
      return true
    }

    return seq > Double(chats[key]?.state.lastSeq ?? 0)
  }

  /// A chat-scoped event, at its place in the chat's frames. Call it before the
  /// engine applies the event (`fresh` is read before `lastSeq` moves).
  func signalChatEvent(_ event: GatewayEvent, in key: String, fresh: Bool) {
    guard fresh else {
      return
    }

    let payload = event.payload?.objectValue ?? [:]

    switch event.type {
    case GatewayEventType.connectionRequest:
      let runtimeID = event.sessionID ?? ""
      signalSink.yield(.connectionRequested(chat: key, runtimeSessionID: runtimeID, ConnectionRequestPayload(json: payload)))
    case GatewayEventType.connectionUpdate:
      signalSink.yield(.connectionUpdated(chat: key, ConnectionUpdatePayload(json: payload)))
    case GatewayEventType.sessionResumeProgress:
      signalSink.yield(.resumeProgress(chat: key, SessionResumeProgressPayload(json: payload)))
    case GatewayEventType.backgroundComplete:
      signalSink.yield(.backgroundTaskFinished(chat: key, SideAgentCompletePayload(json: payload)))
    default:
      break
    }
  }

  /// A resume's `pending_connection`, at the resume's place in the chat's frames.
  func signalConnectionSnapshot(_ key: String, runtimeID: String, _ result: JSONValue) {
    let pending = result["pending_connection"]?.objectValue.map(ConnectionRequestPayload.init(json:))
    signalSink.yield(.connectionSnapshot(chat: key, runtimeSessionID: runtimeID, pending))
  }
}
