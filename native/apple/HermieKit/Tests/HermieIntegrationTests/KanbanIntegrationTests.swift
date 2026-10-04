#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

extension Integration {
  /// The Boards pages' models against the real fake gateway, over real HTTP: the boards, one board's
  /// columns, every write (move, a refused move, create, edit, comment, archive), and a gateway without the
  /// plugin.
  @Suite("Kanban") @MainActor
  struct KanbanIntegrationTests {
    private func withBoard(
      _ slug: String = "default",
      _ options: FakeGateway.Options = FakeGateway.Options(),
      _ body: @escaping @MainActor @Sendable (GatewaySession, KanbanBoardModel, FakeGateway) async throws -> Void
    ) async throws {
      try await withCapabilitySession(options) { session, gateway in
        let model = try #require(session.kanbanBoard(slug))
        await model.load()

        try await body(session, model, gateway)
      }
    }

    private func lane(_ model: KanbanBoardModel, _ name: String) -> [String] {
      model.lanes.first { $0.name == name }?.cards.map(\.id) ?? []
    }

    @Test("the boards on disk are listed with their card counts")
    func lists() async throws {
      try await withCapabilitySession { session, _ in
        let boards = try #require(session.kanbanBoards())
        await boards.load()

        #expect(boards.phase == .ready)
        #expect(boards.boards.map(\.slug) == ["default", "sprint"])
        #expect(boards.boards.map(\.total) == [3, 0])
        #expect(boards.boards.first?.isCurrent == true)
        #expect(boards.boards.last?.description == "This fortnight")
      }
    }

    @Test("a board has the plugin's columns in its order, cards by priority then age")
    func theBoard() async throws {
      try await withBoard { _, model, _ in
        #expect(model.phase == .ready)
        #expect(model.lanes.map(\.name) == KanbanColumns.standard)
        #expect(model.lanes.map(\.droppable) == [true, true, false, true, false, true, false, true])
        #expect(lane(model, "todo") == ["t_cc33dd44", "t_aa11bb22"], "priority 2 before priority 0")
        #expect(lane(model, "running") == ["t_ee55ff66"])
        #expect(model.view.assignees == ["writer"])
      }
    }

    @Test("a card is moved to a column it may be put in, and the board is read again")
    func moves() async throws {
      try await withBoard { _, model, gateway in
        let card = try #require(model.view.card("t_aa11bb22"))

        #expect(await model.move(card, to: "ready"))
        #expect(model.notice == .moved(column: "ready"))
        #expect(lane(model, "ready") == ["t_aa11bb22"])
        #expect(lane(model, "todo") == ["t_cc33dd44"])

        let state = try await gateway.control("GET", "/__fake/state")

        #expect(state["kanbanDispatches"]?.intValue ?? 0 >= 1, "a write nudges the dispatcher")
      }
    }

    @Test("a move the plugin refuses shows the sentence naming the parent in the way")
    func aBlockedMove() async throws {
      try await withBoard { _, model, _ in
        let card = try #require(model.view.card("t_cc33dd44"))

        #expect(await model.move(card, to: "ready") == false)

        if case .words(let words)? = model.notice {
          #expect(words.contains("blocked by parent(s) not done"))
          #expect(words.contains("t_aa11bb22"))
        } else {
          Issue.record("expected the plugin's sentence, got \(String(describing: model.notice))")
        }

        #expect(lane(model, "todo").contains("t_cc33dd44"), "the card is where it was")
      }
    }

    @Test("a column the dispatcher owns is never sent")
    func lockedColumn() async throws {
      try await withBoard { _, model, gateway in
        let card = try #require(model.view.card("t_aa11bb22"))

        #expect(await model.move(card, to: "running") == false)
        #expect(model.notice == .lockedTarget(column: "running"))

        let state = try await gateway.control("GET", "/__fake/state")

        #expect(state["kanbanDispatches"]?.intValue == 0, "nothing was written, so nothing was nudged")
      }
    }

    @Test("a card is made in a column the server does not derive, with two calls")
    func creates() async throws {
      try await withBoard { _, model, _ in
        #expect(await model.create(KanbanCardInput(title: "Fix the build", body: "It is red.", column: "blocked")))
        #expect(model.view.lanes.first { $0.name == "blocked" }?.cards.map(\.title) == ["Fix the build"])

        #expect(await model.create(KanbanCardInput(title: "Triage me", column: "triage")))
        #expect(model.view.lanes.first { $0.name == "triage" }?.cards.map(\.title) == ["Triage me"])
      }
    }

    @Test("an edit changes the card's own fields and a comment is read back from the card")
    func editsAndComments() async throws {
      try await withBoard { _, model, _ in
        #expect(await model.edit("t_aa11bb22", KanbanCardEdit(title: "Write the notes", priority: 5)))
        #expect(model.view.card("t_aa11bb22")?.title == "Write the notes")
        #expect(model.view.card("t_aa11bb22")?.priority == 5)
        #expect(lane(model, "todo").first == "t_aa11bb22", "priority is the only lever over a place in a column")

        #expect(await model.comment("t_aa11bb22", "On it."))

        guard case .loaded(let detail)? = model.details["t_aa11bb22"] else {
          Issue.record("expected the card, got \(String(describing: model.details["t_aa11bb22"]))")
          return
        }

        #expect(detail.comments.map(\.body) == ["Started on this.", "On it."])
        #expect(detail.comments.last?.author == "hermie", "not the dashboard's name")
      }
    }

    @Test("archiving takes the card off the board and into the archive column on request")
    func archives() async throws {
      try await withBoard { _, model, _ in
        #expect(await model.archive("t_ee55ff66"))
        #expect(model.notice == .archived)
        #expect(model.view.card("t_ee55ff66") == nil)

        await model.setIncludeArchived(true)
        #expect(model.lanes.last?.name == "archived")
        #expect(lane(model, "archived") == ["t_ee55ff66"], "archived, not deleted: the card is still there")
      }
    }

    @Test("an unknown card is a failure of its own and not the plugin being absent")
    func unknownCard() async throws {
      try await withBoard { _, model, _ in
        await model.loadDetail("t_nope")

        if case .failed? = model.details["t_nope"] {
        } else {
          Issue.record("expected a failure, got \(String(describing: model.details["t_nope"]))")
        }

        #expect(model.phase == .ready)
      }
    }

    @Test("a board that was removed is gone, not a failure")
    func unknownBoard() async throws {
      try await withBoard("ghost") { _, model, _ in
        #expect(model.phase == .notFound)
      }
    }

    @Test("a gateway without the Kanban plugin has no boards: missing, not empty")
    func noPlugin() async throws {
      try await withCapabilitySession(FakeGateway.Options(extraArguments: ["--no-kanban"])) { session, _ in
        let boards = try #require(session.kanbanBoards())
        await boards.load()

        #expect(boards.phase == .missing)
        #expect(boards.boards.isEmpty)
      }
    }
  }
}
#endif
