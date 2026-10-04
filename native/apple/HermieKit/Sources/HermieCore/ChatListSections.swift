import Foundation
import Observation

/**
 What the chat list draws out of the arrangement and the rows, as a value (`listView` in the web
 client's `arrangement-list.ts`, whose rules these are):

 - **The roster says which chats exist.** A chat the layout holds and the rows do not have is not
 drawn, and the order around it is not disturbed.
 - **A chat the layout has not placed yet** (new on the gateway, not folded in yet) comes at the end
 of the loose top-level run, before the first folder, in the rows' order; with no layout at all the
 list is the rows'.
 - **Pinned chats are held at the top of their container**: the loose pinned chats lead the top
 level, a folder's pinned chats lead that folder; each group keeps the order it had.
 - **Archived chats leave the list** wherever they were, and are returned apart, in the order the
 layout would have drawn them.
 - **A folder with nothing to show** (empty, or every chat in it archived or filtered out) is not
 drawn: the list is for opening chats, and Settings is where folders are managed.

 The top level is returned as blocks, because a list draws the loose chats between two folders as
 a run of their own: the pinned loose chats first, then the layout's order, a folder a block and the
 loose chats between folders a run. Nothing here reads a clock or a store.
 */
public struct ChatListSections<Row> {
  /// One folder as the list draws it.
  public struct Folder {
    public var id: String
    public var name: String
    public var colour: BotAccent
    /// What is in it that can be shown, pinned first.
    public var chats: [Row]
  }

  public enum Block {
    /// A run of loose chats: `key` is the run's place (`pinned`, or `run-n`), steady while chats
    /// move inside it.
    case chats(key: String, rows: [Row])
    case folder(Folder)
  }

  public var blocks: [Block]
  /// The archived chats, in the order the layout would have drawn them.
  public var archived: [Row]
  /// The sets of chats that can step past each other: a container's pinned chats, and its others.
  /// Each is in the order drawn; the loose chats on both sides of a folder are one set.
  public let moveGroups: [[String]]
  /// Chat to the folder it is drawn in; a loose chat is not in here.
  public let containers: [String: String]

  /// Every chat on the list, in the order drawn, a collapsed folder's included.
  public var visible: [Row] {
    blocks.flatMap { block -> [Row] in
      switch block {
      case .chats(_, let rows): rows
      case .folder(let folder): folder.chats
      }
    }
  }

  /// The chats a chat can move among with one step (or a drop within its run), or just itself.
  public func moveGroup(of name: String) -> [String] {
    moveGroups.first { $0.contains(name) } ?? [name]
  }

  /// The folders drawn, in order.
  public var folders: [Folder] {
    blocks.compactMap { if case .folder(let folder) = $0 { folder } else { nil } }
  }

  fileprivate init(blocks: [Block], archived: [Row], moveGroups: [[String]], containers: [String: String]) {
    self.blocks = blocks
    self.archived = archived
    self.moveGroups = moveGroups
    self.containers = containers
  }

  /// Where one step up and one step down land for a chat, within its set; nil at the set's edge.
  public func steps(of name: String) -> (up: ChatListArrangement.Anchor?, down: ChatListArrangement.Anchor?) {
    let group = moveGroup(of: name)

    guard let index = group.firstIndex(of: name) else {
      return (nil, nil)
    }

    return (
      index > 0 ? .before(group[index - 1]) : nil,
      index + 1 < group.count ? .after(group[index + 1]) : nil
    )
  }

  /**
   Where a drag between rows lands, as `onMove` reports it: `names` are the rows of one run or one
   folder as drawn, `destination` a gap among them. The drop is held to the set of chats the chat can
   move among (a pinned chat stays among the pinned ones): a drop across the line lands at the set's
   edge. Nil when there is nowhere to land.
   */
  public func dropAnchor(moving name: String, in names: [String], at destination: Int) -> ChatListArrangement.Anchor? {
    let members = Set(moveGroup(of: name))
    let indices = names.indices.filter { members.contains(names[$0]) }

    guard let first = indices.first, let last = indices.last else {
      return nil
    }

    let group = first..<(last + 1)
    return ChatListArrangement.Anchor.forDrop(names, group: group, at: min(max(destination, group.lowerBound), group.upperBound))
  }

  /**
   Where a chat dropped onto another chat's row lands, in whatever container the other is in: right
   after it when it is in the same container and above it now, otherwise right before it. Nil when it
   is dropped on itself or would cross the pinned line within one container.
   */
  public func dropAnchor(moving name: String, onto target: String) -> ChatListArrangement.Anchor? {
    guard name != target else {
      return nil
    }

    if containers[name] == containers[target] {
      let group = moveGroup(of: name)

      guard let from = group.firstIndex(of: name), let to = group.firstIndex(of: target) else {
        return nil
      }

      return from < to ? .after(target) : .before(target)
    }

    return .before(target)
  }
}

extension ChatListSections.Block: Identifiable {
  public var id: String {
    switch self {
    case .chats(let key, _): key
    case .folder(let folder): ChatListSections.blockID(folder: folder.id)
    }
  }
}

extension ChatListSections {
  /// The identity of a folder's block, which a list scrolls to.
  public static func blockID(folder id: String) -> String {
    "folder:\(id)"
  }
}

extension ChatListSections.Folder: Identifiable {}

extension ChatListArrangement {
  /// The rows (the roster, narrowed by a search or not) drawn over the layout.
  public func sections<Row>(_ rows: [Row], name: (Row) -> String) -> ChatListSections<Row> {
    var byName: [String: Row] = [:]
    var rowOrder: [String] = []

    for row in rows where byName[name(row)] == nil {
      byName[name(row)] = row
      rowOrder.append(name(row))
    }

    let placed = Set(layout.placed)
    var top = layout.entries
    let unplaced = rowOrder.filter { !placed.contains($0) }.map(ChatEntry.chat)
    let firstFolder = top.firstIndex { if case .folder = $0 { true } else { false } } ?? top.count
    top.insert(contentsOf: unplaced, at: firstFolder)

    let pins = Set(pinned)
    var pinnedLoose: [Row] = []
    var archivedRows: [Row] = []
    var blocks: [ChatListSections<Row>.Block] = []
    var run: [Row] = []
    var runs = 0
    var groups: [[String]] = []
    var unpinnedLoose: [String] = []
    var containers: [String: String] = [:]

    func flushRun() {
      guard !run.isEmpty else {
        return
      }

      blocks.append(.chats(key: "run-\(runs)", rows: run))
      runs += 1
      run = []
    }

    for entry in top {
      switch entry {
      case .chat(let bot):
        guard let row = byName[bot] else {
          continue
        }

        if isArchived(bot) {
          archivedRows.append(row)
        } else if pins.contains(bot) {
          pinnedLoose.append(row)
        } else {
          run.append(row)
          unpinnedLoose.append(bot)
        }

      case .folder(let id):
        guard let folder = layout.folder(id) else {
          continue
        }

        var inside: [Row] = []

        for bot in folder.bots {
          guard let row = byName[bot] else {
            continue
          }

          if isArchived(bot) {
            archivedRows.append(row)
          } else {
            inside.append(row)
          }
        }

        // A folder with nothing to show is not drawn, and does not split the run around it.
        guard !inside.isEmpty else {
          continue
        }

        flushRun()

        let chats = pinnedFirst(inside, name: name)
        blocks.append(.folder(.init(id: folder.id, name: folder.name, colour: folder.colour, chats: chats)))
        let names = chats.map(name)

        for bot in names {
          containers[bot] = folder.id
        }

        groups.append(names.filter(pins.contains))
        groups.append(names.filter { !pins.contains($0) })

      case .other:
        continue
      }
    }

    flushRun()

    if !pinnedLoose.isEmpty {
      blocks.insert(.chats(key: "pinned", rows: pinnedLoose), at: 0)
    }

    groups.append(pinnedLoose.map(name))
    groups.append(unpinnedLoose)

    return ChatListSections(blocks: blocks, archived: archivedRows, moveGroups: groups.filter { !$0.isEmpty }, containers: containers)
  }
}

/**
 Which folders the person has closed, on this device. A folder's state is the reader's choice for
 this screen and is not synced (`collapsed` stays local in the web client too); the ids are a
 gateway's own, so each gateway keeps its own set.

 It reads and writes its own key in the `UserDefaults` it is given, so a closed folder is closed
 again after a relaunch. A search shows every folder open without touching what is kept.
 */
@MainActor
@Observable
public final class ChatFolderCollapse {
  public static let defaultsKey = "hermie.chatList.collapsedFolders"

  /// Gateway id to the folder ids closed on it.
  public private(set) var closed: [String: Set<String>]

  @ObservationIgnored private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    closed = Self.read(defaults)
  }

  public func isCollapsed(_ folder: String, gateway: String) -> Bool {
    closed[gateway]?.contains(folder) ?? false
  }

  public func setCollapsed(_ collapsed: Bool, folder: String, gateway: String) {
    var set = closed[gateway] ?? []

    if collapsed {
      set.insert(folder)
    } else {
      set.remove(folder)
    }

    closed[gateway] = set.isEmpty ? nil : set
    save()
  }

  public func toggle(_ folder: String, gateway: String) {
    setCollapsed(!isCollapsed(folder, gateway: gateway), folder: folder, gateway: gateway)
  }

  private func save() {
    let plain = closed.mapValues { $0.sorted() }

    if plain.isEmpty {
      defaults.removeObject(forKey: Self.defaultsKey)
    } else {
      defaults.set(plain, forKey: Self.defaultsKey)
    }
  }

  private static func read(_ defaults: UserDefaults) -> [String: Set<String>] {
    guard let stored = defaults.dictionary(forKey: defaultsKey) as? [String: [String]] else {
      return [:]
    }

    return stored.mapValues { Set($0) }.filter { !$0.value.isEmpty }
  }
}
