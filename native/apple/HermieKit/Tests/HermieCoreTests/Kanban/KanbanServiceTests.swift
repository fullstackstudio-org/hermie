import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@Suite(.timeLimit(.minutes(1))) struct KanbanServiceTests {
  private let rest = StubREST()
  private var service: KanbanService { KanbanService(rest: rest) }

  private static let boardBody = """
    {"columns": [
       {"name": "triage", "tasks": []},
       {"name": "todo", "tasks": [{"id": "t_1", "title": "Write notes", "body": "From the changelog.", "status": "todo", "assignee": "writer", "priority": 2, "created_at": 1760000000, "comment_count": 1}]},
       {"name": "running", "tasks": [{"id": "t_2", "title": "Tidy", "status": "running", "priority": 0, "created_at": 1760000075}]},
       {"name": "done", "tasks": []}],
     "assignees": ["writer"]}
    """

  // MARK: Types

  @Test func aBoardIsKnownByItsSlugAndNamedByItsNameWhenItHasOne() throws {
    let board = try #require(
      KanbanBoard(row: jsonValue(#"{"slug": "default", "name": "Default", "description": "", "is_current": true, "total": 3}"#)))
    let unnamed = try #require(KanbanBoard(row: jsonValue(#"{"slug": "sprint", "name": null, "total": 0}"#)))

    #expect(board.name == "Default")
    #expect(board.isCurrent)
    #expect(board.total == 3)
    #expect(unnamed.name == "sprint", "a board with no display name is drawn under its handle")
    #expect(KanbanBoard(row: jsonValue(#"{"name": "no slug"}"#)) == nil)
  }

  @Test func aBoardKeepsTheServersColumnOrderAndMarksTheDispatchersAsNotDroppable() {
    let view = KanbanBoardView(jsonValue(Self.boardBody))

    #expect(view.lanes.map(\.name) == ["triage", "todo", "running", "done"])
    #expect(view.lanes.map(\.droppable) == [true, true, false, true])
    #expect(view.assignees == ["writer"])
    #expect(view.card("t_1")?.title == "Write notes")
    #expect(view.card("t_1")?.priority == 2)
    #expect(view.card("t_2")?.status == "running")
    #expect(view.card("nope") == nil)
    #expect(view.isEmpty == false)
  }

  @Test func aStatusThePluginGrowsLaterAppearsAsAColumnInsteadOfBeingDropped() {
    let view = KanbanBoardView(jsonValue(#"{"columns": [{"name": "icebox", "tasks": []}]}"#))

    #expect(view.lanes.map(\.name) == ["icebox"])
    #expect(view.lanes.first?.droppable == true)
  }

  @Test func aCardReadsEpochSecondsAndKeepsAnEmptyBodyAsEmpty() throws {
    let card = KanbanCard(task: jsonValue(#"{"id": "t_9", "title": "X", "body": null, "created_at": 1760000000, "latest_summary": "Done."}"#))

    #expect(card.body == "")
    #expect(card.createdAt == Date(timeIntervalSince1970: 1_760_000_000))
    #expect(card.latestSummary == "Done.")
    #expect(card.status == "todo", "a card with no status is a to-do")
  }

  @Test func theLockedColumnsAreTheDispatchersAndTheOneThatNeedsAWakeUpTime() {
    #expect(KanbanColumns.locked == ["review", "running", "scheduled"])
    #expect(KanbanColumns.canDrop(into: "ready"))
    #expect(KanbanColumns.canDrop(into: "running") == false)
    #expect(KanbanColumns.standard.count == 8)
  }

  // MARK: Reading

  @Test func theBoardsAreReadFromTheListRoute() async throws {
    rest.answer("GET", "/api/plugins/kanban/boards", with: jsonValue(#"{"boards": [{"slug": "default", "total": 1}], "current": "default"}"#))

    #expect(try await service.boards().map(\.slug) == ["default"])
  }

  @Test func aBoardIsAskedForByItsSlugAndNeverSwitched() async throws {
    rest.answer("GET", "/api/plugins/kanban/board?board=default", with: jsonValue(Self.boardBody))
    rest.answer("GET", "/api/plugins/kanban/board?include_archived=true&board=default", with: jsonValue(Self.boardBody))

    _ = try await service.board("default", includeArchived: false)
    _ = try await service.board("default", includeArchived: true)

    #expect(rest.calls.allSatisfy { $0.method == "GET" })
    #expect(rest.calls.allSatisfy { !$0.path.contains("switch") })
  }

  @Test func aCardIsReadWithItsComments() async throws {
    rest.answer(
      "GET", "/api/plugins/kanban/tasks/t_1?board=default",
      with: jsonValue(
        #"{"task": {"id": "t_1", "title": "Write notes"}, "comments": [{"id": 1, "author": "writer", "body": "Started.", "created_at": 1760000100}]}"#))

    let detail = try await service.card("t_1", on: "default")

    #expect(detail.card.title == "Write notes")
    #expect(detail.comments.map(\.body) == ["Started."])
    #expect(detail.comments.first?.author == "writer")
  }

  @Test func aSlugAndAnIdAreEncodedAsOneComponentEach() {
    #expect(service.taskPath("t 1/x", "my board") == "/api/plugins/kanban/tasks/t%201%2Fx?board=my%20board")
    #expect(KanbanService.query("") == "", "no board named means the plugin's own current one")
  }

  // MARK: Writing

  @Test func aMoveSendsTheStatusAndNothingElseAndAnswersWhereTheCardLanded() async throws {
    rest.answer(
      "PATCH", "/api/plugins/kanban/tasks/t_1?board=default", with: jsonValue(#"{"task": {"id": "t_1", "status": "review"}}"#))
    rest.answer("POST", "/api/plugins/kanban/dispatch?board=default", with: jsonValue(#"{"spawned": []}"#))

    let landed = try await service.move("t_1", on: "default", to: "ready")

    #expect(landed == "review", "the applied status, which is not always the requested one")
    #expect(rest.calls.first?.body == ["status": "ready"])
    #expect(rest.calls.last?.path == "/api/plugins/kanban/dispatch?board=default", "a write nudges the dispatcher")
  }

  @Test func aCardMadeForTheColumnTheServerDerivesCostsOneCall() async throws {
    rest.answer(
      "POST", "/api/plugins/kanban/tasks?board=default", with: jsonValue(#"{"task": {"id": "t_3", "title": "X", "status": "ready"}}"#))

    let made = try await service.create(KanbanCardInput(title: "X", column: "ready"), on: "default")

    #expect(made.status == "ready")
    #expect(rest.calls.filter { $0.method == "PATCH" }.isEmpty)
    #expect(rest.calls.first?.body?["triage"] == nil)
  }

  @Test func aCardMadeForTriageSaysTriageAndAnyOtherColumnIsASecondCall() async throws {
    rest.answer(
      "POST", "/api/plugins/kanban/tasks?board=default", with: jsonValue(#"{"task": {"id": "t_3", "title": "X", "status": "triage"}}"#))
    rest.answer(
      "PATCH", "/api/plugins/kanban/tasks/t_3?board=default", with: jsonValue(#"{"task": {"id": "t_3", "status": "blocked"}}"#))

    _ = try await service.create(KanbanCardInput(title: "X", column: "triage"), on: "default")
    #expect(rest.calls.first?.body?["triage"] == true)
    #expect(rest.calls.filter { $0.method == "PATCH" }.isEmpty, "triage is already where the server put it")

    let moved = try await service.create(
      KanbanCardInput(title: "X", body: "notes", assignee: "writer", priority: 3, column: "blocked"), on: "default")

    #expect(moved.status == "blocked")

    let posts = rest.calls.filter { $0.method == "POST" && $0.path.hasPrefix("/api/plugins/kanban/tasks") }
    let second = try #require(posts.last?.body)

    #expect(second["body"] == "notes")
    #expect(second["assignee"] == "writer")
    #expect(second["priority"] == 3)
    #expect(second["status"] == nil, "create has no status field")
    #expect(rest.calls.contains { $0.method == "PATCH" && $0.body == ["status": "blocked"] })
  }

  @Test func anEditSendsOnlyTheFieldsItChangesAndNeverTheStatus() async throws {
    rest.answer("PATCH", "/api/plugins/kanban/tasks/t_1?board=default", with: jsonValue(#"{"task": {"id": "t_1", "title": "New"}}"#))

    _ = try await service.edit("t_1", on: "default", KanbanCardEdit(title: "New", priority: 5))

    #expect(rest.calls.first?.body == ["title": "New", "priority": 5])
  }

  @Test func archivingIsAStatusNotADelete() async throws {
    rest.answer("PATCH", "/api/plugins/kanban/tasks/t_1?board=default", with: jsonValue(#"{"task": {"id": "t_1", "status": "archived"}}"#))

    try await service.archive("t_1", on: "default")

    #expect(rest.calls.first?.method == "PATCH")
    #expect(rest.calls.first?.body == ["status": "archived"])
    #expect(rest.calls.allSatisfy { $0.method != "DELETE" }, "DELETE removes the row and its history for good")
  }

  @Test func aCommentIsByHermieNotByTheDashboard() async throws {
    rest.answer("POST", "/api/plugins/kanban/tasks/t_1/comments?board=default", with: jsonValue(#"{"ok": true}"#))

    try await service.comment("On it.", on: "t_1", board: "default")

    #expect(rest.calls.first?.body == ["author": "hermie", "body": "On it."])
  }

  @Test func aRefusalPropagatesWithItsStatusAndTheSentenceTheServerGave() async {
    rest.refuse(
      "PATCH", "/api/plugins/kanban/tasks/t_2?board=default",
      with: GatewayError(
        .protocol, "PATCH failed with HTTP 409.", status: 409,
        hint: "Cannot move to 'ready': blocked by parent(s) not done — 'Write notes' (t_1, status=todo)"))

    let error = await #expect(throws: GatewayError.self) {
      try await service.move("t_2", on: "default", to: "ready")
    }

    #expect(error?.status == 409)
    #expect(error.map { CapabilityText.words(of: $0) }?.contains("blocked by parent(s) not done") == true)
  }
}
