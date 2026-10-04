import Foundation

extension GatewaySession {
  /// The Kanban plugin's routes over this session's REST side; nil for a link with no REST side (a
  /// test's scripted one), which has no boards to show.
  public var kanbanService: KanbanService? {
    (link as? any GatewayREST).map { KanbanService(rest: $0) }
  }

  /// The model behind the Boards list. The caller keeps it: it holds what was read.
  public func kanbanBoards() -> KanbanBoardsModel? {
    kanbanService.map { KanbanBoardsModel(backend: $0) }
  }

  /// The model behind one board.
  public func kanbanBoard(_ slug: String) -> KanbanBoardModel? {
    kanbanService.map { KanbanBoardModel(backend: $0, board: slug) }
  }
}
