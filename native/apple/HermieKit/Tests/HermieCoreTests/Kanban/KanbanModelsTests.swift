import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A Kanban plugin as the models see it: boards, one board's cards, a log of what was asked, and errors
/// and a landing column a test can arm.
final class StubKanban: KanbanBackend, Sendable {
  struct State {
    var boards = [KanbanBoard(slug: "default", name: "Default", total: 2)]
    var cards = [
      KanbanCard(id: "t_1", title: "Write notes", status: "todo", priority: 1),
      KanbanCard(id: "t_2", title: "Ship it", status: "todo", priority: 2)
    ]
    var comments: [String: [KanbanComment]] = [:]
    var calls: [String] = []
    var failing: [String: any Error] = [:]
    /// Where a move lands when it is not where it was asked to.
    var landsIn: String?
    var armed: String?
    var held: CheckedContinuation<Void, Never>?
  }

  let state = Mutex(State())

  var calls: [String] { state.withLock { $0.calls } }

  func fail(_ method: String, _ error: any Error) {
    state.withLock { $0.failing[method] = error }
  }

  func heal(_ method: String) {
    state.withLock { $0.failing[method] = nil }
  }

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

  private func record(_ call: String, method: String) async throws {
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

  func boards() async throws -> [KanbanBoard] {
    let boards = state.withLock { $0.boards }
    try await record("boards", method: "boards")

    return boards
  }

  func board(_ slug: String, includeArchived: Bool) async throws -> KanbanBoardView {
    let cards = state.withLock { $0.cards }
    try await record("board \(slug)\(includeArchived ? " archived" : "")", method: "board")

    var names = KanbanColumns.standard

    if includeArchived {
      names.append("archived")
    }

    return KanbanBoardView(
      lanes: names.map { name in
        KanbanLane(
          name: name, droppable: KanbanColumns.canDrop(into: name), cards: cards.filter { $0.status == name })
      },
      assignees: ["writer"])
  }

  func card(_ id: String, on slug: String) async throws -> KanbanCardDetail {
    let (card, comments) = state.withLock { state in (state.cards.first { $0.id == id }, state.comments[id] ?? []) }
    try await record("card \(id)", method: "card")

    return KanbanCardDetail(card: card ?? KanbanCard(id: id), comments: comments)
  }

  func move(_ id: String, on slug: String, to column: String) async throws -> String {
    try await record("move \(id) \(column)", method: "move")

    return state.withLock { state in
      let landed = state.landsIn ?? column

      if let index = state.cards.firstIndex(where: { $0.id == id }) {
        state.cards[index].status = landed
      }

      return landed
    }
  }

  func create(_ input: KanbanCardInput, on slug: String) async throws -> KanbanCard {
    try await record("create \(input.title) \(input.column)", method: "create")

    return state.withLock { state in
      let card = KanbanCard(id: "t_\(state.cards.count + 1)", title: input.title, status: input.column)

      state.cards.append(card)

      return card
    }
  }

  func edit(_ id: String, on slug: String, _ edit: KanbanCardEdit) async throws -> KanbanCard {
    try await record("edit \(id)", method: "edit")

    return state.withLock { state in
      guard let index = state.cards.firstIndex(where: { $0.id == id }) else {
        return KanbanCard(id: id)
      }

      if let title = edit.title { state.cards[index].title = title }
      if let priority = edit.priority { state.cards[index].priority = priority }

      return state.cards[index]
    }
  }

  func archive(_ id: String, on slug: String) async throws {
    try await record("archive \(id)", method: "archive")
    state.withLock { state in
      if let index = state.cards.firstIndex(where: { $0.id == id }) {
        state.cards[index].status = "archived"
      }
    }
  }

  func comment(_ body: String, on id: String, board slug: String) async throws {
    try await record("comment \(id)", method: "comment")
    state.withLock { state in
      state.comments[id, default: []].append(KanbanComment(id: "\((state.comments[id]?.count ?? 0) + 1)", author: "hermie", body: body))
    }
  }

  func nudge(_ slug: String) async {}
}

@MainActor
private func opened() async -> (KanbanBoardModel, StubKanban) {
  let backend = StubKanban()
  let model = KanbanBoardModel(backend: backend, board: "default")
  await model.load()

  return (model, backend)
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct KanbanBoardsModelTests {
  @Test func startsLoadingAndThenHoldsTheBoards() async {
    let backend = StubKanban()
    let model = KanbanBoardsModel(backend: backend)

    #expect(model.phase == .loading)
    await model.load()

    #expect(model.phase == .ready)
    #expect(model.boards.map(\.slug) == ["default"])
  }

  @Test func aGatewayWithoutThePluginIsAStateNotAnEmptyList() async {
    let backend = StubKanban()
    backend.fail("boards", GatewayError(.protocol, "no endpoint", status: 404))
    let model = KanbanBoardsModel(backend: backend)

    await model.load()

    #expect(model.phase == .missing)
    #expect(model.boards.isEmpty)
  }

  @Test func aFailedFirstReadIsAFailureAndAFailedRefreshKeepsTheList() async {
    let backend = StubKanban()
    backend.fail("boards", GatewayError(.server, "HTTP 502", status: 502))
    let model = KanbanBoardsModel(backend: backend)

    await model.load()
    #expect(model.phase == .failed("HTTP 502"))

    backend.heal("boards")
    await model.load()
    #expect(model.phase == .ready)

    backend.fail("boards", GatewayError(.server, "HTTP 502", status: 502))
    await model.load()

    #expect(model.phase == .ready)
    #expect(model.boards.count == 1)
    #expect(model.notice == "HTTP 502")
    model.dismissNotice()
    #expect(model.notice == nil)
  }
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct KanbanBoardModelTests {
  // MARK: Reading

  @Test func holdsTheBoardsLanesInTheServersOrder() async {
    let (model, _) = await opened()

    #expect(model.phase == .ready)
    #expect(model.lanes.map(\.name) == KanbanColumns.standard)
    #expect(model.lanes.first { $0.name == "todo" }?.cards.map(\.id) == ["t_1", "t_2"])
  }

  @Test func theArchivedColumnIsAskedForAndReadAgain() async {
    let (model, backend) = await opened()

    await model.setIncludeArchived(true)
    #expect(model.lanes.last?.name == "archived")
    #expect(backend.calls.last == "board default archived")

    await model.setIncludeArchived(true)
    #expect(backend.calls.filter { $0.hasPrefix("board") }.count == 2, "no change, no read")

    await model.setIncludeArchived(false)
    #expect(model.lanes.last?.name == "done")
  }

  @Test func aBoardThatIsGoneAndAFailureAreToldApart() async {
    let backend = StubKanban()
    backend.fail("board", GatewayError(.protocol, "no endpoint", status: 404))
    let model = KanbanBoardModel(backend: backend, board: "default")

    await model.load()
    #expect(model.phase == .notFound)

    backend.fail("board", GatewayError(.network, "no connection"))
    let other = KanbanBoardModel(backend: backend, board: "default")
    await other.load()
    #expect(other.phase == .failed("no connection"))
  }

  @Test func aFailedRefreshOfABoardOnScreenKeepsTheBoardAndSaysSo() async {
    let (model, backend) = await opened()
    backend.fail("board", GatewayError(.server, "HTTP 502", status: 502))

    await model.load()

    #expect(model.phase == .ready)
    #expect(model.lanes.isEmpty == false)
    #expect(model.notice == .words("HTTP 502"))
  }

  @Test func aCardsDetailIsReadWithItsComments() async {
    let (model, backend) = await opened()
    backend.state.withLock { $0.comments["t_1"] = [KanbanComment(id: "1", author: "writer", body: "Started.")] }

    await model.loadDetail("t_1")

    if case .loaded(let detail)? = model.details["t_1"] {
      #expect(detail.card.title == "Write notes")
      #expect(detail.comments.map(\.body) == ["Started."])
    } else {
      Issue.record("expected the card, got \(String(describing: model.details["t_1"]))")
    }
  }

  // MARK: Moving

  @Test func theTargetsAreTheColumnsACardMayBePutInAndNotItsOwn() async {
    let (model, _) = await opened()
    let card = KanbanCard(id: "t_1", status: "todo")

    #expect(model.targets(for: card) == ["triage", "ready", "blocked", "done"])
  }

  @Test func aMoveIsWrittenAndTheBoardReadAgain() async {
    let (model, backend) = await opened()
    let card = KanbanCard(id: "t_1", title: "Write notes", status: "todo")

    #expect(await model.move(card, to: "ready"))

    #expect(model.notice == .moved(column: "ready"))
    #expect(model.lanes.first { $0.name == "ready" }?.cards.map(\.id) == ["t_1"])
    #expect(backend.calls.suffix(2) == ["move t_1 ready", "board default"])
    #expect(model.busy.isEmpty)
  }

  @Test func aMoveToAColumnTheDispatcherOwnsIsNeverSent() async {
    let (model, backend) = await opened()

    #expect(await model.move(KanbanCard(id: "t_1", status: "todo"), to: "running") == false)

    #expect(model.notice == .lockedTarget(column: "running"))
    #expect(backend.calls.filter { $0.hasPrefix("move") }.isEmpty)
  }

  @Test func aMoveToTheColumnItIsAlreadyInIsNothing() async {
    let (model, backend) = await opened()

    #expect(await model.move(KanbanCard(id: "t_1", status: "todo"), to: "todo") == false)
    #expect(model.notice == nil)
    #expect(backend.calls.filter { $0.hasPrefix("move") }.isEmpty)
  }

  @Test func aCardThatLandedElsewhereIsToldAsThatAndIsNotReportedAsMoved() async {
    let (model, backend) = await opened()
    backend.state.withLock { $0.landsIn = "review" }

    #expect(await model.move(KanbanCard(id: "t_1", status: "running"), to: "ready") == false)

    #expect(model.notice == .movedElsewhere(asked: "ready", got: "review"))
  }

  @Test func aRefusedMoveShowsTheSentenceNamingWhatIsInTheWay() async {
    let (model, backend) = await opened()
    backend.fail(
      "move",
      GatewayError(
        .protocol, "PATCH failed with HTTP 409.", status: 409,
        hint: "Cannot move to 'ready': blocked by parent(s) not done — 'Write notes' (t_1, status=todo)"))

    #expect(await model.move(KanbanCard(id: "t_2", status: "todo"), to: "ready") == false)

    #expect(model.notice == .words("Cannot move to 'ready': blocked by parent(s) not done — 'Write notes' (t_1, status=todo)"))
    #expect(backend.calls.last == "move t_2 ready", "a refused write reads nothing back")
  }

  @Test func oneWriteOnACardRunsAtATime() async {
    let (model, backend) = await opened()
    backend.hold("move")
    let card = KanbanCard(id: "t_1", status: "todo")

    let first = Task { await model.move(card, to: "ready") }
    await eventually { backend.isHolding }

    #expect(model.busy == ["t_1"])
    #expect(await model.move(card, to: "done") == false)

    backend.release()
    #expect(await first.value)
    #expect(backend.calls.filter { $0.hasPrefix("move") }.count == 1)
  }

  // MARK: Creating, editing, commenting, archiving

  @Test func aCardIsMadeInTheColumnAskedForAndTheBoardReadAgain() async {
    let (model, backend) = await opened()

    #expect(await model.create(KanbanCardInput(title: "  Fix the build  ", column: "triage")))

    #expect(backend.calls.contains("create Fix the build triage"), "the title is trimmed")
    #expect(model.lanes.first { $0.name == "triage" }?.cards.map(\.title) == ["Fix the build"])
    #expect(model.creating == false)
  }

  @Test func aCardWithNoTitleIsNotMade() async {
    let (model, backend) = await opened()

    #expect(await model.create(KanbanCardInput(title: "   ")) == false)
    #expect(backend.calls.filter { $0.hasPrefix("create") }.isEmpty)
  }

  @Test func aCardThatCouldNotBeMadeSaysWhy() async {
    let (model, backend) = await opened()
    backend.fail("create", GatewayError(.protocol, "HTTP 422", status: 422, hint: "title is required"))

    #expect(await model.create(KanbanCardInput(title: "X")) == false)
    #expect(model.notice == .words("title is required"))
  }

  @Test func anEditSavesTheFieldsAndReadsTheCardAndTheBoardAgain() async {
    let (model, backend) = await opened()

    #expect(await model.edit("t_1", KanbanCardEdit(title: "Write the notes", priority: 4)))

    #expect(backend.calls.suffix(3) == ["edit t_1", "card t_1", "board default"])
    #expect(model.lanes.first { $0.name == "todo" }?.cards.first { $0.id == "t_1" }?.title == "Write the notes")
  }

  @Test func aCommentIsAddedByReadingTheCardAgainBecauseTheAnswerCarriesNone() async {
    let (model, backend) = await opened()

    #expect(await model.comment("t_1", "  On it.  "))

    #expect(backend.calls.contains("card t_1"))

    if case .loaded(let detail)? = model.details["t_1"] {
      #expect(detail.comments.map(\.body) == ["On it."])
    } else {
      Issue.record("expected the card with its comment")
    }

    #expect(await model.comment("t_1", "   ") == false)
  }

  @Test func archivingKeepsTheCardAndLeavesTheBoard() async {
    let (model, backend) = await opened()

    #expect(await model.archive("t_1"))

    #expect(model.notice == .archived)
    #expect(model.lanes.flatMap(\.cards).map(\.id) == ["t_2"], "an archived card is not on the board unless asked for")
    #expect(backend.calls.contains("archive t_1"))
  }
}
