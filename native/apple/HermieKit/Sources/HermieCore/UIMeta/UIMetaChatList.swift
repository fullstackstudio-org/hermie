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
 The chat list's three per-chat choices as `ui_meta` holds them, read out of the device's copy
 (`UIMetaDocuments`), and the edits that write them back. The wire is the web client's and the
 Expo app's, byte for byte (`projectApp` / `projectBots` in `native/web/src/core/ui-meta-bridge.ts`):

 - **archived** lives on the bot's own profile, in its `hermie` section: `{"v": 1, "archived": true}`.
   Unarchiving removes the field, and a section left with nothing but its version is removed whole.
 - **pinned** is the app section's `pinned`: a list of bot names, in the order they were pinned.
 - **mutes** is the app section's `mutes`: bot name to the unix SECOND the mute lapses, `0` for
   never. A deadline in the past is not a mute, whether or not anybody swept it yet.
 - **the order** is the app section's `entries` (the top level: `{"kind": "chat", "name"}` and
   `{"kind": "folder", "id"}`) and `folders` (`{"id", "name", "colour"?, "bots"}`), the web
   client's `Arrangement`. This build draws no folders; it shows a folder's chats in its place.

 The app section is the signed-in person's own (`hermie-app:<user id>`), so pins, mutes and the
 order are per person. `archived` is not: it lives on the bot's profile, shared by everybody on
 the gateway, as the web client and the Expo app write it.

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

  public init(archived: Set<String> = [], pinned: [String] = [], mutes: [String: Double] = [:], order: [String] = []) {
    self.archived = archived
    self.pinned = pinned
    self.mutes = mutes
    self.order = order
  }

  /// Read off the device's copy, defensively: another build wrote it.
  public init(documents: UIMetaDocuments) {
    var archived = Set<String>()

    for (name, section) in documents.bots where section[UIMetaField.archived] == .bool(true) {
      archived.insert(name)
    }

    self.init(
      archived: archived,
      pinned: Self.names(documents.app?[UIMetaField.pinned]),
      mutes: Self.mutes(documents.app?[UIMetaField.mutes]),
      order: Self.botsInOrder(documents.app)
    )
  }

  public func isArchived(_ name: String) -> Bool {
    archived.contains(name)
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

  // MARK: - Writing the wire

  /// Archive or unarchive in one bot's `hermie` section.
  public static func setArchived(_ archived: Bool, in section: inout JSONObject) {
    if archived {
      section[UIMetaField.archived] = .bool(true)
    } else {
      section.removeValue(forKey: UIMetaField.archived)
    }
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

  /// `rows` in the arrangement's order; a bot the arrangement does not place yet (new on the
  /// gateway) comes after the ones it does, in the order it came, so a new bot never disturbs the
  /// order somebody made.
  public func ordered<Row>(_ rows: [Row], name: (Row) -> String) -> [Row] {
    guard !order.isEmpty else {
      return rows
    }

    var position: [String: Int] = [:]

    for (index, bot) in order.enumerated() {
      position[bot] = index
    }

    return rows.enumerated()
      .sorted { lhs, rhs in
        let left = position[name(lhs.element)] ?? (order.count + lhs.offset)
        let right = position[name(rhs.element)] ?? (order.count + rhs.offset)
        return left < right
      }
      .map(\.element)
  }

  /**
   Move one chat next to another, within the container both are in (the top level, or one folder),
   and write it the way the web client's `moveBy` / `dropBot` do: the top level's `entries`
   (`{"kind": "chat", "name": …}`, folders by id), or the folder's `bots`. Every other field of the
   section, every folder and every entry this build does not know is carried.

   First the roster is folded in (`reconcileBots`): a bot the arrangement does not place yet lands at
   the end of the loose top-level run, before the first folder, so the order written is the one on
   screen. Bots the arrangement holds and the roster does not are kept: a roster read from the cache
   can lag, and losing a position is not this move's call.

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
    let placed = Set(botsInOrder(app))
    let added = roster.filter { !placed.contains($0) }

    if !added.isEmpty {
      let firstFolder = entries.firstIndex { $0["kind"]?.stringValue == "folder" } ?? entries.count
      entries.insert(contentsOf: added.map { ["kind": "chat", "name": .string($0)] }, at: firstFolder)
    }

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
 actions are not offered (`canEdit`).

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
    canEdit = false
  }

  // MARK: Reading

  public func isArchived(_ name: String) -> Bool { arrangement.isArchived(name) }
  public func isPinned(_ name: String) -> Bool { arrangement.isPinned(name) }
  public func isMuted(_ name: String) -> Bool { arrangement.isMuted(name, now: max(clock, now())) }
  public func mutedUntil(_ name: String) -> Double? { arrangement.mutedUntil(name, now: max(clock, now())) }

  // MARK: Choices

  public func setArchived(_ name: String, _ archived: Bool) {
    sync?.updateBot(name, .choice) { ChatListArrangement.setArchived(archived, in: &$0) }
    refresh()
  }

  public func setPinned(_ name: String, _ pinned: Bool) {
    sync?.updateApp(.choice) { ChatListArrangement.setPinned(name, pinned, in: &$0) }
    refresh()
  }

  public func mute(_ name: String, for duration: MuteDuration) {
    setMute(name, until: duration.until(now: now()))
  }

  /// Move a chat next to another (`ChatListArrangement.move`); `roster` is the order on screen
  /// before the move, every bot the gateway has.
  public func move(_ name: String, to anchor: ChatListArrangement.Anchor, roster: [String]) {
    sync?.updateApp(.choice) { ChatListArrangement.move(name, to: anchor, roster: roster, in: &$0) }
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
