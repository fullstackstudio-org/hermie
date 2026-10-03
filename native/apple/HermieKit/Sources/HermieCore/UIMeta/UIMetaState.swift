import Foundation
import HermieProtocol

/// The compare-and-swap bookkeeping of `UiMetaSync`, with no I/O.
///
/// What lives here is the revision table, which sections have not reached the
/// gateway yet, who the gateway named, and the rules that turn a roster and a
/// local copy into what is applied and what is sent. `UIMetaSync` runs the round
/// trips and calls these between them, so every step the reference takes without
/// an `await` is one call here.
public struct UIMetaState: Sendable, Hashable {
  private struct RevisionKey: Hashable, Sendable {
    var profile: String
    var key: String
  }

  /// (profile, key) to the revision this client last read for it.
  private var revisions: [RevisionKey: Double] = [:]

  /// The default profile, learnt from the roster. The app key lives on it.
  public private(set) var defaultProfile: String?

  /// The gateway's identity for whoever is signed in; empty while nobody has
  /// been named, and then no app section is written at all (not under the
  /// legacy key, not under a guessed one).
  public private(set) var userID = ""

  /// Whether the plugin said it reads `hermie-app:<user_id>`. Gates the push
  /// half only; false is the honest default.
  public private(set) var perUser = false

  /// The bare key as the gateway holds it, for the read-modify-write of its push rows.
  public private(set) var legacyApp: JSONObject?

  /// Bots whose section changed locally and has not been taken, in the order
  /// they were marked (the reference iterates a `Set` in insertion order).
  public private(set) var dirtyBots: [String] = []
  public private(set) var dirtyApp = false

  /// Whether the app section's unsent change includes a CHOICE, or only chores (housekeeping
  /// nobody decided: the roster folded into the order, a lapsed mute swept, a push row). A chore
  /// never wins over a section the gateway holds (HERM-191): undated against undated would
  /// otherwise keep the local copy, and a flat order folded on a fresh install would replace the
  /// person's own arrangement.
  ///
  /// Kept as the mark of the latest unsent choice (`choiceMark`, `0` for none), as the web client
  /// keeps it: a choice that lands while a chore made during its flight is still pending leaves that
  /// chore on its own, a chore again, which loses to the gateway's copy.
  public var appChoice: Bool { choiceMark > 0 }
  public private(set) var choiceMark: UInt64 = 0

  public private(set) var mode = UIMetaMode.local

  /// Bumped by `reset()` and by a change of person. A write taken out under an
  /// older epoch is fenced off: its answer changes nothing here and its retry is
  /// not sent, so one person's request can neither clean nor carry another's.
  public private(set) var epoch: UInt64 = 0

  /// Counts every mark. Each dirty section remembers the count of its latest
  /// mark, and a write only cleans the sections whose mark it carried: an edit
  /// made while the write was out stays dirty (the reference clears it).
  public private(set) var markCount: UInt64 = 0
  private var appMark: UInt64 = 0
  private var botMarks: [String: UInt64] = [:]

  public init() {}

  /// This person's app-wide key, or `nil` while the gateway has named nobody.
  public var appKey: String? {
    userID.isEmpty ? nil : UIMeta.appKey(for: userID)
  }

  /// True while something written locally has not reached the gateway.
  public var pending: Bool {
    dirtyApp || !dirtyBots.isEmpty
  }

  /// The revision held for one key of one profile (`0` when never read).
  public func revision(profile: String, key: String) -> Double {
    revisions[RevisionKey(profile: profile, key: key)] ?? 0
  }

  // MARK: - Local changes

  /// A different person is a different key and a different arrangement, so the
  /// pending app write is dropped rather than published under the new name. Naming
  /// the person for the first time (after `load()` brought back an unsent edit) is
  /// not a change of person, and keeps it.
  public mutating func setUser(_ userID: String) {
    guard userID != self.userID else {
      return
    }

    if !self.userID.isEmpty {
      dirtyApp = false
      choiceMark = 0
    }

    self.userID = userID
    epoch += 1
  }

  public mutating func markBot(_ name: String) {
    markCount += 1
    botMarks[name] = markCount

    if !dirtyBots.contains(name) {
      dirtyBots.append(name)
    }
  }

  /// Mark the app section changed: a `choice` (the default) or a chore, which is sent but never
  /// wins over the gateway's copy.
  public mutating func markApp(choice: Bool = true) {
    markCount += 1
    appMark = markCount
    dirtyApp = true

    if choice {
      choiceMark = markCount
    }
  }

  /// An unsent app change made only of chores loses to any section the gateway holds, and is
  /// dropped rather than sent: it is housekeeping the app redoes on top of whatever it takes, and
  /// nobody chose it (`dropLosingChores` in `packages/gateway-client/src/ui-meta.ts`).
  public mutating func dropLosingChores(remote: UIMetaSnapshot) {
    if dirtyApp, !appChoice, remote.app != nil {
      dirtyApp = false
    }
  }

  /// Forget the revisions, the app section's dirty mark and the person (a
  /// sign-out). Pending BOT edits are kept: bot sections outlive the sign-out, and
  /// an archive made just before it must not be reverted. The epoch moves on, so a
  /// write still out cannot touch what comes next.
  public mutating func reset() {
    let epoch = self.epoch + 1
    let markCount = self.markCount
    let dirtyBots = self.dirtyBots
    let botMarks = self.botMarks

    self = UIMetaState()
    self.epoch = epoch
    self.markCount = markCount
    self.dirtyBots = dirtyBots
    self.botMarks = botMarks
  }

  // MARK: - Reading the roster

  /// A roster this client cannot read is a gateway it cannot sync with.
  public mutating func rosterFailed() {
    mode = .local
  }

  /// `profiles.list` projected onto the two keys (`pull`).
  public mutating func ingest(roster result: JSONValue) -> UIMetaSnapshot {
    let rows = result["profiles"]?.arrayValue ?? []
    var bots: [String: JSONObject] = [:]
    let plugin = UIMetaPlugin.advert(in: rows)
    let appKey = self.appKey
    var app: JSONObject?
    var legacy: JSONObject?
    let known = Double(UIMeta.botSectionVersion)
    let knownApp = Double(UIMeta.appSectionVersion)

    for row in rows {
      guard case .string(let name)? = row["name"], !name.isEmpty else {
        continue
      }

      let held = Self.revisions(of: row)
      let meta = row["ui_meta"]

      revisions[RevisionKey(profile: name, key: UIMeta.botKey)] = held[UIMeta.botKey] ?? 0

      if let section = UIMeta.readSection(meta, key: UIMeta.botKey, known: known) {
        bots[name] = section
      }

      if row["is_default"] == .bool(true) {
        defaultProfile = name
        legacy = UIMeta.readSection(meta, key: UIMeta.legacyAppKey, known: knownApp)
        revisions[RevisionKey(profile: name, key: UIMeta.legacyAppKey)] = held[UIMeta.legacyAppKey] ?? 0

        if let appKey {
          revisions[RevisionKey(profile: name, key: appKey)] = held[appKey] ?? 0
          app = UIMeta.readSection(meta, key: appKey, known: knownApp)
        }
      }
    }

    mode = .synced
    perUser = UIMetaPlugin.hasCapability(plugin, UIMeta.perUserCapability)
    legacyApp = legacy

    let advert: UIMetaAdvert = plugin.map(UIMetaAdvert.advert) ?? .absent

    // The one-time inheritance: this person has no key AND an anonymous one
    // exists. A person who has a key never looks at the legacy one again, and a
    // person with neither starts from the app's own defaults.
    if appKey != nil, app == nil, let legacy {
      return UIMetaSnapshot(
        app: UIMeta.inheritedFromLegacy(legacy),
        bots: bots,
        plugin: advert,
        remote: nil,
        pushHome: perUser ? nil : legacy,
        migrated: true
      )
    }

    return UIMetaSnapshot(app: app, bots: bots, plugin: advert, remote: app, pushHome: perUser ? app : legacy)
  }

  /// One row's revisions, defensively: finite numbers only.
  private static func revisions(of row: JSONValue) -> [String: Double] {
    var out: [String: Double] = [:]

    for (key, value) in row["ui_meta_revisions"]?.objectValue ?? [:] {
      if case .number(let number) = value, number.isFinite {
        out[key] = number
      }
    }

    return out
  }

  // MARK: - Reconciling

  /// A local app section dated later than the gateway's is an UNSENT CHANGE,
  /// whatever this process remembers (the dirty bit does not survive a relaunch).
  /// Not on the inheritance pull, where `app` is the anonymous section.
  public mutating func noteNewerLocalApp(remote: UIMetaSnapshot, local: UIMetaSnapshot) {
    guard !remote.migrated else {
      return
    }

    if let localApp = local.app, UIMeta.appStamp(of: localApp) > UIMeta.appStamp(of: remote.app) {
      markApp()
    }
  }

  /// The gateway's copy, except where this device still holds a change.
  ///
  /// For a bot section a dirty section is the newest by definition; for the app
  /// section the dates decide (`appLocalWins`).
  public func withPendingKept(remote: UIMetaSnapshot, local: UIMetaSnapshot) -> UIMetaSnapshot {
    guard pending else {
      return remote
    }

    var bots = remote.bots

    for name in dirtyBots {
      bots[name] = local.bots[name]
    }

    return UIMetaSnapshot(
      app: appLocalWins(local: local.app, remote: remote.app) ? local.app : remote.app,
      bots: bots,
      // The advert is the gateway's either way: never local, never dirty.
      plugin: remote.plugin == .unread ? .absent : remote.plugin,
      remote: remote.app,
      pushHome: remote.pushHome,
      migrated: false
    )
  }

  /// Whose app section is newer (ADR-0016, "last writer wins needs a definition
  /// of last"): newer wins; a tie goes to the gateway; undated on both sides
  /// keeps the local copy; a gateway with no section takes ours; and a change
  /// made only of chores never wins over a section the gateway holds (HERM-191).
  public func appLocalWins(local: JSONObject?, remote: JSONObject?) -> Bool {
    guard dirtyApp else {
      return false
    }

    guard let remote else {
      return true
    }

    guard let local, appChoice else {
      return false
    }

    let localAt = UIMeta.appStamp(of: local)
    let remoteAt = UIMeta.appStamp(of: remote)

    if localAt == 0 && remoteAt == 0 {
      return true
    }

    return localAt > remoteAt
  }

  /// A section this device has and the gateway does not is SENT: an absent key
  /// is not a decision anybody made. Asked of the local copy after the apply.
  public mutating func seedWhatTheGatewayLacks(remote: UIMetaSnapshot, local: UIMetaSnapshot) {
    if remote.app == nil, local.app != nil {
      markApp()
    }

    for name in local.bots.keys.sorted() where remote.bots[name] == nil {
      markBot(name)
    }
  }

  // MARK: - Writing

  /// Every dirty section, grouped by profile, in the order the reference sends them.
  public func outbox() -> [UIMetaWrite] {
    var writes: [UIMetaWrite] = []

    func add(_ key: String, to profile: String) {
      if let index = writes.firstIndex(where: { $0.profile == profile }) {
        writes[index].keys.append(key)
      } else {
        writes.append(UIMetaWrite(profile: profile, keys: [key], epoch: epoch))
      }
    }

    for name in dirtyBots {
      add(UIMeta.botKey, to: name)
    }

    // No key means nobody has been named: the arrangement stays on the device.
    if dirtyApp, let defaultProfile, let appKey {
      add(appKey, to: defaultProfile)

      // The second key, for a gateway whose notifier cannot read the first.
      if !perUser {
        add(UIMeta.legacyAppKey, to: defaultProfile)
      }
    }

    return writes
  }

  /// The value for each key, taken from the local copy AT THE MOMENT OF THE
  /// ATTEMPT, so a retry after a re-read sends the merge rather than the same
  /// losing bytes. `null` removes a section.
  public func sections(for write: UIMetaWrite, local: UIMetaSnapshot) -> JSONObject {
    var sections: JSONObject = [:]

    for key in write.keys {
      if key == UIMeta.botKey {
        if var section = local.bots[write.profile] {
          section["v"] = .number(Double(UIMeta.botSectionVersion))
          sections[key] = .object(section)
        } else {
          sections[key] = .null
        }

        continue
      }

      if key == UIMeta.legacyAppKey {
        sections[key] = legacyPushSection(local).map(JSONValue.object) ?? .null
        continue
      }

      guard var app = local.app else {
        sections[key] = .null
        continue
      }

      app["v"] = .number(Double(UIMeta.appSectionVersion))

      // The arrangement without the registrations, on a gateway whose notifier
      // would not find them here. Writing them in both places would notify twice.
      if !perUser {
        app.removeValue(forKey: UIMeta.pushField)
      }

      sections[key] = .object(app)
    }

    return sections
  }

  /// The bare key as a read-modify-write that changes only `push`: everything
  /// else in it belongs to whoever wrote it.
  private func legacyPushSection(_ local: UIMetaSnapshot) -> JSONObject? {
    let push = local.app?[UIMeta.pushField]
    let carriesPush = push?.isTruthy == true

    guard carriesPush || legacyApp != nil else {
      return nil
    }

    var section = legacyApp ?? [:]
    section["v"] = .number(Double(UIMeta.appSectionVersion))

    if carriesPush, let push {
      section[UIMeta.pushField] = push
    }

    return section
  }

  /// Whether a write was taken out under the current epoch.
  public func isCurrent(_ write: UIMetaWrite) -> Bool {
    write.epoch == epoch
  }

  /// The write with the marks its sections carry now, taken at the moment of an
  /// attempt together with the bytes that attempt sends.
  public func stamped(_ write: UIMetaWrite) -> UIMetaWrite {
    var write = write
    write.appMark = appMark
    write.botMark = botMarks[write.profile] ?? 0
    return write
  }

  /// The `profiles.configure` params for one attempt.
  public func configureParams(for write: UIMetaWrite, local: UIMetaSnapshot) -> JSONObject {
    var expected: JSONObject = [:]

    for key in write.keys {
      expected[key] = .number(revision(profile: write.profile, key: key))
    }

    return [
      "name": .string(write.profile),
      "ui_meta": .object(sections(for: write, local: local)),
      "ui_meta_expected_revisions": .object(expected)
    ]
  }

  /// Take one answer in: the revisions it applied, the actual revision of every
  /// key it refused.
  ///
  /// `.stale` when the write belongs to an earlier epoch: nothing here is
  /// touched. On `.landed` a section is clean only if it was not marked again
  /// after the attempt was stamped; a newer edit stays dirty for the next run.
  public mutating func absorb(_ result: JSONValue, for write: UIMetaWrite) -> UIMetaAbsorbed {
    guard isCurrent(write) else {
      return .stale
    }

    let applied = result["applied"]?.objectValue

    for (key, value) in applied?["ui_meta_revisions"]?.objectValue ?? [:] {
      if case .number(let number) = value {
        revisions[RevisionKey(profile: write.profile, key: key)] = number
      }
    }

    var conflicted = false

    for (key, value) in applied?["ui_meta_conflicts"]?.objectValue ?? [:] {
      if case .object(let conflict) = value, case .number(let actual)? = conflict["actual"] {
        revisions[RevisionKey(profile: write.profile, key: key)] = actual
        conflicted = true
      }
    }

    if conflicted {
      return .conflicted
    }

    for key in write.keys {
      if key == UIMeta.botKey {
        if botMarks[write.profile] == write.botMark {
          dirtyBots.removeAll { $0 == write.profile }
          botMarks.removeValue(forKey: write.profile)
        }
      } else if appMark == write.appMark {
        dirtyApp = false
        choiceMark = 0
      } else if choiceMark <= write.appMark {
        // The choice landed; what was marked during its flight was a chore.
        choiceMark = 0
      }
    }

    return .landed
  }

  /// Refused, unreachable, or no `profiles.configure` at all: the sections stay
  /// dirty and the next reconcile tries again.
  public mutating func refused() {
    mode = .local
  }
}

/// What one `profiles.configure` answer did.
public enum UIMetaAbsorbed: Sendable, Hashable {
  /// Every section landed (each is clean unless it was marked again meanwhile).
  case landed
  /// At least one section was refused: re-read, then try again.
  case conflicted
  /// The write belongs to an earlier person or sign-in: ignored, not retried.
  case stale
}
