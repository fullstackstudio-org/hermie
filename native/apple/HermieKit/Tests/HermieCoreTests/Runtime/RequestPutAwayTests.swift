import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// HERM-251: a request can always be put away, and what was put away stays put away for the session,
/// whichever chat screen shows the chat; Retry and attachment opening on a chat's rows.
@Suite("Requests put away, Retry, attachments", .timeLimit(.minutes(1))) @MainActor
struct RequestPutAwayTests {
  // MARK: Secure prompts

  @Test("Later puts a secure prompt away: nothing is sent, it stays open, and it is not raised again")
  func secureLater() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-s", "sudo", params: ["command": "ls"])
    let model = SecureInputModel(session: h.session, bot: bot)

    #expect(model.nextToPresent == "srq-s")
    model.present("srq-s")
    model.later()

    #expect(model.presentedID == nil)
    #expect(h.answers("srq-s").isEmpty, "Later answers nothing, not even ''")
    #expect(h.center.isOpen("srq-s"), "the gateway keeps waiting")
    #expect(model.nextToPresent == nil, "not raised again by itself")
    #expect(model.waiting == ["srq-s"])

    model.present("srq-s")
    #expect(model.presented?.id == "srq-s", "opened again on request")
    #expect(model.waiting.isEmpty)
  }

  @Test("a secure prompt left on screen is put away for the chat opened again; a new one still comes up")
  func secureLeaveAndReenter() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-1")
    let first = SecureInputModel(session: h.session, bot: bot)
    first.present("srq-1")

    // Another chat chosen: the screen (and its model) goes.
    first.leave()
    #expect(h.answers("srq-1").isEmpty)

    let again = SecureInputModel(session: h.session, bot: bot)
    #expect(again.nextToPresent == nil, "re-entering does not raise it")
    #expect(again.waiting == ["srq-1"])

    try await h.raiseOpen("srq-2")
    #expect(again.nextToPresent == "srq-2", "a new prompt is time-critical and comes up")
  }

  // MARK: Interactive requests

  @Test("a form put away, or left on screen, stays put away for a chat screen made again")
  func interactiveSurvivesTheScreen() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-f")
    try await h.raiseOpen("srq-g")
    let first = InteractiveModel(session: h.session, bot: bot)

    first.present("srq-f")
    first.later()
    first.present("srq-g")
    first.leave()
    #expect(h.link.answers.isEmpty, "neither is an answer")

    let again = InteractiveModel(session: h.session, bot: bot)
    #expect(again.nextToPresent == nil)
    #expect(again.waiting == ["srq-f", "srq-g"])
    #expect(h.center.isOpen("srq-f") && h.center.isOpen("srq-g"))
  }

  // MARK: Retry

  private static func base(_ id: String, _ seq: Int) -> ItemBase {
    ItemBase(id: id, seq: seq, ts: 1, origin: .history, version: 1)
  }

  private static func user(_ id: String, _ seq: Int, _ text: String, author: String? = nil) -> VisibleItem {
    VisibleItem(
      item: .user(UserItem(base: base(id, seq), text: text, author: author.map { MessageAuthor(id: $0) })),
      presentation: .full)
  }

  private static func failed(_ id: String, _ seq: Int) -> VisibleItem {
    VisibleItem(
      item: .assistant(
        AssistantItem(
          base: base(id, seq), text: "", streaming: false, interim: false,
          error: AssistantFailure(message: "The model is unavailable.", partial: false))),
      presentation: .full)
  }

  @Test("Retry repeats the prompt the failed reply answered, and only the reader's own")
  func retryPrompt() {
    let items = [Self.user("u1", 1, "first"), Self.failed("a1", 2), Self.user("u2", 3, "second"), Self.failed("a2", 4)]
    #expect(ChatModel.retryPrompt(before: "a1", in: items, ownAuthorID: nil) == "first")
    #expect(ChatModel.retryPrompt(before: "a2", in: items, ownAuthorID: nil) == "second")
    #expect(ChatModel.retryPrompt(before: "gone", in: items, ownAuthorID: nil) == nil)
    #expect(ChatModel.retryPrompt(before: "a1", in: [Self.failed("a1", 1)], ownAuthorID: nil) == nil)

    let shared = [Self.user("u1", 1, "mine", author: "oidc:me"), Self.user("u2", 2, "theirs", author: "oidc:sam"), Self.failed("a1", 3)]
    #expect(ChatModel.retryPrompt(before: "a1", in: shared, ownAuthorID: "oidc:me") == nil, "never a colleague's words")
    #expect(ChatModel.retryPrompt(before: "a1", in: shared, ownAuthorID: "oidc:sam") == "theirs")
  }

  @Test("Retry sends the prompt again through the chat's own send; a running turn sends nothing")
  func retrySends() async throws {
    let harness = SessionHarness()
    try await harness.start()
    try await harness.open()
    try await harness.frame()
    harness.link.respond(to: RPC.PromptSubmit.name, with: ["status": "streaming"])
    let model = harness.session.chat(bot)

    func snapshot(turnActive: Bool, revision: Int) -> ChatSnapshot {
      ChatSnapshot(
        key: bot, items: [Self.user("u1", 1, "summarise the log"), Self.failed("a1", 2)], hydration: .live,
        busy: turnActive, turnActive: turnActive, activity: turnActive ? .working : .idle, openRequests: [], queue: [],
        attached: true, canLoadOlder: false, revision: revision)
    }

    model.apply(snapshot(turnActive: true, revision: 1_000))
    #expect(await model.retryTurn(of: "a1") == .busy)
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)

    model.apply(snapshot(turnActive: false, revision: 1_001))
    #expect(await model.retryTurn(of: "a1") == .resent("summarise the log"))
    let submits = harness.link.calls(RPC.PromptSubmit.name)
    #expect(submits.count == 1)
    #expect(submits.first?.params.objectValue?["text"]?.stringValue == "summarise the log")
    await harness.session.shutdown()
  }

  // MARK: Attachments

  @Test("an attachment resolves to a local file, a file the gateway serves, or nothing to open")
  func attachmentTargets() {
    let exists: (String) -> Bool = { $0 == "/Users/me/report.pdf" }

    #expect(AttachmentOpening.target(for: "@file:/Users/me/report.pdf", fileExists: exists) == .localFile(URL(fileURLWithPath: "/Users/me/report.pdf")))
    #expect(AttachmentOpening.target(for: "@file:\"/Users/me/report.pdf\"", fileExists: exists) == .localFile(URL(fileURLWithPath: "/Users/me/report.pdf")))
    #expect(AttachmentOpening.target(for: "@file:/srv/agent/out.csv", fileExists: exists) == .unavailable(name: "out.csv"))
    #expect(AttachmentOpening.target(for: "@image:photo.png", fileExists: exists) == .unavailable(name: "photo.png"))
    #expect(AttachmentOpening.target(for: "/api/files/chart.png", fileExists: exists) == .gatewayFile(path: "/api/files/chart.png", name: "chart.png"))
    #expect(AttachmentOpening.target(for: "api/files/a/b.pdf", fileExists: exists) == .gatewayFile(path: "/api/files/a/b.pdf", name: "b.pdf"))

    for escape in ["/api/files/../secret", "/api/files/%2e%2e/secret", "/api/files/a\\b", "/api/files/", "/api/files//x", "/api/files/./x"] {
      if case .gatewayFile = AttachmentOpening.target(for: escape, fileExists: { _ in false }) {
        Issue.record("\(escape) must not be fetched")
      }
    }
  }

  @Test("a file the gateway serves is fetched through the session and kept for Quick Look")
  func attachmentFetched() async throws {
    let harness = SessionHarness()
    let bytes = Data("%PDF-1.7 hermie".utf8)
    harness.link.setFiles { $0 == "/api/files/report.pdf" ? bytes : nil }

    let result = await harness.session.prepareAttachment("/api/files/report.pdf")
    guard case .preview(let url) = result else {
      Issue.record("expected a preview, got \(result)")
      return
    }

    #expect(url.lastPathComponent == "report.pdf")
    #expect(try Data(contentsOf: url) == bytes)
    #expect(harness.link.fileCalls == ["/api/files/report.pdf"])

    #expect(await harness.session.prepareAttachment("/api/files/missing.pdf") == .failed(name: "missing.pdf"))
    #expect(await harness.session.prepareAttachment("@file:/srv/x.txt", fileExists: { _ in false }) == .unavailable(name: "x.txt"))
    #expect(harness.link.fileCalls.count == 2, "a path only on the gateway's disk is never asked for")
    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
  }
}
