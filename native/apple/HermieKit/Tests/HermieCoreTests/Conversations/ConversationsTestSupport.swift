import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Synchronization

@testable import HermieCore

/// A gateway's conversations as the page's model sees them: a list the test sets, a log of what was
/// asked, errors a test can arm, and a read it can hold back.
final class StubConversations: ConversationsBackend, Sendable {
  struct State {
    var groups = ConversationGroups()
    var calls: [String] = []
    var failing: [String: any Error] = [:]
    /// Pages of the transcript by the offset they are read at.
    var pages: [Int: ConversationTranscriptPage] = [:]
    var transcriptFailure: (any Error)?
    /// The method whose next call is held in the air until `release()`, and the call being held.
    var armed: String?
    var held: CheckedContinuation<Void, Never>?
  }

  let state = Mutex(State())

  var calls: [String] { state.withLock { $0.calls } }

  func set(_ groups: ConversationGroups) {
    state.withLock { $0.groups = groups }
  }

  func fail(_ method: String, _ error: any Error) {
    state.withLock { $0.failing[method] = error }
  }

  /// Keep the next call to `method` in the air (after its answer is worked out) until `release()`.
  func hold(_ method: String) {
    state.withLock { $0.armed = method }
  }

  var isHolding: Bool { state.withLock { $0.held != nil } }

  func release() {
    let held = state.withLock { state -> CheckedContinuation<Void, Never>? in
      defer { state.held = nil }
      return state.held
    }

    held?.resume()
  }

  func record(_ call: String) async throws {
    let method = call.split(separator: " ").first.map(String.init) ?? call
    let (error, hold) = state.withLock { state -> ((any Error)?, Bool) in
      state.calls.append(call)
      let hold = state.armed == method

      if hold {
        state.armed = nil
      }

      return (state.failing[method], hold)
    }

    if hold {
      await withCheckedContinuation { continuation in
        state.withLock { $0.held = continuation }
      }
    }

    if let error {
      throw error
    }
  }

  func list(bot: String) async throws -> ConversationGroups {
    // What the gateway says when the read is made, however long the answer takes to arrive.
    let answer = state.withLock { $0.groups }
    try await record("list")

    return answer
  }

  func rename(bot: String, conversation: Conversation, title: String) async throws -> String {
    try await record("rename \(conversation.id) \(title)")
    return title
  }

  func delete(bot: String, conversation: Conversation) async throws {
    try await record("delete \(conversation.id)")
  }

  func adopt(bot: String, conversation: Conversation) async throws {
    try await record("adopt \(conversation.id)")
  }

  func startNew(bot: String) async throws {
    try await record("startNew")
  }

  func transcript(bot: String, conversation: Conversation, window: MessageWindow) async throws
    -> ConversationTranscriptPage
  {
    try await record("transcript \(conversation.id) \(window.offset)")

    if let failure = state.withLock({ $0.transcriptFailure }) {
      throw failure
    }

    return state.withLock { $0.pages[window.offset] }
      ?? ConversationTranscriptPage(rows: [], shape: .rest, reachedStart: true)
  }
}

enum ConversationFixture {
  static func conversation(
    _ id: String, _ title: String? = nil, kind: ConversationKind = .past, count: Int = 4, at time: Double = 1_790_000_000
  ) -> Conversation {
    Conversation(id: id, title: title ?? "Conversation \(id)", messageCount: count, lastActive: time, kind: kind)
  }

  /// A current conversation, a branch and two past conversations.
  static let groups = ConversationGroups(
    canonical: conversation("cur", "Bot Chat", kind: .canonical, count: 40),
    branches: [conversation("br", "Branch · an idea", kind: .branch)],
    past: [conversation("p1", "Trip planning"), conversation("p2", "Bot Chat · 2026-09-21 23:16")]
  )

  /// REST-shaped history rows with ids `start ..< start + count`.
  static func restRows(_ count: Int, from start: Int = 1) -> [TranscriptRow] {
    (start..<(start + count)).map { id in
      TranscriptRow(json: [
        "id": .number(Double(id)),
        "role": .string(id % 2 == 1 ? "user" : "assistant"),
        "content": .string("row \(id)"),
        "timestamp": .number(Double(1_789_999_000 + id))
      ])
    }
  }
}
