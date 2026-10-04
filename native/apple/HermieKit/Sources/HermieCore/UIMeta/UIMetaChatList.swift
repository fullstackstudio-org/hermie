import Foundation
import HermieProtocol
import Observation

/// How long a chat stays silent (`MUTE_DURATIONS` in `state/mute.ts` of the web client and the
/// Expo app's `store/mute.ts`): the four the menus offer, in the order they are offered.
public enum MuteDuration: String, Sendable, Hashable, CaseIterable {
  case oneHour = "1h"
  case eightHours = "8h"
  case oneWeek = "1w"
  case forever

  /// A mute with no end, stored as `0`: a deadline that never comes.
  public static let foreverDeadline: Double = 0

  /// What to store for this duration chosen at `now` (unix seconds).
  public func until(now: Double) -> Double {
    switch self {
    case .oneHour: now.rounded(.down) + 60 * 60
    case .eightHours: now.rounded(.down) + 8 * 60 * 60
    case .oneWeek: now.rounded(.down) + 7 * 24 * 60 * 60
    case .forever: Self.foreverDeadline
    }
  }
}

/**
 The chat list's per-chat choices as `ui_meta` holds them, read out of the device's copy
 (`UIMetaDocuments`), and the edits that write them back. The wire is the web client's
 (`projectApp` in `native/web/src/core/ui-meta-bridge.ts`, plus `archivedBots`, which it adopts):

 - **archivedBots** is the app section's archive: bot names, sorted, no duplicates. A chat is
   archived for this person if and only if it is in the list; a bot gone from the roster stays in
   it harmlessly. Until the person's section has the field, it is seeded once, as a chore (it never
   wins over the gateway's copy), from the bots whose shared `hermie` section says
   `archived: true`, the flag the Expo app and older builds wrote. That flag is never written here
   and never changed: the frozen Expo app may still read it.
 - **pinned** is the app section's `pinned`: a list of bot names, in the order they were pinned.
 - **mutes** is the app section's `mutes`: bot name to the unix SECOND the mute lapses, `0` for
   never. A deadline in the past is not a mute, whether or not anybody swept it yet.
 - **the order** is the app section's `entries` (the top level: `{"kind": "chat", "name"}` and
   `{"kind": "folder", "id"}`) and `folders` (`{"id", "name", "colour"?, "bots"}`), the web
   client's `Arrangement`, which `ChatLayout` reads and edits and `ChatListSections` draws.

 The app section is the signed-in person's own (`hermie-app:<user id>`), so the archive, pins,
 mutes and order are per person: two people on one gateway never see each other's.

 Every other field of either section is carried as it came.
 */
public struct ChatListArrangement: Sendable, Hashable {
  public var archived: Set<String>
  /// In the order they were pinned.
  public var pinned: [String]
  public var mutes: [String: Double]
  /// Every bot the arrangement places, in its order (`entries` and `folders`); empty while
  /// nobody has ordered the list, which then keeps the roster's order.
  public var order: [String]
  /// How many of `order` come before the first folder: the loose top-level run, at whose end a
  /// bot the arrangement does not place yet is shown, and written by the next move or fold.
  public var looseHead: Int
  /// Bot → the folder it is in. A bot not in here is loose (or not placed yet, which is loose too).
  public var folderOf: [String: String]
  /// Bot → the name this person gave it (`BotIdentity`); a bot not in here has none.
  public var labels: [String: String]
  /// Bot → the colour its chat was given; a bot not in here has the default one.
  public var accents: [String: BotAccent]
  /// The top level and the folders, as the person's section holds them (`ChatLayout`): what the
  /// list draws its folders from.
  public var layout: ChatLayout

  public init(
    archived: Set<String> = [], pinned: [String] = [], mutes: [String: Double] = [:], order: [String] = [],
    looseHead: Int? = nil, folderOf: [String: String] = [:], labels: [String: String] = [:],
    accents: [String: BotAccent] = [:], layout: ChatLayout = ChatLayout()
  ) {
    self.archived = archived
    self.pinned = pinned
    self.mutes = mutes
    self.order = order
    self.looseHead = looseHead ?? order.count
    self.folderOf = folderOf
    self.labels = labels
    self.accents = accents
    self.layout = layout
  }

  /// Read off the device's copy, defensively: another build wrote it. The archive is the person's
  /// `archivedBots`, or, until that has been seeded, what it will be seeded with.
  public init(documents: UIMetaDocuments) {
    self.init(
      archived: Set(Self.archivedBots(documents.app) ?? Self.inheritedArchive(documents.bots)),
      pinned: Self.names(documents.app?[UIMetaField.pinned]),
      mutes: Self.mutes(documents.app?[UIMetaField.mutes]),
      order: Self.botsInOrder(documents.app),
      looseHead: Self.looseHead(documents.app),
      folderOf: Self.folderOf(documents.app),
      labels: BotIdentity.labels(documents.app?[UIMetaField.labels]),
      accents: documents.bots.compactMapValues { BotIdentity.accent($0) },
      layout: ChatLayout(app: documents.app)
    )
  }

  /// Whether two bots are in the same container (the top level, or one folder): the only moves
  /// `move` makes.
  public func sameContainer(_ lhs: String, _ rhs: String) -> Bool {
    folderOf[lhs] == folderOf[rhs]
  }

  public func isArchived(_ name: String) -> Bool {
    archived.contains(name)
  }

  /// The name this person gave the bot, or nil.
  public func label(_ name: String) -> String? {
    labels[name]
  }

  public func accent(_ name: String) -> BotAccent {
    accents[name] ?? .default
  }

  public func isPinned(_ name: String) -> Bool {
    pinned.contains(name)
  }

  /// Is this chat silent at `now` (unix seconds)?
  public func isMuted(_ name: String, now: Double) -> Bool {
    mutedUntil(name, now: now) != nil
  }

  /// The deadline, `0` for never, or nil when the chat is not muted at `now`.
  public func mutedUntil(_ name: String, now: Double) -> Double? {
    guard let until = mutes[name] else {
      return nil
    }

    return until == MuteDuration.foreverDeadline || until > now ? until : nil
  }

  /// The soonest deadline after `now`, for a timer that redraws the rows when a mute lapses.
  public func nextLapse(after now: Double) -> Double? {
    mutes.values.filter { $0 != MuteDuration.foreverDeadline && $0 > now }.min()
  }

  /// `rows` with the pinned ones first, each group in the order it came: pinning lifts a chat,
  /// it does not reorder the rest.
  public func pinnedFirst<Row>(_ rows: [Row], name: (Row) -> String) -> [Row] {
    let pins = Set(pinned)
    return rows.filter { pins.contains(name($0)) } + rows.filter { !pins.contains(name($0)) }
  }

  // MARK: - Reading the wire

  /// `names` in the web bridge: an array's non-empty strings, duplicates dropped.
  static func names(_ value: JSONValue?) -> [String] {
    guard case .array(let entries)? = value else {
      return []
    }

    var seen = Set<String>()

    return entries.compactMap { entry in
      guard case .string(let name) = entry, !name.isEmpty, seen.insert(name).inserted else {
        return nil
      }

      return name
    }
  }

  /// `mutesOf`: finite, non-negative deadlines only, floored to whole seconds.
  static func mutes(_ value: JSONValue?) -> [String: Double] {
    guard case .object(let object)? = value else {
      return [:]
    }

    var out: [String: Double] = [:]

    for (name, until) in object {
      if !name.isEmpty, case .number(let number) = until, number.isFinite, number >= 0 {
        out[name] = number.rounded(.down)
      }
    }

    return out
  }

  /// The person's archive, or nil while their section has no `archivedBots` (not seeded yet).
  static func archivedBots(_ app: JSONObject?) -> [String]? {
    guard case .array? = app?[UIMetaField.archivedBots] else {
      return nil
    }

    return names(app?[UIMetaField.archivedBots]).sorted()
  }

  /// The bots the shared `hermie` sections mark `archived: true`, sorted: what a person's archive
  /// is seeded with the first time.
  static func inheritedArchive(_ bots: [String: JSONObject]) -> [String] {
    bots.filter { $0.value[UIMetaField.archived] == .bool(true) }.keys.sorted()
  }

  // MARK: - Writing the wire

  /// Archive or unarchive in the person's app section: `archivedBots`, sorted and without
  /// duplicates. `current` is the archive as read (`archived`), so an unseeded section writes the
  /// inherited names along with the change. The bot sections are not touched.
  public static func setArchived(_ name: String, _ archived: Bool, current: Set<String>, in app: inout JSONObject) {
    var list = Set(archivedBots(app) ?? Array(current))

    if archived {
      list.insert(name)
    } else {
      list.remove(name)
    }

    app[UIMetaField.archivedBots] = .array(list.sorted().map(JSONValue.string))
  }

  /// The one-time seed: `archivedBots` from the shared flags, when the section has no such field.
  /// Answers whether it wrote. The caller writes it as a chore.
  @discardableResult
  public static func seedArchive(from bots: [String: JSONObject], in app: inout JSONObject) -> Bool {
    guard archivedBots(app) == nil else {
      return false
    }

    app[UIMetaField.archivedBots] = .array(inheritedArchive(bots).map(JSONValue.string))
    return true
  }

  /// Pin or unpin in the app section. A new pin goes to the end (`setPinned`); the field is kept
  /// as an empty list once the last pin is gone, as the web projection writes it.
  public static func setPinned(_ name: String, _ pinned: Bool, in app: inout JSONObject) {
    var list = names(app[UIMetaField.pinned])

    if pinned {
      guard !list.contains(name) else { return }
      list.append(name)
    } else {
      list.removeAll { $0 == name }
    }

    app[UIMetaField.pinned] = .array(list.map(JSONValue.string))
  }

  /// Mute until a deadline (`0` for never), or unmute with nil (`setMute`).
  public static func setMute(_ name: String, until: Double?, in app: inout JSONObject) {
    var mutes = app[UIMetaField.mutes]?.objectValue ?? [:]

    if let until, until.isFinite, until >= 0 {
      mutes[name] = .number(until.rounded(.down))
    } else {
      mutes.removeValue(forKey: name)
    }

    app[UIMetaField.mutes] = .object(mutes)
  }

  // MARK: - The order

  /// Where a moved chat lands: right before or right after another one in its container.
  public enum Anchor: Sendable, Hashable {
    case before(String)
    case after(String)

    var name: String {
      switch self {
      case .before(let name), .after(let name): name
      }
    }

    var isAfter: Bool {
      if case .after = self { true } else { false }
    }

    /// Where a drop between rows lands, as `onMove` reports it: `index` is a gap in `names`
    /// (before the row there, or after the group's last one at its end), within `group`.
    public static func forDrop(_ names: [String], group: Range<Int>, at index: Int) -> Anchor? {
      guard !group.isEmpty else {
        return nil
      }

      return index < group.upperBound ? .before(names[index]) : .after(names[group.upperBound - 1])
    }
  }

  /// Every bot in the order the arrangement places it (`botsInOrder`): the top level's entries,
  /// a folder's bots where the folder stands. This build draws no folders, so a folder's chats
  /// are shown in its place, in its order.
  static func botsInOrder(_ app: JSONObject?) -> [String] {
    let folders = folderBots(app)
    var seen = Set<String>()
    var out: [String] = []

    for entry in app?[UIMetaField.entries]?.arrayValue ?? [] {
      let names: [String] =
        switch entry["kind"]?.stringValue {
        case "chat": entry["name"]?.stringValue.map { [$0] } ?? []
        case "folder": entry["id"]?.stringValue.flatMap { folders[$0] } ?? []
        default: []
        }

      for name in names where !name.isEmpty && seen.insert(name).inserted {
        out.append(name)
      }
    }

    // A folder nobody placed still holds its bots (`normalise` appends it).
    for (_, bots) in folders.sorted(by: { $0.key < $1.key }) {
      for name in bots where seen.insert(name).inserted {
        out.append(name)
      }
    }

    return out
  }

  /// The number of distinct loose chats before the first folder entry.
  static func looseHead(_ app: JSONObject?) -> Int {
    var seen = Set<String>()

    for entry in app?[UIMetaField.entries]?.arrayValue ?? [] {
      if entry["kind"]?.stringValue == "folder" {
        break
      }

      if entry["kind"]?.stringValue == "chat", let name = entry["name"]?.stringValue, !name.isEmpty {
        seen.insert(name)
      }
    }

    return seen.count
  }

  /// Bot → folder id, the first folder that holds it, for the bots not loose at the top level.
  static func folderOf(_ app: JSONObject?) -> [String: String] {
    let loose = Set(
      (app?[UIMetaField.entries]?.arrayValue ?? []).compactMap { entry in
        entry["kind"]?.stringValue == "chat" ? entry["name"]?.stringValue : nil
      })
    var out: [String: String] = [:]

    for folder in app?[UIMetaField.folders]?.arrayValue ?? [] {
      guard let id = folder["id"]?.stringValue, !id.isEmpty else {
        continue
      }

      for name in names(folder["bots"]) where !loose.contains(name) && out[name] == nil {
        out[name] = id
      }
    }

    return out
  }

  /// Folder id → its bots, from the app section's `folders`.
  private static func folderBots(_ app: JSONObject?) -> [String: [String]] {
    var out: [String: [String]] = [:]

    for folder in app?[UIMetaField.folders]?.arrayValue ?? [] {
      guard let id = folder["id"]?.stringValue, !id.isEmpty, out[id] == nil else {
        continue
      }

      out[id] = names(folder["bots"])
    }

    return out
  }

  /// `rows` in the arrangement's order. A bot the arrangement does not place yet (new on the
  /// gateway) comes at the end of the loose top-level run, before the first folder, in the order
  /// it came: where `move` and `reconcile` write it, so nothing jumps when they do, and a new bot
  /// never disturbs the order somebody made.
  public func ordered<Row>(_ rows: [Row], name: (Row) -> String) -> [Row] {
    guard !order.isEmpty else {
      return rows
    }

    var position: [String: Int] = [:]

    for (index, bot) in order.enumerated() {
      position[bot] = index
    }

    func key(_ offset: Int, _ bot: String) -> (Int, Int) {
      guard let index = position[bot] else {
        return (1, offset)
      }

      return index < looseHead ? (0, index) : (2, index)
    }

    return rows.enumerated()
      .sorted { key($0.offset, name($0.element)) < key($1.offset, name($1.element)) }
      .map(\.element)
  }

  /**
   Fold the roster into the order (`reconcileBots` in the web client's `state/folders.ts`): a bot
   the roster no longer has is dropped from wherever it was, and a bot not placed yet lands at the
   end of the loose top-level run, before the first folder. Only with a roster the gateway has just
   answered: a roster painted from the cache can lag behind a bot made elsewhere, and dropping it
   would take it out of its folder. The caller writes it as a chore. Answers whether it changed
   anything. An empty roster changes nothing.
   */
  @discardableResult
  public static func reconcile(roster: [String], in app: inout JSONObject) -> Bool {
    guard !roster.isEmpty else {
      return false
    }

    let live = Set(roster)
    let before = app
    var entries = (app[UIMetaField.entries]?.arrayValue ?? []).filter {
      $0["kind"]?.stringValue != "chat" || live.contains($0["name"]?.stringValue ?? "")
    }
    let folders = (app[UIMetaField.folders]?.arrayValue ?? []).map { folder -> JSONValue in
      guard case .object(var object) = folder, case .array(let bots)? = object["bots"] else {
        return folder
      }

      object["bots"] = .array(bots.filter { live.contains($0.stringValue ?? "") })
      return .object(object)
    }

    insertUnplaced(roster, into: &entries, folders: folders)
    app[UIMetaField.entries] = .array(entries)

    if app[UIMetaField.folders] != nil {
      app[UIMetaField.folders] = .array(folders)
    }

    return app != before
  }

  /// Put the roster's bots that `entries` and `folders` do not place at the end of the loose run.
  private static func insertUnplaced(_ roster: [String], into entries: inout [JSONValue], folders: [JSONValue]) {
    let placed = Set(botsInOrder(["entries": .array(entries), "folders": .array(folders)]))
    let added = roster.filter { !placed.contains($0) }

    guard !added.isEmpty else {
      return
    }

    let firstFolder = entries.firstIndex { $0["kind"]?.stringValue == "folder" } ?? entries.count
    entries.insert(contentsOf: added.map { ["kind": "chat", "name": .string($0)] }, at: firstFolder)
  }

  /**
   Move one chat next to another, within the container both are in (the top level, or one folder),
   and write it the way the web client's `moveBy` / `dropBot` do: the top level's `entries`
   (`{"kind": "chat", "name": …}`, folders by id), or the folder's `bots`. Every other field of the
   section, every folder and every entry this build does not know is carried.

   A bot the arrangement does not place yet (in `roster`, the rows on screen) is written first, at
   the end of the loose top-level run before the first folder, where `ordered` shows it, so the
   order written is the one on screen. Nothing is ever dropped here: the roster may be the one
   painted from the cache, and a bot made on another device would leave its folder. Dropping is
   `reconcile`'s, with a roster the gateway answered, as a chore.

   A move between containers (out of a folder, say) is not made here: this build has no folders to
   drop into, and running off the end of one is not a step anybody asked for. Answers whether the
   section changed.
   */
  @discardableResult
  public static func move(_ name: String, to anchor: Anchor, roster: [String], in app: inout JSONObject) -> Bool {
    guard name != anchor.name else {
      return false
    }

    var entries = app[UIMetaField.entries]?.arrayValue ?? []
    var folders = app[UIMetaField.folders]?.arrayValue ?? []

    insertUnplaced(roster, into: &entries, folders: folders)

    func folderIndex(of bot: String) -> Int? {
      folders.firstIndex { names($0["bots"]).contains(bot) }
    }

    func isLoose(_ bot: String) -> Bool {
      entries.contains { $0["kind"]?.stringValue == "chat" && $0["name"]?.stringValue == bot }
    }

    if isLoose(name), isLoose(anchor.name) {
      guard let from = entries.firstIndex(where: { $0["kind"]?.stringValue == "chat" && $0["name"]?.stringValue == name })
      else { return false }

      let entry = entries.remove(at: from)

      guard
        let target = entries.firstIndex(where: {
          $0["kind"]?.stringValue == "chat" && $0["name"]?.stringValue == anchor.name
        })
      else { return false }

      entries.insert(entry, at: anchor.isAfter ? target + 1 : target)
    } else if let folder = folderIndex(of: name), folderIndex(of: anchor.name) == folder,
      case .object(var object) = folders[folder]
    {
      var bots = names(object["bots"])
      bots.removeAll { $0 == name }

      guard let target = bots.firstIndex(of: anchor.name) else {
        return false
      }

      bots.insert(name, at: anchor.isAfter ? target + 1 : target)
      object["bots"] = .array(bots.map(JSONValue.string))
      folders[folder] = .object(object)
    } else {
      return false
    }

    let before = app
    app[UIMetaField.entries] = .array(entries)

    if app[UIMetaField.folders] != nil || !folders.isEmpty {
      app[UIMetaField.folders] = .array(folders)
    }

    return app != before
  }

  /// Forget the mutes that lapsed (`dropExpiredMutes`). Leaves the section alone when none had,
  /// so a sweep that found nothing sends nothing.
  public static func dropExpiredMutes(now: Double, in app: inout JSONObject) {
    guard case .object(let held)? = app[UIMetaField.mutes] else {
      return
    }

    let readable = mutes(.object(held))
    let kept = held.filter { name, _ in
      guard let until = readable[name] else { return false }
      return until == MuteDuration.foreverDeadline || until > now
    }

    if kept.count != held.count {
      app[UIMetaField.mutes] = .object(kept)
    }
  }
}

/**
 The chat list's archive, pins and mutes for one live session: what the rows are drawn from, and
 the one way to change them.

 It holds no storage of its own. The live session's ui_meta bridge (`GatewayMetaBridge`) attaches
 its `UIMetaSync`; every edit goes through that sync as a choice (marked, debounced, sent to the
 gateway, and so to the other devices and the web client), and every copy the sync takes in from
 the gateway is read back here. Before a sync is attached (the first moments of a session) the
 actions are not offered (`canEdit`). Once the sync's stored copy is read, a person whose section
 has no `archivedBots` yet gets it seeded from the shared `archived` flags, as a chore.

 Expired mutes read as unmuted at once (`isMuted` compares against the clock); a timer moves
 `clock` when the soonest one lapses, so a row's bell goes without anybody touching it, and the
 lapsed entries are swept from the section as a chore.
 */
@MainActor
@Observable
public final class ChatArrangementModel {
  public private(set) var arrangement = ChatListArrangement()
  /// Unix seconds as of the last redraw the mutes asked for.
  public private(set) var clock: Double
  public private(set) var canEdit = false

  @ObservationIgnored private var sync: UIMetaSync?
  @ObservationIgnored private var following: Task<Void, Never>?
  @ObservationIgnored private var lapse: Task<Void, Never>?
  /// The sync's stored copy has been read: only then can the archive be seeded, or the seed would
  /// be merged over a person's own archive still on its way off the disk.
  @ObservationIgnored private var loaded = false
  /// The roster as the gateway last answered it (never the one painted from the cache), for the fold.
  @ObservationIgnored private var freshRoster: [String] = []
  @ObservationIgnored private let now: @Sendable () -> Double

  public init(now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }) {
    self.now = now
    self.clock = now()
  }

  /// Read from `sync` from now on, and write through it. Replaces any sync attached before.
  public func attach(_ sync: UIMetaSync) {
    detach()
    self.sync = sync
    canEdit = true
    refresh()

    let changes = sync.changes()
    following = Task { [weak self] in
      // The stored copy may still be on its way off the disk; it is what an offline launch shows.
      await sync.load()
      self?.loaded = true
      self?.refresh()

      for await _ in changes {
        guard let self, !Task.isCancelled else {
          return
        }

        self.refresh()
      }
    }
  }

  /// Stop reading from `sync`, when it is the one attached. The rows keep what they show.
  public func detach(_ sync: UIMetaSync) {
    if self.sync === sync {
      detach()
    }
  }

  private func detach() {
    following?.cancel()
    following = nil
    lapse?.cancel()
    lapse = nil
    sync = nil
    loaded = false
    freshRoster = []
    canEdit = false
  }

  // MARK: Reading

  public func isArchived(_ name: String) -> Bool { arrangement.isArchived(name) }
  public func isPinned(_ name: String) -> Bool { arrangement.isPinned(name) }
  public func isMuted(_ name: String) -> Bool { arrangement.isMuted(name, now: max(clock, now())) }
  public func mutedUntil(_ name: String) -> Double? { arrangement.mutedUntil(name, now: max(clock, now())) }
  /// The name this person gave the bot, or nil.
  public func label(_ name: String) -> String? { arrangement.label(name) }
  public func accent(_ name: String) -> BotAccent { arrangement.accent(name) }

  // MARK: Choices

  public func setArchived(_ name: String, _ archived: Bool) {
    let current = arrangement.archived
    sync?.updateApp(.choice) { ChatListArrangement.setArchived(name, archived, current: current, in: &$0) }
    refresh()
  }

  public func setPinned(_ name: String, _ pinned: Bool) {
    sync?.updateApp(.choice) { ChatListArrangement.setPinned(name, pinned, in: &$0) }
    refresh()
  }

  public func mute(_ name: String, for duration: MuteDuration) {
    setMute(name, until: duration.until(now: now()))
  }

  /// Name a bot in the person's own list (`BotIdentity.setLabel`); empty takes the name back.
  public func setLabel(_ name: String, _ label: String) {
    sync?.updateApp(.choice) { BotIdentity.setLabel(name, label, in: &$0) }
    refresh()
  }

  /// Colour a bot's chat. It is the bot's own section, so everybody on the gateway sees it.
  public func setAccent(_ name: String, _ accent: BotAccent) {
    sync?.updateBot(name, .choice) { BotIdentity.setAccent(accent, in: &$0) }
    refresh()
  }

  /// Move a chat next to another (`ChatListArrangement.move`); `roster` is the order on screen
  /// before the move, every bot the gateway has.
  public func move(_ name: String, to anchor: ChatListArrangement.Anchor, roster: [String]) {
    sync?.updateApp(.choice) { ChatListArrangement.move(name, to: anchor, roster: roster, in: &$0) }
    refresh()
  }

  // MARK: Folders

  /// Make a folder named `name` at the end of the list, and put `chat` in it when given. Answers the
  /// new folder's id, or nil when the name is empty or the order cannot be written yet.
  @discardableResult
  public func newFolder(_ name: String, containing chat: String? = nil, roster: [String]) -> String? {
    let name = ChatFolder.cleaned(name)

    guard sync != nil, !name.isEmpty else {
      return nil
    }

    let id = ChatFolderID.make(now: Date(timeIntervalSince1970: now()))
    sync?.updateApp(.choice) { ChatListArrangement.addFolder(id: id, name: name, containing: chat, roster: roster, in: &$0) }
    refresh()
    return id
  }

  /// An empty name is allowed: the list calls such a folder untitled.
  public func renameFolder(_ id: String, to name: String) {
    let name = ChatFolder.cleaned(name)
    sync?.updateApp(.choice) { ChatListArrangement.renameFolder(id, to: name, in: &$0) }
    refresh()
  }

  public func setFolderColour(_ id: String, to colour: BotAccent) {
    sync?.updateApp(.choice) { ChatListArrangement.setFolderColour(id, to: colour, in: &$0) }
    refresh()
  }

  /// Delete a folder; its chats stay, where the folder was.
  public func removeFolder(_ id: String) {
    sync?.updateApp(.choice) { ChatListArrangement.removeFolder(id, in: &$0) }
    refresh()
  }

  /// Put a chat in a folder, or out of any (`nil`). `roster` is every bot the gateway has.
  public func move(_ name: String, toFolder id: String?, roster: [String]) {
    sync?.updateApp(.choice) { ChatListArrangement.move(name, toFolder: id, roster: roster, in: &$0) }
    refresh()
  }

  /// Put a chat next to another, in the other's container: what a drop between two containers does.
  public func place(_ name: String, at anchor: ChatListArrangement.Anchor, roster: [String]) {
    sync?.updateApp(.choice) { ChatListArrangement.place(name, at: anchor, roster: roster, in: &$0) }
    refresh()
  }

  /// Move a folder to a place among the folders (see `ChatLayout.moveFolder`).
  public func moveFolder(_ id: String, toIndex index: Int) {
    sync?.updateApp(.choice) { ChatListArrangement.moveFolder(id, toIndex: index, in: &$0) }
    refresh()
  }

  /// One folder up (`-1`) or down (`1`) among the folders.
  public func stepFolder(_ id: String, by delta: Int) {
    sync?.updateApp(.choice) { ChatListArrangement.stepFolder(id, by: delta, in: &$0) }
    refresh()
  }

  /// The gateway answered the roster: fold it into the order (`ChatListArrangement.reconcile`) as a
  /// chore, which never wins over the gateway's copy and is redone on top of every copy taken in.
  /// Only for a roster the gateway answered, never one painted from the cache.
  public func rosterRefreshed(_ names: [String]) {
    guard names != freshRoster else {
      return
    }

    freshRoster = names
    refresh()
  }

  /// `nil` unmutes.
  public func setMute(_ name: String, until: Double?) {
    sync?.updateApp(.choice) { ChatListArrangement.setMute(name, until: until, in: &$0) }
    refresh()
  }

  // MARK: Keeping up

  private func refresh() {
    guard let sync else {
      return
    }

    // The person's archive, seeded once from the shared flags. A chore: it never wins over a
    // section the gateway holds (HERM-191), and is redone on top of whatever is taken.
    if loaded, ChatListArrangement.archivedBots(sync.app) == nil {
      let bots = sync.documents.bots
      sync.updateApp(.chore) { ChatListArrangement.seedArchive(from: bots, in: &$0) }
    }

    if loaded, !freshRoster.isEmpty {
      let roster = freshRoster
      sync.updateApp(.chore) { ChatListArrangement.reconcile(roster: roster, in: &$0) }
    }

    let next = ChatListArrangement(documents: sync.documents)

    if next != arrangement {
      arrangement = next
    }

    clock = now()
    scheduleLapse()
  }

  /// Wake when the soonest mute lapses: redraw, and sweep the lapsed entries as housekeeping.
  private func scheduleLapse() {
    lapse?.cancel()
    lapse = nil

    guard let next = arrangement.nextLapse(after: now()) else {
      return
    }

    let wait = max(0, next - now()) + 0.5
    lapse = Task { [weak self] in
      try? await Task.sleep(for: .seconds(wait))

      guard !Task.isCancelled, let self, let sync = self.sync else {
        return
      }

      let now = self.now()
      sync.updateApp(.chore) { ChatListArrangement.dropExpiredMutes(now: now, in: &$0) }
      self.refresh()
    }
  }
}
