import Foundation
import Observation

/// The boards of the gateway's Kanban plugin: the list the Boards page opens on.
@MainActor
@Observable
public final class KanbanBoardsModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    /// The plugin is not mounted: a state, never an empty board.
    case missing
    case failed(String)
  }

  public private(set) var phase = Phase.loading
  public private(set) var boards: [KanbanBoard] = []
  /// A refresh that failed while a list was on screen: the list stays and this says so.
  public private(set) var notice: String?

  @ObservationIgnored private let backend: any KanbanBackend
  @ObservationIgnored private var round = 0

  public init(backend: any KanbanBackend) {
    self.backend = backend
  }

  public func load() async {
    round += 1
    let mine = round

    do {
      let read = try await backend.boards()

      if round == mine {
        boards = read
        phase = .ready
        notice = nil
      }
    } catch {
      guard round == mine else {
        return
      }

      if CapabilityText.isMissingRoute(error) {
        phase = .missing
      } else if phase == .ready {
        notice = CapabilityText.words(of: error)
      } else {
        phase = .failed(CapabilityText.words(of: error))
      }
    }
  }

  public func dismissNotice() {
    notice = nil
  }
}

/**
 One board: its columns and cards, a card's detail and comments, and the writes (move, create, edit,
 comment, archive).

 ## Nothing is patched

 A write is followed by a read of the board. The plugin answers the card it changed, but a move can land
 elsewhere than asked and every card's neighbours move with it, so the read is the source of truth. The
 one thing the model does by itself is mark a card busy while its write runs.

 ## A move is checked here and decided there

 A move to a column the dispatcher owns is not sent: the model says so and sends nothing. Everything else
 is the plugin's to refuse, and it does so in a sentence naming what is in the way (the parents that are
 not done), which is shown as it came.

 Every text here is the gateway's or a bot's: plain text, never Markdown. A read that a newer one
 overtook is dropped.
 */
@MainActor
@Observable
public final class KanbanBoardModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    /// The board is not there (404): it was removed since the list was read.
    case notFound
    case failed(String)
  }

  /// What the last write said.
  public enum Notice: Equatable, Sendable {
    case moved(column: String)
    /// The board put the card somewhere other than where it was asked to.
    case movedElsewhere(asked: String, got: String)
    case lockedTarget(column: String)
    /// A refusal or a failure, in the plugin's own words.
    case words(String)
    case archived
  }

  public enum Detail: Equatable, Sendable {
    case loading
    case loaded(KanbanCardDetail)
    case failed(String)
  }

  public let board: String
  public private(set) var phase = Phase.loading
  public private(set) var view = KanbanBoardView()
  public private(set) var includeArchived = false
  public private(set) var notice: Notice?
  /// Cards with a write in flight.
  public private(set) var busy: Set<String> = []
  /// A card is being made.
  public private(set) var creating = false
  public private(set) var details: [String: Detail] = [:]

  @ObservationIgnored private let backend: any KanbanBackend
  @ObservationIgnored private var round = 0

  public init(backend: any KanbanBackend, board: String) {
    self.backend = backend
    self.board = board
  }

  // MARK: Reading

  /// Every column the board shows, in the plugin's order.
  public var lanes: [KanbanLane] { view.lanes }

  /// Where a card can be put: the columns that are not the dispatcher's, other than its own.
  public func targets(for card: KanbanCard) -> [String] {
    view.lanes.map(\.name).filter { $0 != card.status && KanbanColumns.canDrop(into: $0) && $0 != "archived" }
  }

  public func load() async {
    round += 1
    let mine = round

    do {
      let read = try await backend.board(board, includeArchived: includeArchived)

      if round == mine {
        view = read
        phase = .ready
      }
    } catch {
      guard round == mine else {
        return
      }

      if CapabilityText.isMissingRoute(error) {
        phase = .notFound
      } else if phase == .ready {
        notice = .words(CapabilityText.words(of: error))
      } else {
        phase = .failed(CapabilityText.words(of: error))
      }
    }
  }

  public func setIncludeArchived(_ include: Bool) async {
    guard include != includeArchived else {
      return
    }

    includeArchived = include
    await load()
  }

  /// A card with its comments. A detail already on screen stays while it is read again.
  public func loadDetail(_ id: String) async {
    if case .loaded = details[id] {
      // Stays on screen while it is read again.
    } else {
      details[id] = .loading
    }

    do {
      details[id] = .loaded(try await backend.card(id, on: board))
    } catch {
      if case .loaded = details[id] {
        notice = .words(CapabilityText.words(of: error))
      } else {
        details[id] = .failed(CapabilityText.words(of: error))
      }
    }
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: Writing

  /// Move a card to another column; true when the card is now in that column. A column the dispatcher
  /// owns is not sent.
  @discardableResult
  public func move(_ card: KanbanCard, to column: String) async -> Bool {
    guard column != card.status else {
      return false
    }

    guard KanbanColumns.canDrop(into: column) else {
      notice = .lockedTarget(column: column)

      return false
    }

    return await mutate(card.id) {
      let landed = try await self.backend.move(card.id, on: self.board, to: column)

      self.notice = landed == column ? .moved(column: column) : .movedElsewhere(asked: column, got: landed)

      return landed == column
    }
  }

  /// Make a card; true when the plugin did.
  @discardableResult
  public func create(_ input: KanbanCardInput) async -> Bool {
    let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !creating, !title.isEmpty else {
      return false
    }

    creating = true
    notice = nil
    defer { creating = false }

    var made = input

    made.title = title

    do {
      _ = try await backend.create(made, on: board)
    } catch {
      notice = .words(CapabilityText.words(of: error))

      return false
    }

    await load()

    return true
  }

  /// Save a card's own fields; true when the plugin did.
  @discardableResult
  public func edit(_ id: String, _ edit: KanbanCardEdit) async -> Bool {
    await mutate(id) {
      _ = try await self.backend.edit(id, on: self.board, edit)
      await self.loadDetail(id)

      return true
    }
  }

  /// Archive a card, which keeps it and its history and is not a delete. The caller has asked first.
  @discardableResult
  public func archive(_ id: String) async -> Bool {
    await mutate(id) {
      try await self.backend.archive(id, on: self.board)
      self.details[id] = nil
      self.notice = .archived

      return true
    }
  }

  /// Add a comment; true when the plugin took it. The comment is not in the answer, so the card is read
  /// again to show it.
  @discardableResult
  public func comment(_ id: String, _ body: String) async -> Bool {
    let text = body.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !text.isEmpty else {
      return false
    }

    return await mutate(id) {
      try await self.backend.comment(text, on: id, board: self.board)
      await self.loadDetail(id)

      return true
    }
  }

  /// One write on a card: marked busy, its failure reported in the plugin's words, the board read again.
  private func mutate(_ id: String, _ work: () async throws -> Bool) async -> Bool {
    guard !busy.contains(id) else {
      return false
    }

    busy.insert(id)
    notice = nil
    defer { busy.remove(id) }

    let result: Bool

    do {
      result = try await work()
    } catch {
      notice = .words(CapabilityText.words(of: error))

      return false
    }

    await load()

    return result
  }
}
