import Foundation
import HermieProtocol

/**
 One folder of the chat list, as the app section's `folders` holds it (`Folder` in `state/folders.ts`
 of the web client): an id the top level names it by, a name, a colour and the chats inside, in order.
 */
public struct ChatFolder: Sendable, Hashable, Identifiable {
  public var id: String
  public var name: String
  /// `.default` is the absence of a choice: it is never stored.
  public var colour: BotAccent
  public var bots: [String]

  public init(id: String, name: String = "", colour: BotAccent = .default, bots: [String] = []) {
    self.id = id
    self.name = name
    self.colour = colour
    self.bots = bots
  }

  /// The longest name the person can give (the web's `maxLength`).
  public static let nameLimit = 64

  /// A name as typed: trimmed, and no longer than the limit.
  public static func cleaned(_ name: String) -> String {
    String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(nameLimit))
  }
}

/// One position at the top level (`LayoutEntry`): a loose chat, or a folder named by its id. An
/// entry of a kind this build does not know is kept where it stands and written back as it came.
public enum ChatEntry: Sendable, Hashable {
  case chat(String)
  case folder(String)
  case other(JSONValue)
}

/**
 The chat list's arrangement as folders: the top level's `entries` and each folder's own list, read
 off the app section, edited as a value and written back (`state/folders.ts` of the web client, whose
 rules these are).

 **A chat is in exactly one place**: loose in `entries`, or inside one folder. `init(app:)` enforces
 that on every read (`normalise`): a chat appears once, the first place winning; a folder's id once;
 a folder named at the top level with no definition is dropped, and one defined but never placed is
 appended, so neither list points at something the other does not have.

 **Which chats exist is the roster's business.** Every edit that has to place a chat the arrangement
 does not hold yet folds the roster in first, at the end of the loose top-level run, as `move` does;
 nothing here ever drops a chat the roster lacks (that is `ChatListArrangement.reconcile`, with a
 roster the gateway answered).

 Fields of a folder this build does not know are carried; so is every entry of an unknown kind.
 */
public struct ChatLayout: Sendable, Hashable {
  public private(set) var entries: [ChatEntry]
  public private(set) var folders: [ChatFolder]
  /// Every other field of each folder, by id.
  private var extras: [String: JSONObject]

  public init(entries: [ChatEntry] = [], folders: [ChatFolder] = []) {
    self.init(entries: entries, folders: folders, extras: [:])
  }

  private init(entries: [ChatEntry], folders: [ChatFolder], extras: [String: JSONObject]) {
    let normal = Self.normalise(entries, folders)
    self.entries = normal.entries
    self.folders = normal.folders
    self.extras = extras
  }

  /// Read off the person's app section, defensively: another build wrote it.
  public init(app: JSONObject?) {
    var entries: [ChatEntry] = []

    for entry in app?[UIMetaField.entries]?.arrayValue ?? [] {
      guard case .object = entry else {
        continue
      }

      switch entry["kind"]?.stringValue {
      case "chat":
        if let name = entry["name"]?.stringValue, !name.isEmpty {
          entries.append(.chat(name))
        }
      case "folder":
        if let id = entry["id"]?.stringValue, !id.isEmpty {
          entries.append(.folder(id))
        }
      default:
        entries.append(.other(entry))
      }
    }

    var folders: [ChatFolder] = []
    var extras: [String: JSONObject] = [:]

    for raw in app?[UIMetaField.folders]?.arrayValue ?? [] {
      guard case .object(let object) = raw, let id = object["id"]?.stringValue, !id.isEmpty else {
        continue
      }

      folders.append(
        ChatFolder(
          id: id,
          name: object["name"]?.stringValue ?? "",
          colour: object["colour"]?.stringValue.flatMap(BotAccent.init(rawValue:)) ?? .default,
          bots: ChatListArrangement.names(object["bots"])
        ))

      if extras[id] == nil {
        extras[id] = object.filter { !Self.knownFolderFields.contains($0.key) }
      }
    }

    self.init(entries: entries, folders: folders, extras: extras)
  }

  private static let knownFolderFields: Set<String> = ["id", "name", "colour", "bots"]

  // MARK: Reading

  public func folder(_ id: String) -> ChatFolder? {
    folders.first { $0.id == id }
  }

  /// The folder holding a chat, or nil when it is loose (or not placed).
  public func folderID(of name: String) -> String? {
    folders.first { $0.bots.contains(name) }?.id
  }

  /// Every chat the layout places, in the order the list draws them.
  public var placed: [String] {
    var out: [String] = []

    for entry in entries {
      switch entry {
      case .chat(let name): out.append(name)
      case .folder(let id): out.append(contentsOf: folder(id)?.bots ?? [])
      case .other: break
      }
    }

    return out
  }

  // MARK: Writing

  /// Put the layout into the section: `entries`, and `folders` (kept as an empty list once the last
  /// folder is gone, when the section had one).
  public func write(into app: inout JSONObject) {
    app[UIMetaField.entries] = .array(entries.map(Self.json))

    if app[UIMetaField.folders] != nil || !folders.isEmpty {
      app[UIMetaField.folders] = .array(folders.map(json))
    }
  }

  private static func json(_ entry: ChatEntry) -> JSONValue {
    switch entry {
    case .chat(let name): ["kind": "chat", "name": .string(name)]
    case .folder(let id): ["kind": "folder", "id": .string(id)]
    case .other(let value): value
    }
  }

  private func json(_ folder: ChatFolder) -> JSONValue {
    var object = extras[folder.id] ?? [:]
    object["id"] = .string(folder.id)
    object["name"] = .string(folder.name)
    object["bots"] = .array(folder.bots.map(JSONValue.string))

    if folder.colour == .default {
      object.removeValue(forKey: "colour")
    } else {
      object["colour"] = .string(folder.colour.rawValue)
    }

    return .object(object)
  }

  // MARK: The invariant

  /// `normalise` of the web client: first place wins, no folder without a definition, no definition
  /// without a place.
  private static func normalise(_ entries: [ChatEntry], _ folders: [ChatFolder]) -> (entries: [ChatEntry], folders: [ChatFolder]) {
    var byID: [String: ChatFolder] = [:]
    var order: [String] = []

    for folder in folders where !folder.id.isEmpty && byID[folder.id] == nil {
      byID[folder.id] = folder
      order.append(folder.id)
    }

    var placedBots = Set<String>()
    var placedFolders = Set<String>()
    var outEntries: [ChatEntry] = []

    for entry in entries {
      switch entry {
      case .folder(let id):
        if byID[id] != nil, placedFolders.insert(id).inserted {
          outEntries.append(entry)
        }
      case .chat(let name):
        if !name.isEmpty, placedBots.insert(name).inserted {
          outEntries.append(entry)
        }
      case .other:
        outEntries.append(entry)
      }
    }

    // A folder nobody placed still exists: losing it would lose every chat in it.
    for id in order where placedFolders.insert(id).inserted {
      outEntries.append(.folder(id))
    }

    var outFolders: [ChatFolder] = []

    for case .folder(let id) in outEntries {
      guard var folder = byID[id] else {
        continue
      }

      folder.bots = folder.bots.filter { !$0.isEmpty && placedBots.insert($0).inserted }
      outFolders.append(folder)
    }

    return (outEntries, outFolders)
  }

  // MARK: Editing

  /// Fold the roster in: a chat not placed yet lands at the end of the loose top-level run, before
  /// the first folder, in the roster's order.
  public mutating func insertUnplaced(_ roster: [String]) {
    let known = Set(placed)
    let added = roster.filter { !known.contains($0) }

    guard !added.isEmpty else {
      return
    }

    let firstFolder = entries.firstIndex { if case .folder = $0 { true } else { false } } ?? entries.count
    entries.insert(contentsOf: added.map(ChatEntry.chat), at: firstFolder)
  }

  /// A new, empty folder at the end of the top level. An id that exists changes nothing.
  public mutating func addFolder(id: String, name: String) {
    guard !id.isEmpty, folder(id) == nil else {
      return
    }

    self = Self(entries: entries + [.folder(id)], folders: folders + [ChatFolder(id: id, name: name)], extras: extras)
  }

  public mutating func renameFolder(_ id: String, to name: String) {
    update(id) { $0.name = name }
  }

  public mutating func setFolderColour(_ id: String, to colour: BotAccent) {
    update(id) { $0.colour = colour }
  }

  private mutating func update(_ id: String, _ change: (inout ChatFolder) -> Void) {
    guard let index = folders.firstIndex(where: { $0.id == id }) else {
      return
    }

    change(&folders[index])
  }

  /**
   Delete a folder and keep every chat in it: its chats come back to the top level at the folder's
   own position, in their own order. Deleting a container is not a reordering.
   */
  public mutating func removeFolder(_ id: String) {
    guard let folder = folder(id) else {
      return
    }

    var out: [ChatEntry] = []

    for entry in entries {
      if case .folder(id) = entry {
        out.append(contentsOf: folder.bots.map(ChatEntry.chat))
      } else {
        out.append(entry)
      }
    }

    extras.removeValue(forKey: id)
    self = Self(entries: out, folders: folders.filter { $0.id != id }, extras: extras)
  }

  /// Take a chat out of wherever it is.
  private mutating func take(_ name: String) {
    entries.removeAll { $0 == .chat(name) }

    for index in folders.indices {
      folders[index].bots.removeAll { $0 == name }
    }
  }

  /**
   Put a chat in a folder (at its end), or out of any folder (`nil`): loose, right below the folder
   it left, so it stays where the person was looking; at the end of the loose top-level run when it
   was loose already or its folder is gone. A chat the layout does not place is not moved in
   (`insertUnplaced` first, with the roster); a folder that does not exist changes nothing.
   */
  public mutating func move(_ name: String, toFolder id: String?) {
    guard placed.contains(name) else {
      return
    }

    if let id {
      guard folder(id) != nil, folderID(of: name) != id else {
        return
      }

      take(name)
      update(id) { $0.bots.append(name) }
      return
    }

    guard let from = folderID(of: name) else {
      return
    }

    take(name)

    if let at = entries.firstIndex(of: .folder(from)) {
      entries.insert(.chat(name), at: at + 1)
    } else {
      insertUnplaced([name])
    }
  }

  /**
   Put a chat right before or after another one, in the container the other is in: the same
   container is a reorder, another one a move into (or out of) a folder. Nothing changes when
   either chat is not placed or they are the same chat.
   */
  public mutating func place(_ name: String, at anchor: ChatListArrangement.Anchor) {
    let target = anchor.name
    let known = Set(placed)

    guard name != target, known.contains(name), known.contains(target) else {
      return
    }

    let targetFolder = folderID(of: target)
    take(name)

    if let targetFolder, let index = folders.firstIndex(where: { $0.id == targetFolder }),
      let at = folders[index].bots.firstIndex(of: target)
    {
      folders[index].bots.insert(name, at: anchor.isAfter ? at + 1 : at)
    } else if let at = entries.firstIndex(of: .chat(target)) {
      entries.insert(.chat(name), at: anchor.isAfter ? at + 1 : at)
    }
  }

  /// Move a folder to `index` among the folders (the loose chats are not counted): the position in
  /// `folders` as it is after the folder is taken out of the list.
  public mutating func moveFolder(_ id: String, toIndex index: Int) {
    guard let current = entries.firstIndex(of: .folder(id)) else {
      return
    }

    entries.remove(at: current)

    let others = entries.indices.filter { if case .folder = entries[$0] { true } else { false } }
    let clamped = max(0, min(others.count, index))

    if clamped < others.count {
      entries.insert(.folder(id), at: others[clamped])
    } else if let last = others.last {
      entries.insert(.folder(id), at: last + 1)
    } else {
      entries.insert(.folder(id), at: min(current, entries.count))
    }
  }

  /// One folder up or down among the folders; nothing at an edge.
  public mutating func stepFolder(_ id: String, by delta: Int) {
    guard let index = folders.firstIndex(where: { $0.id == id }) else {
      return
    }

    let target = index + delta

    guard folders.indices.contains(target) else {
      return
    }

    moveFolder(id, toIndex: target)
  }
}

/// A folder's id, as the web client mints it (`newFolderId`): `f`, the time and a counter in base 36.
/// Ids only have to be unique within one gateway's arrangement.
public enum ChatFolderID {
  private static let counter = AtomicCounter()

  public static func make(now: Date = Date()) -> String {
    "f" + String(Int(now.timeIntervalSince1970 * 1000), radix: 36) + String(counter.next(), radix: 36)
  }

  /// Whether a string could be one of these ids: it arrives in a `hermie://folder/<id>` link, which
  /// any app can send, so only a plain name passes.
  public static func isSafe(_ id: String) -> Bool {
    !id.isEmpty && id.count <= 64
      && id.unicodeScalars.allSatisfy { ("A"..."Z").contains($0) || ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-" }
  }
}

private final class AtomicCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  func next() -> Int {
    lock.lock()
    defer { lock.unlock() }
    value += 1
    return value
  }
}

// MARK: - On the app section

extension ChatListArrangement {
  /// Read the layout off the section, fold the roster in, apply `edit`, and write it back only when
  /// the edit changed something: a no-op writes nothing, not even the fold.
  @discardableResult
  static func edit(_ app: inout JSONObject, roster: [String] = [], _ change: (inout ChatLayout) -> Void) -> Bool {
    var layout = ChatLayout(app: app)
    layout.insertUnplaced(roster)
    let folded = layout
    change(&layout)

    guard layout != folded else {
      return false
    }

    layout.write(into: &app)
    return true
  }

  /// A new folder at the end of the top level, with `name`; `chat` goes into it when the chat is
  /// placed (or in the roster). Answers whether the section changed.
  @discardableResult
  public static func addFolder(
    id: String, name: String, containing chat: String? = nil, roster: [String] = [], in app: inout JSONObject
  ) -> Bool {
    edit(&app, roster: roster) { layout in
      layout.addFolder(id: id, name: name)

      if let chat {
        layout.move(chat, toFolder: id)
      }
    }
  }

  @discardableResult
  public static func renameFolder(_ id: String, to name: String, in app: inout JSONObject) -> Bool {
    edit(&app) { $0.renameFolder(id, to: name) }
  }

  @discardableResult
  public static func setFolderColour(_ id: String, to colour: BotAccent, in app: inout JSONObject) -> Bool {
    edit(&app) { $0.setFolderColour(id, to: colour) }
  }

  /// Delete a folder; its chats are kept, at its place.
  @discardableResult
  public static func removeFolder(_ id: String, in app: inout JSONObject) -> Bool {
    edit(&app) { $0.removeFolder(id) }
  }

  /// Put a chat in a folder, or out of any (`nil`).
  @discardableResult
  public static func move(_ name: String, toFolder id: String?, roster: [String], in app: inout JSONObject) -> Bool {
    edit(&app, roster: roster) { $0.move(name, toFolder: id) }
  }

  /// Put a chat next to another, in the other's container: a reorder, or a move between containers.
  @discardableResult
  public static func place(_ name: String, at anchor: Anchor, roster: [String], in app: inout JSONObject) -> Bool {
    edit(&app, roster: roster) { $0.place(name, at: anchor) }
  }

  @discardableResult
  public static func moveFolder(_ id: String, toIndex index: Int, in app: inout JSONObject) -> Bool {
    edit(&app) { $0.moveFolder(id, toIndex: index) }
  }

  @discardableResult
  public static func stepFolder(_ id: String, by delta: Int, in app: inout JSONObject) -> Bool {
    edit(&app) { $0.stepFolder(id, by: delta) }
  }
}
