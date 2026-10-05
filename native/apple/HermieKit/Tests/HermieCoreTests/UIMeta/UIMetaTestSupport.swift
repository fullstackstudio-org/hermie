import Foundation
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// Whoever the gateway named, for the cases that are not about two people. An
/// ungated gateway names the one person `owner`.
let owner = "owner"
let ownerKey = UIMeta.appKey(for: owner)
let noon: Double = 1_789_950_000
let hour: Double = 3600

/// A gateway that keeps its `ui_meta`, revisions and all (`holdingGateway` in
/// `expo/hermie/__tests__/support/ui-meta-devices.ts`): `profiles.list` and the
/// per-key compare-and-swap of `profiles.configure`, and nothing else.
///
/// `researcher` is the default profile, so the app-wide key lives on it; both
/// profiles carry the `hermes-bots` marker another tool owns.
final class HoldingGateway: Sendable {
  struct State {
    var meta: [String: JSONObject]
    var revisions: [String: [String: Double]] = ["researcher": [:], "writer": [:]]
    var calls: [(method: String, params: JSONObject)] = []
    var offline = false
    /// Writes that another device lands just before each of the next N configures.
    var interference = 0
    /// The method whose next request is kept in flight until `release()`.
    var armed: String?
    var held: CheckedContinuation<Void, Never>?
  }

  let state: Mutex<State>

  /// - Parameter capabilities: the plugin's advert; without `ui_meta.per_user`
  ///   the push rows stay on the bare `hermie-app`. `nil` is no plugin at all.
  init(capabilities: [String]? = [UIMeta.perUserCapability, "push.seen.per_chat"]) {
    var researcher: JSONObject = [UIMeta.botMarkerKey: [:]]

    if let capabilities {
      researcher[UIMeta.pluginKey] = [
        "v": 1,
        "version": "0.2.0",
        "capabilities": .array(capabilities.map(JSONValue.string)),
        "modules": ["push": "on"]
      ]
    }

    state = Mutex(State(meta: ["researcher": researcher, "writer": [UIMeta.botMarkerKey: [:]]]))
  }

  var gateway: UIMetaGateway {
    UIMetaGateway { method, params in
      await self.holdIfArmed(method)
      return try self.handle(method, params)
    }
  }

  /// Keep the next `method` request in flight (not yet answered or applied).
  func hold(_ method: String) {
    state.withLock { $0.armed = method }
  }

  /// Until a request is being held.
  func waitUntilHeld() async {
    await uiMetaEventually("a held request") { state.withLock { $0.held != nil } }
  }

  /// Let the held request through.
  func release() {
    let held = state.withLock { state -> CheckedContinuation<Void, Never>? in
      defer { state.held = nil }
      return state.held
    }

    held?.resume()
  }

  private func holdIfArmed(_ method: String) async {
    guard state.withLock({ $0.armed == method }) else {
      return
    }

    await withCheckedContinuation { continuation in
      state.withLock { state in
        state.armed = nil
        state.held = continuation
      }
    }
  }

  /// A gateway that is not there.
  static let unreachable = UIMetaGateway { _, _ in throw URLError(.notConnectedToInternet) }

  var offline: Bool {
    get { state.withLock { $0.offline } }
    set { state.withLock { $0.offline = newValue } }
  }

  func interfere(times: Int) {
    state.withLock { $0.interference = times }
  }

  /// One profile's `ui_meta` as the gateway holds it.
  func meta(_ profile: String) -> JSONObject {
    state.withLock { $0.meta[profile] ?? [:] }
  }

  func revision(_ profile: String, _ key: String) -> Double {
    state.withLock { $0.revisions[profile]?[key] ?? 0 }
  }

  var configures: [JSONObject] {
    state.withLock { $0.calls.filter { $0.method == "profiles.configure" }.map(\.params) }
  }

  var callCount: Int { state.withLock { $0.calls.count } }

  /// A write by somebody else (another tool, an older build), with no expected revision.
  func write(_ profile: String, _ sections: JSONObject) {
    _ = try? handle("profiles.configure", ["name": .string(profile), "ui_meta": .object(sections)], record: false)
  }

  private func handle(_ method: String, _ params: JSONObject, record: Bool = true) throws -> JSONValue {
    try state.withLock { state in
      if state.offline {
        throw URLError(.notConnectedToInternet)
      }

      if record {
        state.calls.append((method, params))
      }

      switch method {
      case "profiles.list":
        let rows: [JSONValue] = state.meta.keys.sorted().map { name in
          [
            "name": .string(name),
            "is_default": .bool(name == "researcher"),
            "ui_meta": .object(state.meta[name] ?? [:]),
            "ui_meta_revisions": .object((state.revisions[name] ?? [:]).mapValues(JSONValue.number))
          ]
        }
        return ["profiles": .array(rows)]

      case "profiles.configure":
        let name = params["name"]?.stringValue ?? ""

        guard state.meta[name] != nil else {
          throw URLError(.badServerResponse)
        }

        let sections = params["ui_meta"]?.objectValue ?? [:]
        let expected = params["ui_meta_expected_revisions"]?.objectValue ?? [:]

        if record, state.interference > 0 {
          state.interference -= 1

          for key in sections.keys {
            state.revisions[name, default: [:]][key, default: 0] += 1
          }
        }

        var conflicts: JSONObject = [:]

        for (key, value) in sections {
          let actual = state.revisions[name]?[key] ?? 0

          // The per-key compare-and-swap: one section refused, the others in the
          // same request still applied.
          if let wanted = expected[key], wanted != .number(actual) {
            conflicts[key] = ["expected": wanted, "actual": .number(actual)]
            continue
          }

          // A section written as null is REMOVED, as the real gateway does.
          // (Spelt out: `nil` would read as JSON null in a ternary over JSONValue.)
          if value == .null {
            state.meta[name]?.removeValue(forKey: key)
          } else {
            state.meta[name]?[key] = value
          }
          state.revisions[name, default: [:]][key] = actual + 1
        }

        var applied: JSONObject = [
          "ui_meta": .bool(conflicts.isEmpty),
          "ui_meta_revisions": .object((state.revisions[name] ?? [:]).mapValues(JSONValue.number))
        ]

        if !conflicts.isEmpty {
          applied["ui_meta_conflicts"] = .object(conflicts)
        }

        return ["ok": true, "applied": .object(applied)]

      default:
        return [:]
      }
    }
  }
}

/// A device's copy between launches, in memory.
final class MemoryPersistence: UIMetaPersistence {
  let stored = Mutex<UIMetaStoredCopy?>(nil)

  init(_ copy: UIMetaStoredCopy? = nil) {
    stored.withLock { $0 = copy }
  }

  func load() async -> UIMetaStoredCopy? {
    stored.withLock { $0 }
  }

  func save(_ copy: UIMetaStoredCopy) async {
    stored.withLock { $0 = copy }
  }

  /// The bytes as they would reach the disk.
  var bytes: String {
    guard let copy = stored.withLock({ $0 }), let data = try? JSONEncoder().encode(copy) else {
      return ""
    }

    return String(decoding: data, as: UTF8.self)
  }
}

/// A settings store that holds each gateway copy until the test releases it,
/// first in, first out (a main-actor model applies later than it is asked).
final class GatedSettingsStore: SettingsStore {
  let inner = InMemorySettingsStore()
  private let held = Mutex<[CheckedContinuation<Void, Never>]>([])
  /// Apply at once and only then wait: the store has the values (and may say
  /// so) before the bridge hears back.
  let appliesFirst: Bool

  init(appliesFirst: Bool = false) {
    self.appliesFirst = appliesFirst
  }

  var syncedSettings: SyncedSettings { inner.syncedSettings }

  func applySynced(_ patch: SyncedSettingsPatch) async {
    if appliesFirst {
      inner.applySynced(patch)
    }

    await withCheckedContinuation { continuation in
      held.withLock { $0.append(continuation) }
    }

    if !appliesFirst {
      inner.applySynced(patch)
    }
  }

  /// Until `count` copies are waiting to go in.
  func waitUntilHeld(_ count: Int = 1) async {
    await uiMetaEventually("\(count) held copies") { held.withLock { $0.count >= count } }
  }

  /// Let the oldest waiting copy in.
  func releaseOne() {
    let first = held.withLock { $0.isEmpty ? nil : $0.removeFirst() }
    first?.resume()
  }

  func release() {
    for continuation in held.withLock({ held in defer { held = [] }; return held }) {
      continuation.resume()
    }
  }
}

/// Until `condition` holds, on the caller's actor (the main actor, for a model that lives there); a
/// deadline turns a hang into a failure. The wait is `waitUntil`: it counts only the waiting that is the
/// test's own, since the main actor is busy for seconds with other suites.
func uiMetaEventually(
  _ what: String,
  patience: Duration = .seconds(10),
  isolation: isolated (any Actor)? = #isolation,
  sourceLocation: SourceLocation = #_sourceLocation,
  _ condition: () -> Bool
) async {
  await waitUntil(what, patience: patience, isolation: isolation, sourceLocation: sourceLocation, condition)
}

/// A wall clock a test sets.
final class TestWallClock: Sendable {
  let seconds: Mutex<Double>

  init(_ seconds: Double) {
    self.seconds = Mutex(seconds)
  }

  var now: @Sendable () -> Double {
    { self.seconds.withLock { $0 } }
  }

  func set(_ value: Double) {
    seconds.withLock { $0 = value }
  }
}

extension UIMetaSync {
  /// One device as the reference's suite builds it: its own local copy, a sync
  /// bound to it, named before anything is read, and no debounce unless asked.
  static func device(
    _ gateway: UIMetaGateway,
    app: JSONObject? = nil,
    bots: [String: JSONObject] = [:],
    user: String = owner,
    persistence: (any UIMetaPersistence)? = nil,
    debounce: Duration? = nil,
    clock: TestWallClock = TestWallClock(noon)
  ) -> UIMetaSync {
    var options = UIMetaSync.Options()
    options.debounce = debounce
    options.now = clock.now

    let sync = UIMetaSync(
      gateway: gateway,
      documents: UIMetaDocuments(app: app, bots: bots),
      persistence: persistence,
      options: options
    )

    sync.setUser(user)
    return sync
  }

  /// Replace the app section whole and mark it, as the reference's cases do.
  func setApp(_ section: JSONObject) {
    updateApp(.chore) { $0 = section }
    markApp()
  }

  /// Replace one bot's section whole and mark it.
  func setBot(_ name: String, _ section: JSONObject?) {
    updateBot(name, .chore) { $0 = section ?? [:] }
    markBot(name)
  }
}
