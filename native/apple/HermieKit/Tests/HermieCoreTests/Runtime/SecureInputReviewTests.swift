import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// Chat keys by runtime session, where a lookup of a held session waits until
/// the test releases it: a pass or a route paused at exactly that point.
final class LookupGate: Sendable {
  private struct State {
    var keys: [String: String] = [:]
    var held: Set<String> = []
    var waiting: [CheckedContinuation<Void, Never>] = []
  }

  private let state = Mutex(State())

  init(_ keys: [String: String]) {
    state.withLock { $0.keys = keys }
  }

  func set(_ session: String, _ key: String?) {
    state.withLock { $0.keys[session] = key }
  }

  func hold(_ session: String) {
    state.withLock { _ = $0.held.insert(session) }
  }

  var waitingCount: Int { state.withLock { $0.waiting.count } }

  /// Let every paused lookup go on, and stop holding.
  func release() {
    let waiting = state.withLock { state in
      state.held.removeAll()
      defer { state.waiting.removeAll() }
      return state.waiting
    }

    for continuation in waiting {
      continuation.resume()
    }
  }

  /// The key as it is when the lookup starts, handed back once it may go on:
  /// a key read before a pause.
  func lookup(_ session: String) async -> String? {
    let key = state.withLock { $0.keys[session] }

    if state.withLock({ $0.held.contains(session) }) {
      await withCheckedContinuation { continuation in
        let parked = state.withLock { state in
          guard state.held.contains(session) else {
            return false
          }

          state.waiting.append(continuation)
          return true
        }

        if !parked {
          continuation.resume()
        }
      }
    }

    return key
  }
}

/// A reply that waits until the test lets it out, as a frame stuck on its way.
final class ReplyGate: Sendable {
  private let state = Mutex<(open: Bool, waiting: [CheckedContinuation<Void, Never>], answers: [JSONObject])>(
    (false, [], []))

  var answers: [JSONObject] { state.withLock { $0.answers } }

  func open() {
    let waiting = state.withLock { state in
      state.open = true
      defer { state.waiting.removeAll() }
      return state.waiting
    }

    for continuation in waiting {
      continuation.resume()
    }
  }

  func respond(_ result: JSONObject) async -> Bool {
    await withCheckedContinuation { continuation in
      let wait = state.withLock { state -> Bool in
        if state.open {
          return false
        }

        state.waiting.append(continuation)
        return true
      }

      if !wait {
        continuation.resume()
      }
    }

    state.withLock { $0.answers.append(result) }
    return true
  }
}

@Suite("Secure input: the review's findings") @MainActor
struct SecureInputReviewTests {
  // MARK: 1. Nobody answers a prompt the person never saw

  @Test("a prompt that arrives while a pass reads its keys is not answered by that pass")
  func passDoesNotJudgeNewcomers() async throws {
    let h = SecureHarness()
    try await h.open()
    let gate = LookupGate([Fixture.runtime: bot, "rt-b": "writer"])
    h.center.chatKey = { session in await gate.lookup(session) }
    try await h.raiseOpen("a-secret")

    // A pass starts and pauses reading bot A's session.
    gate.hold(Fixture.runtime)
    h.center.storeChanged()
    try await eventually("the pass to pause") { gate.waitingCount == 1 }

    // Meanwhile bot B raises a sudo, placed on its chat.
    h.link.raise(id: "b-sudo", method: "sudo", params: ["session_id": "rt-b", "command": "ls"])
    let center = h.center
    try await eventually("b-sudo to open") { await center.isOpen("b-sudo") }

    gate.release()
    try await Task.sleep(for: .milliseconds(50))
    try await eventually("the passes to end") { await center.liveTaskCount == 2 }
    #expect(center.isOpen("b-sudo"), "never answered behind the person's back")
    #expect(center.prompts.first { $0.id == "b-sudo" }?.chatKey == "writer")
    #expect(center.isOpen("a-secret"))
    #expect(h.link.answers.isEmpty)
  }

  @Test("a prompt placed with a key read before its session moved follows the session")
  func routeWithAStaleKeyIsCorrected() async throws {
    let h = SecureHarness()
    try await h.open()
    let gate = LookupGate(["rt-x": bot])
    h.center.chatKey = { session in await gate.lookup(session) }

    // The route reads the key, and pauses before using it.
    gate.hold("rt-x")
    h.link.raise(id: "moved", method: "secret", params: ["session_id": "rt-x", "env_var": "K", "prompt": "p"])
    try await eventually("the route to pause") { gate.waitingCount == 1 }

    // The session moves to another chat; the store's frame finds nothing to move.
    gate.set("rt-x", "writer")
    h.center.storeChanged()
    gate.release()
    let center = h.center
    try await eventually("it to follow its session") {
      await center.prompts.first { $0.id == "moved" }?.chatKey == "writer"
    }
    #expect(h.link.answers.isEmpty)
  }

  // MARK: 2. An answer that never arrived is asked again

  @Test("a re-delivered copy of an answered prompt opens it again, saying the answer did not arrive")
  func reopensWhenTheAnswerWasLost() async throws {
    let h = SecureHarness()
    try await h.open()
    let first = try await h.raiseOpen("lost", "sudo", params: ["command": "ls"])
    #expect(await h.center.send("lost", value: SecretValue("pw")))
    #expect(!h.center.isOpen("lost"))

    // A live copy of a done id is not proof of anything; only the gateway's re-delivery is.
    h.link.raise(id: "lost", method: "sudo", params: ["session_id": .string(Fixture.runtime)])
    try await Task.sleep(for: .milliseconds(30))
    #expect(!h.center.isOpen("lost"))

    let again = try await h.raiseOpen("lost", "sudo", params: ["command": "ls"], replayed: true)
    #expect(again.earlierAnswerLost)
    #expect(again.deadline == first.deadline, "the deadline its first copy had")
    #expect(await h.center.send("lost", value: SecretValue("pw")))
    #expect(h.answers("lost").count == 2)
  }

  @Test("a withdrawn prompt is never opened again; an abandoned '' that did not arrive is")
  func reopenRules() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("gone")
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "gone", "method": "secret", "reason": "interrupted"])
    let center = h.center
    try await eventually("gone to close") { await !center.isOpen("gone") }
    h.link.raise(id: "gone", method: "secret", params: ["session_id": .string(Fixture.runtime)], replayed: true)
    try await Task.sleep(for: .milliseconds(30))
    #expect(!center.isOpen("gone"))

    // The chat lets go while the socket is down: its '' does not go out.
    try await h.raiseOpen("let-go")
    h.link.setSocketOpen(false)
    h.link.emit("session.reclaimed", session: Fixture.runtime, payload: [:])
    try await h.harness.frame()
    try await eventually("let-go to close") { await !center.isOpen("let-go") }
    h.link.setSocketOpen(true)
    #expect(h.answers("let-go").isEmpty)

    // After the reconnect the gateway re-delivers it: taken in again (waiting
    // for a chat to hold its session), not ignored as done.
    h.link.raise(id: "let-go", method: "secret", params: ["session_id": .string(Fixture.runtime)], replayed: true)
    try await eventually("let-go to be taken in again") { await center.parkedCount == 1 }
  }

  // MARK: 4. The request's texts are bounded

  @Test("texts are bounded by scalars, combining marks are capped, runs of lines fold")
  func boundsTheText() {
    let zalgo = "a" + String(repeating: "\u{0301}", count: 5_000) + "b"
    let cleaned = SecurePrompt.displayText(zalgo, limit: 1_000)
    #expect(cleaned == "a" + String(repeating: "\u{0301}", count: 4) + "b")
    // The bound counts scalars, not characters: one character with its marks is five.
    #expect(SecurePrompt.displayText("abc\u{0301}\u{0301}def", limit: 4).unicodeScalars.count == 5)

    let lines = String(repeating: ".\n\n", count: 300)
    #expect(SecurePrompt.displayText(lines, limit: 600).unicodeScalars.filter { $0 == "\n" }.count < 300)
    #expect(!SecurePrompt.displayText(lines, limit: 600).contains("\n\n"))

    let marksOnly = String(repeating: "\u{0301}", count: 50)
    #expect(SecurePrompt.displayText(marksOnly, limit: 10).isEmpty, "marks with no character are dropped")

    // A huge request costs no more than a small one: only a bounded prefix is read.
    let huge = String(repeating: "x\u{200B}", count: 2_000_000)
    let start = ContinuousClock.now
    let bounded = SecurePrompt.displayText(huge, limit: SecurePrompt.textLimit)
    #expect(ContinuousClock.now - start < .seconds(1))
    #expect(bounded.unicodeScalars.count <= SecurePrompt.textLimit + 1)
    #expect(bounded.hasSuffix("…"))
  }

  @Test("the bot's name and an unsupported method are cleaned for display")
  func cleansNames() async throws {
    let h = SecureHarness()
    try await h.open()
    let model = SecureInputModel(center: h.center, bot: "evil\u{202E}name" + String(repeating: "\u{0301}", count: 40))
    #expect(model.botName == "evilname" + String(repeating: "\u{0301}", count: 4))

    h.link.raise(
      id: "odd", method: "terminal.read\u{202E}" + String(repeating: "\u{0300}", count: 30),
      params: ["session_id": .string(Fixture.runtime)])
    let center = h.center
    try await eventually("the notice") { await center.notices[bot] != nil }
    #expect(center.notices[bot]?.notice == .unsupported(method: "terminal.read" + String(repeating: "\u{0300}", count: 4)))
  }

  // MARK: 5. A re-delivered copy is closed at its arrival plus the timeout

  @Test("a prompt first seen re-delivered closes at its arrival plus the method's timeout")
  func replayedCopyHasALocalLimit() async throws {
    let h = SecureHarness()
    try await h.open()
    let prompt = try await h.raiseOpen("old", "sudo", params: ["command": "ls"], replayed: true)
    #expect(prompt.deadline == nil, "no countdown")

    await h.clock.advance(by: .seconds(119))
    #expect(h.center.isOpen("old"))
    await h.clock.advance(by: .seconds(1))
    #expect(!h.center.isOpen("old"))
    #expect(h.center.notices[bot]?.notice == .expired)
    #expect(h.link.answers.isEmpty)
  }

  // MARK: 6. A cancel during the send says what is true

  @Test("a request.cancel while the answer is on its way says it may not have arrived")
  func cancelWhileSending() async throws {
    let h = SecureHarness()
    try await h.open()
    let gate = ReplyGate()
    let inbound = InboundRequest(
      request: ServerRequest(id: "slow", method: "secret", params: ["session_id": .string(Fixture.runtime)]),
      replayed: false,
      index: 1,
      respond: { result in await gate.respond(result) },
      fail: { _, _ in true }
    )
    await h.center.ingest(SecureInputCenter.read(inbound))
    #expect(h.center.isOpen("slow"))

    let center = h.center
    let sending = Task { @MainActor in await center.send("slow", value: SecretValue("v")) }
    try await eventually("the answer to be on its way") { await center.phases["slow"] == .sending }
    center.withdraw("slow", reason: "timeout")
    gate.open()
    _ = await sending.value

    #expect(center.notices[bot]?.notice == .mayNotHaveArrived)
    #expect(!center.isOpen("slow"))
  }

  // MARK: 8. Notices never take a prompt's parking place

  @Test("requests this app cannot show, for an unbound session, never crowd out a prompt")
  func noticesDoNotPark() async throws {
    let h = SecureHarness()
    try await h.open()

    for index in 0..<40 {
      h.link.raise(id: "tr-\(index)", method: "terminal.read", params: ["session_id": "rt-other"])
    }
    h.link.raise(id: "real", method: "sudo", params: ["session_id": "rt-other", "command": "ls"])
    let center = h.center
    try await eventually("all taken in") { await center.parkedNoticeCount == 16 }
    try await Task.sleep(for: .milliseconds(50))
    #expect(!h.link.declines.contains { $0.id == "real" }, "the prompt waits for its chat")
    #expect(center.parkedNoticeCount == 16, "bounded, oldest dropped")
  }

  // MARK: 12. Shutdown flushes its last answers

  @Test("shutdown waits for its '' answers to reach the socket before closing it")
  func shutdownFlushes() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("left-open")

    await h.session.shutdown()
    let lifecycle = h.link.lifecycle
    let flush = try #require(lifecycle.firstIndex(of: "flush"))
    let shutdown = try #require(lifecycle.firstIndex(of: "shutdown"))
    #expect(flush < shutdown)
    #expect(h.answers("left-open") == [["value": ""]])
  }
}
