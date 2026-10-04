import Foundation
import HermieProtocol

/**
 The Kanban plugin's answers, as the Boards pages read them (`kanban-controller.ts` in the Expo app,
 `plugins/kanban/dashboard/plugin_api.py` on the gateway).

 Kanban is a PLUGIN, and all of it is REST: there is no socket method for it (the `/kanban` slash
 command answers prose, and `ui_meta` has no list semantics). A gateway without the plugin answers 404
 on every route, which is "this gateway has no Kanban", never an empty board.

 Four things here are not what a board app would assume, and every one is a place a client silently does
 the wrong thing:

 - **Columns are a server-owned constant.** A card's column IS its `status`. There is no create-column,
   no reorder-column and no column id.
 - **There is no card ORDER.** No position, no rank anywhere in the schema: the server sorts by priority
   (highest first) and then age, so the only way to move a card within a column is to change its priority.
 - **Three columns are not drop targets.** `running` and `review` are claimed by the dispatcher and
   `scheduled` needs a wake-up time no client can attach; the gateway refuses `running` outright (400).
 - **Create cannot choose a column.** `CreateTaskBody` has no `status`: the server derives `triage` or
   `ready`, so landing a card anywhere else is a second call.
 */
public enum KanbanColumns {
  /// The board's columns, left to right, in the plugin's own order. Archived is not one of them: it is a
  /// filter that adds a ninth column only on request.
  public static let standard = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]

  /// Columns a card may leave but never be dropped into: the dispatcher's two and the one that needs a
  /// wake-up time.
  public static let locked: Set<String> = ["review", "running", "scheduled"]

  /// Whether a card may be put in `column`, so no menu offers a move that could only be refused.
  public static func canDrop(into column: String) -> Bool {
    !locked.contains(column)
  }
}

/// One board on the gateway. `slug` is what every other call addresses it by.
public struct KanbanBoard: Sendable, Equatable, Identifiable {
  public var slug: String
  public var name: String
  public var description: String
  /// The server's own current-board pointer. Read, never written: it is shared with the CLI and the
  /// desktop app, and a phone that moved it would move the board out from under somebody's terminal.
  public var isCurrent: Bool
  /// Cards excluding archived ones.
  public var total: Int

  public var id: String { slug }

  public init(slug: String, name: String? = nil, description: String = "", isCurrent: Bool = false, total: Int = 0) {
    self.slug = slug
    self.name = name.flatMap { $0.isEmpty ? nil : $0 } ?? slug
    self.description = description
    self.isCurrent = isCurrent
    self.total = total
  }

  init?(row: JSONValue) {
    guard let object = row.objectValue, let slug = object["slug"]?.stringValue, !slug.isEmpty else {
      return nil
    }

    self.init(
      slug: slug,
      // `name` is nullable on the wire and the slug is always there, so a board with no display name is
      // drawn under its handle rather than blank.
      name: object["name"]?.stringValue.map { CapabilityText.line($0, limit: SecurePrompt.nameLimit) },
      description: CapabilityText.line(object["description"]?.stringValue, limit: 300),
      isCurrent: object["is_current"]?.boolValue == true,
      total: object["total"]?.intValue ?? 0
    )
  }
}

/// One card, reduced to what the app draws. The wire row carries far more.
public struct KanbanCard: Sendable, Equatable, Identifiable {
  public var id: String
  public var title: String
  public var body: String
  /// The column. A card's status IS its column.
  public var status: String
  public var assignee: String?
  /// Higher sorts first. The only lever over a card's place in its column.
  public var priority: Int
  /// Epoch SECONDS, as everything on this router is.
  public var createdAt: Date?
  public var latestSummary: String?
  public var commentCount: Int

  public init(
    id: String, title: String = "", body: String = "", status: String = "todo", assignee: String? = nil,
    priority: Int = 0, createdAt: Date? = nil, latestSummary: String? = nil, commentCount: Int = 0
  ) {
    self.id = id
    self.title = title
    self.body = body
    self.status = status
    self.assignee = assignee
    self.priority = priority
    self.createdAt = createdAt
    self.latestSummary = latestSummary
    self.commentCount = commentCount
  }

  /// A wire task. A task is the card's text as the person or a bot wrote it, so it is kept whole (the
  /// view draws plain text); only the lines that sit in a list row are bounded.
  init(task: JSONValue?) {
    let object = task?.objectValue ?? [:]

    func text(_ key: String) -> String? {
      object[key]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    }

    self.init(
      id: object["id"]?.stringValue ?? "",
      title: text("title") ?? "",
      body: text("body") ?? "",
      status: text("status") ?? "todo",
      assignee: text("assignee"),
      priority: object["priority"]?.intValue ?? 0,
      createdAt: object["created_at"]?.doubleValue.map { Date(timeIntervalSince1970: $0) },
      latestSummary: text("latest_summary"),
      commentCount: object["comment_count"]?.intValue ?? 0
    )
  }
}

/// One column of a board.
public struct KanbanLane: Sendable, Equatable, Identifiable {
  public var name: String
  /// Whether a card may be put here, so the UI never offers a refusal.
  public var droppable: Bool
  public var cards: [KanbanCard]

  public var id: String { name }
}

/// One board's columns and cards, in the server's order. The columns come back in the plugin's order and
/// the app keeps it: it neither reorders them nor invents one, and a status the plugin grows later
/// appears rather than being dropped by a client that thought it knew the list.
public struct KanbanBoardView: Sendable, Equatable {
  public var lanes: [KanbanLane]
  /// Who cards can be assigned to, as the board reports them.
  public var assignees: [String]

  public init(lanes: [KanbanLane] = [], assignees: [String] = []) {
    self.lanes = lanes
    self.assignees = assignees
  }

  public init(_ body: JSONValue?) {
    let object = body?.objectValue ?? [:]

    self.init(
      lanes: (object["columns"]?.arrayValue ?? []).compactMap { column in
        guard let column = column.objectValue, let name = column["name"]?.stringValue else {
          return nil
        }

        return KanbanLane(
          name: name,
          droppable: KanbanColumns.canDrop(into: name),
          cards: (column["tasks"]?.arrayValue ?? []).map { KanbanCard(task: $0) }
        )
      },
      assignees: (object["assignees"]?.arrayValue ?? []).compactMap(\.stringValue)
    )
  }

  /// The card with `id`, wherever it is.
  public func card(_ id: String) -> KanbanCard? {
    for lane in lanes {
      if let card = lane.cards.first(where: { $0.id == id }) {
        return card
      }
    }

    return nil
  }

  public var isEmpty: Bool {
    lanes.allSatisfy(\.cards.isEmpty)
  }
}

public struct KanbanComment: Sendable, Equatable, Identifiable {
  public var id: String
  public var author: String
  public var body: String
  public var createdAt: Date?

  init(row: JSONValue) {
    let object = row.objectValue ?? [:]

    id = object["id"]?.intValue.map(String.init) ?? object["id"]?.stringValue ?? UUID().uuidString
    author = CapabilityText.line(object["author"]?.stringValue, limit: SecurePrompt.nameLimit)
    body = object["body"]?.stringValue ?? ""
    createdAt = object["created_at"]?.doubleValue.map { Date(timeIntervalSince1970: $0) }
  }

  public init(id: String, author: String, body: String, createdAt: Date? = nil) {
    self.id = id
    self.author = author
    self.body = body
    self.createdAt = createdAt
  }
}

/// One card with its comments. Comments are only ever read through the task.
public struct KanbanCardDetail: Sendable, Equatable {
  public var card: KanbanCard
  public var comments: [KanbanComment]

  public init(card: KanbanCard, comments: [KanbanComment] = []) {
    self.card = card
    self.comments = comments
  }

  init(_ body: JSONValue?) {
    card = KanbanCard(task: body?["task"])
    comments = (body?["comments"]?.arrayValue ?? []).map { KanbanComment(row: $0) }
  }
}

/// What a card is made from.
public struct KanbanCardInput: Sendable, Equatable {
  public var title: String
  public var body: String
  public var assignee: String?
  public var priority: Int?
  /// The column it should land in. Create has no say over it, so a column other than `ready` or `triage`
  /// is a second call.
  public var column: String

  public init(title: String, body: String = "", assignee: String? = nil, priority: Int? = nil, column: String = "ready") {
    self.title = title
    self.body = body
    self.assignee = assignee
    self.priority = priority
    self.column = column
  }
}

/// A change to a card's own fields. Never its status: moving owns that.
public struct KanbanCardEdit: Sendable, Equatable {
  public var title: String?
  public var body: String?
  public var assignee: String?
  public var priority: Int?

  public init(title: String? = nil, body: String? = nil, assignee: String? = nil, priority: Int? = nil) {
    self.title = title
    self.body = body
    self.assignee = assignee
    self.priority = priority
  }

  var json: JSONObject {
    var json: JSONObject = [:]

    if let title { json["title"] = .string(title) }
    if let body { json["body"] = .string(body) }
    if let assignee { json["assignee"] = .string(assignee) }
    if let priority { json["priority"] = .number(Double(priority)) }

    return json
  }
}
