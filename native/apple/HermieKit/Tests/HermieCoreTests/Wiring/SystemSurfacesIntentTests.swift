import Foundation
import HermieGateway
import HermieProtocol
import HermieShared
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

/// An App Group container in a fresh temporary directory, removed when the test ends.
final class SurfaceFolder: Sendable {
  let root: URL
  let container: AppGroupContainer

  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-intents-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    container = AppGroupContainer(url: root)
  }

  deinit {
    try? FileManager.default.removeItem(at: root)
  }

  /// Queue a Shortcut request, as the App Intent writes it.
  func intent(
    _ id: String,
    _ kind: PendingIntent.Kind,
    _ text: String,
    gateway: String?,
    bot: String = Fixture.profile,
    createdAt: Date = Date()
  ) throws {
    let request = PendingIntent(
      id: id, kind: kind, bot: bot, text: text, createdAt: (createdAt.timeIntervalSince1970 * 1000).rounded(.down),
      gatewayKey: gateway
    )

    try container.write(request.encoded(), to: try #require(container.pendingIntentURL(id: id)))
  }

  /// The answer written for a request, once there is one.
  func result(_ id: String) -> IntentResult? {
    guard let url = container.intentResultURL(id: id), let data = try? Data(contentsOf: url),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let ok = json["ok"] as? Bool
    else {
      return nil
    }

    return ok ? .reply(id: id, json["reply"] as? String ?? "") : .failure(id: id, json["error"] as? String ?? "")
  }

  func exists(_ relative: String) -> Bool {
    FileManager.default.fileExists(atPath: root.appendingPathComponent(relative).path)
  }
}

/// "Send to" and "Ask" against a session whose bot is busy, and an "Ask" that does not hold up the
/// queue behind it.
@Suite(.timeLimit(.minutes(1))) @MainActor struct SystemSurfacesIntentTests {
  private func surfaces(_ folder: SurfaceFolder) -> SystemSurfaces {
    let surfaces = SystemSurfaces(container: folder.container, copy: SystemSurfacesTests.copy, isLocked: { false })

    surfaces.replyPoll = .milliseconds(10)
    return surfaces
  }

  /// A ready session with the bot's chat open and a turn running.
  private func busy() async throws -> SessionHarness {
    let harness = SessionHarness()

    try await harness.start()
    try await harness.open()
    harness.link.setREST { _, _ in [] }
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "earlier answer"])
    try await harness.frame()
    #expect(await harness.session.store.state(of: Fixture.profile)?.turn.active == true)
    return harness
  }

  private func answer(_ folder: SurfaceFolder, _ id: String) async throws -> IntentResult {
    try await eventually("the answer to \(id)") { await MainActor.run { folder.result(id) != nil } }
    return try #require(folder.result(id))
  }

  @Test func askWhileATurnRunsAnswersWithTheReplyToItsOwnPrompt() async throws {
    let folder = try SurfaceFolder()
    let surfaces = surfaces(folder)
    let harness = try await busy()

    try folder.intent("ask1", .ask, "and then?", gateway: key)
    #expect(await surfaces.drain(session: harness.session, gatewayKey: key, known: [key]) == false)
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty, "parked behind the running turn")

    // The running turn ends: its reply is not the answer.
    harness.link.emit("message.complete", session: Fixture.runtime, seq: 3, payload: ["text": "earlier answer"])
    let call = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    #expect(call.params["text"] == "and then?")
    try await Task.sleep(for: .milliseconds(100))
    #expect(folder.result("ask1") == nil, "still waiting for the reply to its own prompt")

    harness.link.answer(call, ["status": "streaming"])
    harness.link.emit("message.start", session: Fixture.runtime, seq: 4)
    harness.link.emit("message.complete", session: Fixture.runtime, seq: 5, payload: ["text": "the answer to yours"])

    #expect(try await answer(folder, "ask1") == .reply(id: "ask1", "the answer to yours"))
    await harness.session.shutdown()
  }

  @Test func sendToWhileATurnRunsAnswersOnceThePromptWentOut() async throws {
    let folder = try SurfaceFolder()
    let surfaces = surfaces(folder)
    let harness = try await busy()

    try folder.intent("send1", .send, "and then?", gateway: key)
    await surfaces.drain(session: harness.session, gatewayKey: key, known: [key])
    try await Task.sleep(for: .milliseconds(100))
    #expect(folder.result("send1") == nil, "not claimed as sent while it is only parked")

    harness.link.emit("message.complete", session: Fixture.runtime, seq: 3, payload: ["text": "earlier answer"])
    try await harness.link.answerNext(RPC.PromptSubmit.name, ["status": "streaming"])

    #expect(try await answer(folder, "send1") == .reply(id: "send1", ""))
    await harness.session.shutdown()
  }

  @Test func sendToWhoseParkedPromptDoesNotGoOutInTimeSaysItIsQueued() async throws {
    let folder = try SurfaceFolder()
    let surfaces = surfaces(folder)
    let harness = try await busy()

    surfaces.parkedSendWait = .milliseconds(200)
    try folder.intent("send1", .send, "and then?", gateway: key)
    await surfaces.drain(session: harness.session, gatewayKey: key, known: [key])

    #expect(try await answer(folder, "send1") == .failure(id: "send1", "researcher is busy; queued"))
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)
    #expect(await harness.session.store.chats[Fixture.profile]?.queue.map(\.text) == ["and then?"], "still queued")
    await harness.session.shutdown()
  }

  @Test func anAskWaitingForItsReplyDoesNotHoldUpTheRequestsBehindIt() async throws {
    let folder = try SurfaceFolder()
    let surfaces = surfaces(folder)
    let harness = SessionHarness()

    try await harness.start()
    try await harness.open()
    harness.link.respond(to: RPC.PromptSubmit.name, with: ["status": "streaming"])

    let now = Date()
    try folder.intent("ask1", .ask, "a long one", gateway: key, createdAt: now.addingTimeInterval(-1))
    try folder.intent("ask2", .ask, "another", gateway: key, bot: "not-here", createdAt: now)

    // The drain hands the first over and goes on; it does not sit out the first one's budget.
    let session = harness.session
    _ = try await within("the drain", .seconds(5)) { @MainActor in
      await surfaces.drain(session: session, gatewayKey: key, known: [key])
    }

    #expect(folder.result("ask2") == .failure(id: "ask2", "not-here is not here"))
    #expect(folder.result("ask1") == nil, "the first is still waiting for its reply")
    #expect(folder.exists("intents/pending/ask1.taken"), "taken, so no other drain runs it again")
    #expect(harness.link.calls(RPC.PromptSubmit.name).count == 1)

    await surfaces.drain(session: session, gatewayKey: key, known: [key])
    #expect(harness.link.calls(RPC.PromptSubmit.name).count == 1, "sent once")
    await harness.session.shutdown()
  }

  @Test func aShareOrARequestForAnotherGatewayIsNeverSentThroughThisSession() async throws {
    let folder = try SurfaceFolder()
    let surfaces = surfaces(folder)
    let harness = SessionHarness()

    try await harness.start()
    try await harness.open()

    let other = "bbbbbbbbbbbbbbbb"
    let scope = GatewayScope(active: key, known: [key, other])
    let share = PendingShare(
      id: "s", bot: Fixture.profile, gatewayKey: other, note: "hi", createdAt: 0,
      items: [.words(kind: .text, text: "hello")], claim: nil)

    #expect(await surfaces.deliver(share, session: harness.session, scope: scope) == .keep)

    let intent = PendingIntent(id: "i", kind: .send, bot: Fixture.profile, text: "go", createdAt: 0, gatewayKey: other)
    #expect(await surfaces.answer(intent, session: harness.session, scope: scope) == .later)
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)
    await harness.session.shutdown()
  }
}
