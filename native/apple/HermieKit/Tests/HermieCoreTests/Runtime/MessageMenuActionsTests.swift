import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// What the message menu's lines do on the chat: Regenerate on the newest reply, Branch from here
/// (`session.branch`), and Edit and resend through the composer.
@Suite("Message menu actions", .timeLimit(.minutes(1))) @MainActor
struct MessageMenuActionsTests {
  private static func visible(_ item: TranscriptItem, _ presentation: Presentation = .full) -> VisibleItem {
    VisibleItem(item: item, presentation: presentation)
  }

  private static func user(_ id: String, _ text: String, author: String? = nil) -> VisibleItem {
    visible(MessageMenuTests.turn(id, text, author: author))
  }

  private static func reply(_ id: String, _ text: String = "an answer", interim: Bool = false) -> VisibleItem {
    visible(MessageMenuTests.reply(id, text, interim: interim))
  }

  private static func snapshot(_ items: [VisibleItem], turnActive: Bool = false, revision: Int = 1_000) -> ChatSnapshot {
    ChatSnapshot(
      key: bot, items: items, hydration: .live, busy: turnActive, turnActive: turnActive,
      activity: turnActive ? .working : .idle, openRequests: [], queue: [], attached: true, canLoadOlder: false,
      revision: revision)
  }

  // MARK: Which reply may be regenerated

  @Test("only the newest reply, with a prompt of the reader's own before it and none after")
  func regenerateTarget() {
    let items = [Self.user("u1", "first"), Self.reply("a1"), Self.user("u2", "second"), Self.reply("a2")]
    #expect(ChatModel.regenerateTarget(in: items, authors: .untrusted) == "a2")

    // A prompt after the reply: that reply is history.
    let moved = items + [Self.user("u3", "third")]
    #expect(ChatModel.regenerateTarget(in: moved, authors: .untrusted) == nil)

    #expect(ChatModel.regenerateTarget(in: [Self.reply("a1")], authors: .untrusted) == nil, "no prompt to repeat")
    #expect(ChatModel.regenerateTarget(in: [], authors: .untrusted) == nil)
  }

  @Test("an interim note, a placeholder and a demoted reply are not the reply to regenerate")
  func skipped() {
    let items = [
      Self.user("u1", "ask"), Self.reply("a1"), Self.reply("note", interim: true),
      Self.visible(MessageMenuTests.reply("chip", "demoted"), .chip),
      Self.visible(MessageMenuTests.reply("gone", "hidden"), .hiddenPlaceholder)
    ]
    #expect(ChatModel.regenerateTarget(in: items, authors: .untrusted) == "a1")
  }

  @Test("never when the newest prompt is a colleague's: their words would go out under the reader's name")
  func colleaguesPrompt() {
    let items = [Self.user("u1", "mine", author: "oidc:me"), Self.user("u2", "theirs", author: "oidc:sam"), Self.reply("a1")]
    #expect(ChatModel.regenerateTarget(in: items, authors: RetryAuthors(trusted: true, own: "oidc:me")) == nil)
    #expect(ChatModel.regenerateTarget(in: items, authors: RetryAuthors(trusted: true, own: "oidc:sam")) == "a1")
    #expect(ChatModel.regenerateTarget(in: items, authors: .untrusted) == "a1")
  }

  // MARK: Regenerate

  @Test("Regenerate sends the reply's prompt again; an older reply, or a running turn, sends nothing")
  func regenerate() async throws {
    let harness = SessionHarness()
    try await harness.start()
    try await harness.open()
    try await harness.frame()
    harness.link.respond(to: RPC.PromptSubmit.name, with: ["status": "streaming"])
    let model = harness.session.chat(bot)
    let items = [Self.user("u1", "first"), Self.reply("a1"), Self.user("u2", "second"), Self.reply("a2")]

    model.apply(Self.snapshot(items, turnActive: true, revision: 1_000))
    #expect(await model.regenerate("a2") == .busy)
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)

    model.apply(Self.snapshot(items, revision: 1_001))
    #expect(await model.regenerate("a1") == .nothing, "an older reply is history")
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)

    #expect(await model.regenerate("a2") == .resent("second"))
    let submits = harness.link.calls(RPC.PromptSubmit.name)
    #expect(submits.count == 1)
    #expect(submits.first?.params.objectValue?["text"]?.stringValue == "second")
    await harness.session.shutdown()
  }

  // MARK: The menu's context

  @Test("the context says what the chat says now: the target, a running turn, and whether it can fork")
  func context() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    try await harness.frame()
    let items = [Self.user("u1", "ask"), Self.reply("a1")]

    model.apply(Self.snapshot(items, turnActive: true))
    var context = model.menuContext(authors: .untrusted, blocked: true, canEdit: true, canBranch: true)
    #expect(context.regenerateTarget == "a1")
    #expect(context.turnActive)
    #expect(context.blocked)
    #expect(context.canEdit)

    // The chat has no socket under it: nothing can be forked.
    model.connectionReady = false
    context = model.menuContext(authors: .untrusted, blocked: false, canEdit: true, canBranch: true)
    #expect(!context.canBranch)
    model.connectionReady = true
    context = model.menuContext(authors: .untrusted, blocked: false, canEdit: true, canBranch: true)
    #expect(context.canBranch)
    await harness.session.shutdown()
  }

  // MARK: Branch from here

  @Test("Branch from the reply asks session.branch for the runtime session, the profile, a title and the count")
  func branchFromReply() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    try await harness.frame()
    let reply = try #require(model.items.last { if case .assistant = $0.item { true } else { false } })

    let branching = Task { await model.branch(from: reply.item.id) }
    let call = try await harness.link.pendingCall(RPC.SessionBranch.name)
    #expect(call.params["session_id"] == .string(Fixture.runtime))
    #expect(call.params["profile"] == .string(bot))
    #expect(call.params["name"] == "Branch · row 2")
    #expect(call.params["count"] == 2, "two rows up to and including the reply")
    harness.link.answer(
      call,
      ["session_id": "rt-child", "stored_session_id": "child-1", "title": "Branch · row 2 (2)", "message_count": 2])

    let outcome = await branching.value
    guard case .branched(let conversation) = outcome else {
      Issue.record("expected a branch, got \(outcome)")
      return
    }
    #expect(conversation.id == "child-1")
    #expect(conversation.resolvedID == "child-1")
    #expect(conversation.title == "Branch · row 2 (2)", "the title the gateway settled on")
    #expect(conversation.messageCount == 2)
    #expect(conversation.kind == .branch)
    await harness.session.shutdown()
  }

  @Test("Branch from the reader's own turn keeps the rows up to it")
  func branchFromTurn() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    try await harness.frame()
    let turn = try #require(model.items.first { if case .user = $0.item { true } else { false } })

    let branching = Task { await model.branch(from: turn.item.id) }
    let call = try await harness.link.pendingCall(RPC.SessionBranch.name)
    #expect(call.params["count"] == 1)
    #expect(call.params["name"] == "Branch · row 1")
    harness.link.answer(call, ["stored_session_id": "child-2"])

    guard case .branched(let conversation) = await branching.value else {
      Issue.record("expected a branch")
      return
    }
    #expect(conversation.title == "Branch · row 1", "without a title in the answer, the one asked for")
    await harness.session.shutdown()
  }

  @Test("a second press while the first is on its way asks nothing")
  func branchOnce() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    try await harness.frame()
    let reply = try #require(model.items.last)

    let first = Task { await model.branch(from: reply.item.id) }
    let call = try await harness.link.pendingCall(RPC.SessionBranch.name)

    #expect(await model.branch(from: reply.item.id) == .nothing)
    harness.link.answer(call, ["stored_session_id": "child-1"])
    guard case .branched = await first.value else {
      Issue.record("expected a branch")
      return
    }
    #expect(harness.link.calls(RPC.SessionBranch.name).count == 1)
    await harness.session.shutdown()
  }

  @Test("a refused branch says why and leaves the chat as it was; so does an answer without an id")
  func branchRefused() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    try await harness.frame()
    let reply = try #require(model.items.last)

    let refused = Task { await model.branch(from: reply.item.id) }
    let call = try await harness.link.pendingCall(RPC.SessionBranch.name)
    harness.link.fail(call, GatewayRPCError(.rejected, "branching is off", code: 4030))
    #expect(await refused.value == .failed("branching is off"))
    #expect(model.lastError == nil, "the line over the chat says it, not the banner")

    let empty = Task { await model.branch(from: reply.item.id) }
    let next = try await harness.link.pendingCall(RPC.SessionBranch.name) { $0.id != call.id }
    harness.link.answer(next, ["title": "Branch"])
    guard case .failed = await empty.value else {
      Issue.record("an answer without the child's id is a failure")
      return
    }
    await harness.session.shutdown()
  }

  @Test("a message that is not in the transcript, or a chat with no session, branches nothing")
  func branchNothing() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)

    #expect(await model.branch(from: "gone") == .nothing)
    #expect(harness.link.calls(RPC.SessionBranch.name).isEmpty)

    // Items on screen but no runtime session under the chat.
    model.apply(Self.snapshot([Self.user("u1", "ask"), Self.reply("a1")]))
    guard case .failed = await model.branch(from: "a1") else {
      Issue.record("a chat with no session cannot be forked")
      return
    }
    #expect(harness.link.calls(RPC.SessionBranch.name).isEmpty)
    await harness.session.shutdown()
  }

  // MARK: Edit and resend

  @Test("Edit and resend puts the words in the field, after a draft that is already there, and asks for focus")
  func editAndResend() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let composer = ComposerModel(session: harness.session, bot: bot)

    #expect(composer.editAndResend("write a haiku"))
    #expect(composer.draft == "write a haiku")
    #expect(composer.focusRequests == 1)

    composer.type("and also")
    #expect(composer.editAndResend("again"))
    #expect(composer.draft == "and also\nagain", "a draft is never thrown away")
    #expect(composer.focusRequests == 2)

    #expect(!composer.editAndResend("  \n "))
    #expect(composer.draft == "and also\nagain")
    await harness.session.shutdown()
  }

  @Test("Edit and resend changes nothing while a request has the composer or a turn runs")
  func editAndResendRefused() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let composer = ComposerModel(session: harness.session, bot: bot)

    composer.held = true
    #expect(!composer.editAndResend("write a haiku"))
    #expect(composer.draft.isEmpty, "words typed over a secure prompt must not wait in the field")
    #expect(composer.focusRequests == 0)

    composer.held = false
    harness.session.chat(bot).apply(Self.snapshot([Self.user("u1", "ask")], turnActive: true))
    #expect(!composer.editAndResend("write a haiku"))
    #expect(composer.draft.isEmpty)
    await harness.session.shutdown()
  }

  // MARK: Focus asked for before the field exists

  @Test("a focus request waits for the field when none was on screen to act on it, and is taken once")
  func focusWaitsForTheField() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let composer = ComposerModel(session: harness.session, bot: bot)

    #expect(!composer.focusWaiting)
    #expect(!composer.takeFocusWaiting())

    // An "Ask a bot" link opens a chat whose composer is built after the request.
    composer.requestFocus()
    #expect(composer.focusRequests == 1)
    #expect(composer.focusWaiting)
    #expect(composer.takeFocusWaiting(), "the field takes it when it appears")
    #expect(!composer.takeFocusWaiting(), "once")

    // Words put back from outside move the caret on their own and leave nothing waiting.
    #expect(composer.editAndResend("write a haiku"))
    #expect(!composer.focusWaiting)
    await harness.session.shutdown()
  }
}
