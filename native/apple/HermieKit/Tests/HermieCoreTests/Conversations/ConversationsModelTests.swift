import Foundation
import HermieGateway
import Testing

@testable import HermieCore

@MainActor
private func loaded(_ backend: StubConversations = StubConversations()) async -> (ConversationsModel, StubConversations) {
  backend.set(ConversationFixture.groups)
  let model = ConversationsModel(bot: "researcher", backend: backend)
  await model.load()

  return (model, backend)
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct ConversationsModelTests {
  // MARK: Reading

  @Test func startsLoadingAndThenHoldsTheGroups() async {
    let backend = StubConversations()
    backend.set(ConversationFixture.groups)
    let model = ConversationsModel(bot: "researcher", backend: backend)

    #expect(model.phase == .loading)
    await model.load()

    #expect(model.phase == .ready(ConversationFixture.groups))
    #expect(model.groups?.canonical?.id == "cur")
  }

  @Test func aFailedFirstReadSaysWhy() async {
    let backend = StubConversations()
    backend.fail("list", GatewayRPCError(.rejected, "profile not found"))
    let model = ConversationsModel(bot: "researcher", backend: backend)

    await model.load()

    #expect(model.phase == .failed("profile not found"))
  }

  @Test func aFailedRefreshKeepsTheListOnScreenAndSaysSo() async {
    let (model, backend) = await loaded()
    backend.fail("list", GatewayRPCError(.timeout, "request timed out"))

    await model.load()

    #expect(model.groups == ConversationFixture.groups)
    #expect(model.notice == .failed(message: "request timed out", busy: false))
  }

  @Test func aReadThatANewerOneOvertookIsDropped() async throws {
    let backend = StubConversations()
    backend.set(ConversationGroups(past: [ConversationFixture.conversation("old")]))
    backend.hold("list")
    let model = ConversationsModel(bot: "researcher", backend: backend)

    let first = Task { await model.load() }
    try await eventually("the first read to be in the air") { backend.isHolding }

    backend.set(ConversationGroups(past: [ConversationFixture.conversation("new")]))
    await model.load()
    #expect(model.groups?.past.map(\.id) == ["new"])

    backend.release()
    await first.value

    #expect(model.groups?.past.map(\.id) == ["new"], "the older answer must not overwrite the newer one")
  }

  // MARK: Rename

  @Test func renameOpensWithTheTitleAndCommitsTheDraft() async throws {
    let (model, backend) = await loaded()
    let trip = try #require(model.groups?.conversation(id: "p1"))

    model.beginRename(trip)
    #expect(model.mode == .rename(id: "p1", draft: "Trip planning"))
    #expect(model.subject?.id == "p1")

    model.setDraft("Lisbon trip")
    await model.commitRename()

    #expect(backend.calls == ["list", "rename p1 Lisbon trip", "list"])
    #expect(model.notice == .renamed)
    #expect(model.mode == nil)
  }

  @Test func aRefusedRenameKeepsTheFieldOpenAndCarriesTheGatewaysReason() async throws {
    let (model, backend) = await loaded()
    backend.fail("rename", GatewayRPCError(.rejected, "Title 'Trip' is already in use by session s-9"))

    model.beginRename(try #require(model.groups?.conversation(id: "p1")))
    model.setDraft("Trip")
    await model.commitRename()

    #expect(model.notice == .failed(message: "Title 'Trip' is already in use by session s-9", busy: false))
    #expect(model.mode == .rename(id: "p1", draft: "Trip"))
  }

  @Test func cancellingClosesTheFieldAndWritesNothing() async throws {
    let (model, backend) = await loaded()

    model.beginRename(try #require(model.groups?.conversation(id: "p1")))
    model.cancel()
    await model.commitRename()

    #expect(model.mode == nil)
    #expect(backend.calls == ["list"])
  }

  // MARK: Delete

  @Test func deleteAsksFirstAndOnlyTheConfirmationDeletes() async throws {
    let (model, backend) = await loaded()
    let past = try #require(model.groups?.conversation(id: "p2"))

    model.beginDelete(past)
    #expect(model.mode == .confirmDelete(id: "p2"))
    #expect(backend.calls == ["list"], "asking is not deleting")

    await model.confirmDelete()

    #expect(backend.calls == ["list", "delete p2", "list"])
    #expect(model.notice == .deleted)
    #expect(model.mode == nil)
  }

  @Test func aRefusedDeleteSaysWhyAndKeepsTheListAsItWas() async throws {
    let (model, backend) = await loaded()
    backend.fail("delete", GatewayRPCError(.rejected, "session is live"))

    model.beginDelete(try #require(model.groups?.conversation(id: "br")))
    await model.confirmDelete()

    #expect(model.notice == .failed(message: "session is live", busy: false))
    #expect(model.groups == ConversationFixture.groups)
  }

  // MARK: The canonical conversation

  @Test func theCurrentConversationCannotBeRenamedDeletedOrAdopted() async throws {
    let (model, backend) = await loaded()
    let current = try #require(model.groups?.canonical)

    model.beginRename(current)
    model.beginDelete(current)
    #expect(model.mode == nil)

    await model.adopt(current)
    await model.commitRename()
    await model.confirmDelete()

    #expect(backend.calls == ["list"])
  }

  @Test func anActionOnARowThatIsNoLongerListedDoesNothing() async throws {
    let (model, backend) = await loaded()
    let trip = try #require(model.groups?.conversation(id: "p1"))
    model.beginDelete(trip)
    backend.set(ConversationGroups(past: []))
    await model.load()

    await model.confirmDelete()

    #expect(backend.calls == ["list", "list"])
  }

  // MARK: Make current

  @Test func makingAConversationTheBotChatRunsAtOnceAndReadsTheListAgain() async throws {
    let (model, backend) = await loaded()

    await model.adopt(try #require(model.groups?.conversation(id: "p1")))

    #expect(backend.calls == ["list", "adopt p1", "list"])
    #expect(model.notice == .adopted)
  }

  @Test func aReplyInFlightIsItsOwnRefusal() async throws {
    let (model, backend) = await loaded()
    backend.fail("adopt", ConversationBusyError(botName: "researcher"))

    await model.adopt(try #require(model.groups?.conversation(id: "p1")))

    guard case .failed(_, let busy)? = model.notice else {
      Issue.record("expected a refusal, got \(String(describing: model.notice))")
      return
    }

    #expect(busy)
  }

  // MARK: One of the reader's own chats

  @Test func anOwnChatIsOpenedAsTheBotsChatAtOnceAndTheScreenGoesBackToIt() async throws {
    let (model, backend) = await loaded()
    backend.set(
      ConversationGroups(
        canonical: ConversationFixture.groups.canonical,
        mine: [ConversationFixture.conversation("m1", "Chat · Ada · Trip", kind: .mine)]))
    await model.load()

    await model.useHere(try #require(model.groups?.conversation(id: "m1")))

    #expect(backend.calls.suffix(3) == ["list", "useHere m1", "list"])
    #expect(model.notice == .usingHere)
    #expect(model.switched == 1)
  }

  @Test func onlyAnOwnChatCanBeOpenedThisWay() async throws {
    let (model, backend) = await loaded()

    await model.useHere(try #require(model.groups?.conversation(id: "p1")))
    await model.useHere(try #require(model.groups?.conversation(id: "cur")))

    #expect(backend.calls == ["list"])
    #expect(model.switched == 0)
  }

  @Test func aRefusedSwitchIsSaidAndNothingIsCounted() async throws {
    let (model, backend) = await loaded()
    backend.set(ConversationGroups(mine: [ConversationFixture.conversation("m1", "Chat · Ada", kind: .mine)]))
    await model.load()
    backend.fail("useHere", ConversationBusyError(botName: "researcher"))

    await model.useHere(try #require(model.groups?.conversation(id: "m1")))

    guard case .failed(_, let busy)? = model.notice else {
      Issue.record("expected a refusal, got \(String(describing: model.notice))")
      return
    }

    #expect(busy)
    #expect(model.switched == 0)
  }

  // MARK: New conversation

  @Test func aNewConversationAsksFirstAndThenSendsTheScreenBackToTheChat() async {
    let (model, backend) = await loaded()

    model.beginNew()
    #expect(model.mode == .confirmNew)
    #expect(model.startedNew == 0)

    await model.confirmNew()

    #expect(backend.calls == ["list", "startNew", "list"])
    #expect(model.startedNew == 1)
    #expect(model.notice == nil)
    #expect(model.mode == nil)
  }

  @Test func aRefusedNewConversationStaysOnThePage() async {
    let (model, backend) = await loaded()
    backend.fail("startNew", GatewayRPCError(.rejected, "no session for you"))

    model.beginNew()
    await model.confirmNew()

    #expect(model.startedNew == 0)
    #expect(model.notice == .failed(message: "no session for you", busy: false))
  }

  @Test func confirmingWithNoQuestionOpenStartsNothing() async {
    let (model, backend) = await loaded()

    await model.confirmNew()

    #expect(backend.calls == ["list"])
  }

  // MARK: One at a time

  @Test func aSecondActionWhileOneRunsIsIgnored() async throws {
    let (model, backend) = await loaded()
    let p1 = try #require(model.groups?.conversation(id: "p1"))
    let p2 = try #require(model.groups?.conversation(id: "p2"))

    // The swap is slow: the gateway has the call and has not answered.
    backend.hold("adopt")
    let first = Task { await model.adopt(p1) }
    try await eventually("the first action to be in the air") { backend.isHolding }

    #expect(model.busy)
    model.beginDelete(p2)
    #expect(model.mode == nil, "a question cannot be opened while an action runs")
    model.beginNew()
    #expect(model.mode == nil)
    await model.adopt(p2)
    #expect(backend.calls.filter { $0.hasPrefix("adopt") } == ["adopt p1"])

    backend.release()
    await first.value

    #expect(!model.busy)
    #expect(model.notice == .adopted)
  }

  // MARK: Gateway text

  @Test func aGatewayRefusalIsPlainTextBoundedAndOnOneLine() async throws {
    let (model, backend) = await loaded()
    backend.fail("delete", GatewayRPCError(.rejected, "line one\nline two \u{202E}" + String(repeating: "x", count: 5000)))

    model.beginDelete(try #require(model.groups?.conversation(id: "p1")))
    await model.confirmDelete()

    guard case .failed(let message, _)? = model.notice else {
      Issue.record("expected a refusal")
      return
    }

    #expect(!message.contains("\n"))
    #expect(!message.unicodeScalars.contains("\u{202E}"))
    #expect(message.count < 1000)
  }
}
