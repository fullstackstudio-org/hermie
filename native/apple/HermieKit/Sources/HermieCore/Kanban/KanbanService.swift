import Foundation
import HermieGateway
import HermieProtocol

/**
 The Kanban plugin's routes (`/api/plugins/kanban/…`, `plugin_api.py` on the gateway).

 **Every board-scoped call carries `?board=<slug>`, and none of them ever switches the board.** The
 plugin's `POST /boards/{slug}/switch` moves the server's own current-board pointer, which is shared with
 the CLI and the desktop app; upstream says dashboard users pick boards client-side for exactly that
 reason.

 What a refusal looks like: 404 without a `detail` is "the plugin is not mounted" and 404 WITH one is the
 router answering about one missing card; 400 and 409 carry the plugin's own sentence in `detail`
 (`_patch_status` names the blocking parents, "blocked by parent(s) not done — 'Title' (t_ab12cd34,
 status=todo)"), which reaches here as the error's `hint` and is shown verbatim, because nothing on this
 side can work out which parent is in the way.
 */
public protocol KanbanBackend: Sendable {
  func boards() async throws -> [KanbanBoard]
  func board(_ slug: String, includeArchived: Bool) async throws -> KanbanBoardView
  func card(_ id: String, on slug: String) async throws -> KanbanCardDetail
  /// Move a card to another column; the column it LANDED in, which is not always the one asked for.
  func move(_ id: String, on slug: String, to column: String) async throws -> String
  func create(_ input: KanbanCardInput, on slug: String) async throws -> KanbanCard
  func edit(_ id: String, on slug: String, _ edit: KanbanCardEdit) async throws -> KanbanCard
  func archive(_ id: String, on slug: String) async throws
  func comment(_ body: String, on id: String, board slug: String) async throws
  /// Ask the dispatcher to look now rather than on its next 60-second tick. Fire and forget.
  func nudge(_ slug: String) async
}

public struct KanbanService: KanbanBackend {
  public static let route = "/api/plugins/kanban"
  /// Who a comment from this app is by. The server defaults to `dashboard`, which would label a phone's
  /// comment as the web dashboard's.
  public static let author = "hermie"

  let rest: any GatewayREST

  public init(rest: any GatewayREST) {
    self.rest = rest
  }

  public func boards() async throws -> [KanbanBoard] {
    let body = try await rest.restJSON("GET", "\(Self.route)/boards", body: nil)

    return (body?["boards"]?.arrayValue ?? []).compactMap { KanbanBoard(row: $0) }
  }

  public func board(_ slug: String, includeArchived: Bool) async throws -> KanbanBoardView {
    KanbanBoardView(
      try await rest.restJSON(
        "GET", "\(Self.route)/board" + Self.query(slug, includeArchived ? [("include_archived", "true")] : []),
        body: nil))
  }

  public func card(_ id: String, on slug: String) async throws -> KanbanCardDetail {
    KanbanCardDetail(try await rest.restJSON("GET", taskPath(id, slug), body: nil))
  }

  /// `PATCH /tasks/{id}` with `{status}` and nothing else: there is no position to send, because there is
  /// no order to change. The APPLIED status comes back, and is not always the requested one:
  /// `_set_status_direct` consults `_retry_status_for_run` when a card leaves `running`, so a card moved to
  /// `ready` can legitimately land in `review` or `todo`.
  public func move(_ id: String, on slug: String, to column: String) async throws -> String {
    let task = try await patch(id, slug, ["status": .string(column)])

    return task?["status"]?.stringValue ?? column
  }

  /// Two calls where the column is not the one the server derives: `triage: true` lands in `triage` and
  /// everything else in `ready`. The second call is skipped when the derived column is already the wanted
  /// one, so the common cases cost one round trip.
  public func create(_ input: KanbanCardInput, on slug: String) async throws -> KanbanCard {
    var body: JSONObject = ["title": .string(input.title)]

    if !input.body.isEmpty { body["body"] = .string(input.body) }
    if let assignee = input.assignee, !assignee.isEmpty { body["assignee"] = .string(assignee) }
    if let priority = input.priority { body["priority"] = .number(Double(priority)) }
    // The only lever create has over the landing column.
    if input.column == "triage" { body["triage"] = true }

    let made = KanbanCard(
      task: try await rest.restJSON("POST", "\(Self.route)/tasks" + Self.query(slug), body: .object(body))?["task"])

    await nudge(slug)

    if made.id.isEmpty || made.status == input.column {
      return made
    }

    return KanbanCard(task: try await patch(made.id, slug, ["status": .string(input.column)]))
  }

  /// A card's own fields: a merge, so what is not sent keeps its value. Never its status.
  public func edit(_ id: String, on slug: String, _ edit: KanbanCardEdit) async throws -> KanbanCard {
    KanbanCard(task: try await patch(id, slug, edit.json))
  }

  /// `status: "archived"` and NOT `DELETE /tasks/{id}`: the plugin routes the archived status past the
  /// verb table to `archive_task`, which is recoverable, while the delete route removes the row and its
  /// history for good. These are not the same act.
  public func archive(_ id: String, on slug: String) async throws {
    _ = try await patch(id, slug, ["status": "archived"])
  }

  /// The route answers `{ok: true}` and NOT the comment it made, so the caller reads the card again.
  public func comment(_ body: String, on id: String, board slug: String) async throws {
    _ = try await rest.restJSON(
      "POST", taskPath(id, slug, suffix: "/comments"),
      body: .object(["author": .string(Self.author), "body": .string(body)]))
  }

  public func nudge(_ slug: String) async {
    _ = try? await rest.restJSON("POST", "\(Self.route)/dispatch" + Self.query(slug), body: .object([:]))
  }

  // MARK: Plumbing

  /// One PATCH. Every write goes through here so the dispatcher nudge is in one place.
  private func patch(_ id: String, _ slug: String, _ body: JSONObject) async throws -> JSONValue? {
    let answer = try await rest.restJSON("PATCH", taskPath(id, slug), body: .object(body))

    await nudge(slug)

    return answer?["task"]
  }

  func taskPath(_ id: String, _ slug: String, suffix: String = "") -> String {
    "\(Self.route)/tasks/\(RESTPath.segment(id))\(suffix)" + Self.query(slug)
  }

  /// `?board=<slug>`, and any other items, each value percent-encoded as one component.
  static func query(_ slug: String, _ extra: [(String, String)] = []) -> String {
    var items = extra

    if !slug.isEmpty {
      items.append(("board", slug))
    }

    return items.isEmpty ? "" : "?" + CapabilityText.query(items)
  }
}
