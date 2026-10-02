import Foundation
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

/// `expo/hermie/__tests__/ui-meta-bridge.test.ts` and the two-device cases of
/// `ui-meta-devices.ts`, for the settings half: the shape, the diff, and the loop
/// that must not close.
@Suite(.timeLimit(.minutes(1))) struct UIMetaSettingsTests {
  /// One device: its settings store, its sync, the bridge between them.
  struct Device {
    let store: InMemorySettingsStore
    let sync: UIMetaSync
    let bridge: UIMetaSettingsBridge

    /// Open the app: read the disk, register, then the store's baseline.
    static func open(
      _ gateway: HoldingGateway,
      settings: SyncedSettings = SyncedSettings(),
      disk: MemoryPersistence = MemoryPersistence(),
      clock: TestWallClock = TestWallClock(noon),
      debounce: Duration? = .zero
    ) async -> Device {
      let store = InMemorySettingsStore(settings)
      let sync = UIMetaSync.device(gateway.gateway, persistence: disk, debounce: debounce, clock: clock)
      let bridge = UIMetaSettingsBridge(store: store, sync: sync)

      await bridge.start()
      return Device(store: store, sync: sync, bridge: bridge)
    }

    /// The reader changes a setting through the store, and the app says so.
    func change(_ edit: (inout SyncedSettings) -> Void) async {
      var settings = store.syncedSettings
      edit(&settings)
      store.syncedSettings = settings
      await bridge.settingsDidChange()
    }
  }

  // MARK: The projection

  @Test func projectsTheFiveSettingsIntoTheAppSection() async {
    let device = await Device.open(HoldingGateway(), settings: SyncedSettings(
      defaults: VisibilityOptions(level: .verbose, showBotToBot: false, showThinking: true),
      botNameOrder: .profile,
      textSize: .large,
      themeChoice: .user(id: "t1"),
      userThemes: [["id": "t1", "name": "Studio", "base": "lime", "light": ["accent": "#fff"]]]
    ))

    #expect(device.sync.app == [
      "v": 1,
      "defaults": ["level": "verbose", "showBotToBot": false, "showThinking": true],
      "botNameOrder": "profile",
      "textSize": "large",
      "themeChoice": ["kind": "user", "id": "t1"],
      "themes": [["id": "t1", "name": "Studio", "base": "lime", "light": ["accent": "#fff"]]]
    ])
    // The device's baseline is not a choice: nothing to send, nothing dated.
    #expect(!device.sync.pending)
  }

  @Test func readsAGatewaysCopyBackIntoTheStore() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: [
      "v": 1,
      "defaults": ["level": "normal", "showBotToBot": false, "showThinking": true],
      "botNameOrder": "profile",
      "textSize": "xlarge",
      "themeChoice": ["kind": "preset", "name": "graphite"],
      "themes": [["id": "t1", "name": "Studio", "base": "lime"]]
    ]])

    let device = await Device.open(gateway)
    await device.sync.reconcile()

    #expect(device.store.syncedSettings == SyncedSettings(
      defaults: VisibilityOptions(level: .normal, showBotToBot: false, showThinking: true),
      botNameOrder: .profile,
      textSize: .xlarge,
      themeChoice: .preset("graphite"),
      userThemes: [["id": "t1", "name": "Studio", "base": "lime"]]
    ))
  }

  @Test func readsEachFieldDefensively() {
    let patch = SyncedSettingsPatch(app: [
      "defaults": ["level": "loud", "showBotToBot": "yes"],
      "botNameOrder": "handle",
      "textSize": "huge",
      "themeChoice": ["kind": "preset", "name": "tartan"],
      "themes": [
        ["id": "a", "base": "blue"],
        ["id": "a", "base": "lime"],
        ["id": "", "base": "lime"],
        ["id": "b", "base": "tartan"],
        "not a theme",
        ["id": "c", "base": "graphite", "dark": ["x": 1]]
      ]
    ])

    // A level it does not know falls back field by field, as `chatViewOf` does.
    #expect(patch.defaults == SyncedSettings.defaultChatView)
    #expect(patch.botNameOrder == nil)
    #expect(patch.textSize == nil)
    #expect(patch.themeChoice == nil)
    #expect(patch.userThemes == [["id": "a", "base": "blue"], ["id": "c", "base": "graphite", "dark": ["x": 1]]])

    #expect(SyncedSettingsPatch(app: ["themeChoice": ["kind": "user", "id": ""]]).themeChoice == nil)
    #expect(SyncedSettingsPatch(app: ["themeChoice": ["kind": "user", "id": "t9"]]).themeChoice == .user(id: "t9"))
    #expect(SyncedSettingsPatch(app: ["defaults": []]).defaults == SyncedSettings.defaultChatView)
    #expect(SyncedSettingsPatch(app: ["defaults": "verbose"]).defaults == nil)
    #expect(SyncedSettingsPatch(app: ["themes": [:]]).userThemes == nil)
  }

  @Test func leavesTheReadersOwnValueWhenTheSectionNeverMentionsIt() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "textSize": "small"]])

    let device = await Device.open(gateway, settings: SyncedSettings(botNameOrder: .profile))
    await device.sync.reconcile()

    #expect(device.store.syncedSettings.botNameOrder == .profile)
    #expect(device.store.syncedSettings.textSize == .small)
  }

  // MARK: The bridge

  @Test func sendsWhatTheReaderChangedAsADatedChoice() async {
    let gateway = HoldingGateway()
    let device = await Device.open(gateway)

    await device.sync.reconcile()
    let seeded = gateway.configures.count

    await device.change { $0.themeChoice = .preset("lime") }
    await device.sync.settle()

    #expect(gateway.configures.count == seeded + 1)
    #expect(gateway.meta("researcher")[ownerKey]?["themeChoice"] == ["kind": "preset", "name": "lime"])
    #expect(gateway.meta("researcher")[ownerKey]?["updatedAt"] == .number(noon))
  }

  @Test func seedsAGatewayThatHasNoSectionAndThenSaysNothingMore() async {
    let gateway = HoldingGateway()
    let device = await Device.open(gateway)

    await device.sync.reconcile()
    await device.sync.settle()

    #expect(gateway.configures.count == 1)
    #expect(gateway.meta("researcher")[ownerKey]?["textSize"] == "default")

    // Nothing echoes: what came back in is not a local change.
    await device.bridge.settingsDidChange()
    await device.sync.reconcile()
    await device.sync.settle()

    #expect(gateway.configures.count == 1)
  }

  @Test func whatArrivesIsNotSentHomeAgain() async {
    let gateway = HoldingGateway()
    let device = await Device.open(gateway)

    await device.sync.reconcile()
    await device.sync.settle()

    gateway.write("researcher", [ownerKey: ["v": 1, "textSize": "large", "updatedAt": .number(noon + hour)]])
    let before = gateway.configures.count

    await device.sync.reconcile()
    // The store took it, and whatever the app does with the store's own change
    // notification, the bridge sees no change.
    await device.bridge.settingsDidChange()
    await device.sync.settle()

    #expect(device.store.syncedSettings.textSize == .large)
    #expect(gateway.configures.count == before)
    #expect(!device.sync.pending)
  }

  /// A store that takes a gateway's copy later than asked (a main-actor model
  /// does): the reader's own change meanwhile is sent, and the copy is not
  /// sent back over itself.
  @Test func aChangeMadeWhileACopyGoesInIsSentAndTheCopyIsNotUndone() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "themeChoice": ["kind": "preset", "name": "lime"], "updatedAt": .number(noon - hour)]])

    let store = GatedSettingsStore()
    let sync = UIMetaSync.device(gateway.gateway, debounce: .zero)
    let bridge = UIMetaSettingsBridge(store: store, sync: sync)
    await bridge.start()

    let reconcile = Task { await sync.reconcile() }
    await store.waitUntilHeld()

    store.inner.syncedSettings.textSize = .large
    await bridge.settingsDidChange()
    store.release()
    _ = await reconcile.value
    await sync.settle()

    let app = gateway.meta("researcher")[ownerKey]
    #expect(store.inner.syncedSettings.themeChoice == .preset("lime"))
    #expect(app?["themeChoice"] == ["kind": "preset", "name": "lime"])
    #expect(app?["textSize"] == "large")
    #expect(app?["updatedAt"] == .number(noon))
  }

  /// A contributor that runs its body when a copy is handed out: registered
  /// before the bridge, so it runs between the take and the bridge's turn.
  final class Interloper: UIMetaContributor {
    let body: @Sendable () async -> Void

    init(_ body: @escaping @Sendable () async -> Void) {
      self.body = body
    }

    func didApply(_ documents: UIMetaDocuments, snapshot: UIMetaSnapshot) async {
      await body()
    }
  }

  @Test func aChoiceMadeBetweenTheTakeAndTheApplyIsNotPutBack() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "themeChoice": ["kind": "preset", "name": "lime"], "updatedAt": .number(noon - hour)]])

    let store = InMemorySettingsStore()
    let sync = UIMetaSync.device(gateway.gateway, debounce: nil)
    let bridge = UIMetaSettingsBridge(store: store, sync: sync)
    let interloper = Interloper {
      // The reader picks graphite while the copy is on its way to the store.
      store.syncedSettings.themeChoice = .preset("graphite")
      await bridge.settingsDidChange()
    }

    sync.register(interloper)
    await bridge.start()
    await sync.reconcile()
    await sync.settle()

    #expect(store.syncedSettings.themeChoice == .preset("graphite"))
    #expect(sync.app?["themeChoice"] == ["kind": "preset", "name": "graphite"])
    #expect(gateway.meta("researcher")[ownerKey]?["themeChoice"] == ["kind": "preset", "name": "graphite"])
    withExtendedLifetime(interloper) {}
  }

  /// Copies overlap on the bridge: the first finishing must not make it hear
  /// the second (already in the store) as a choice, or that older value would
  /// be dated over the newer copy the sync took in meanwhile.
  @Test func overlappingCopiesAreNotHeardAsAChoice() async {
    let store = GatedSettingsStore(appliesFirst: true)
    let sync = UIMetaSync.device(HoldingGateway.unreachable, debounce: nil)
    let bridge = UIMetaSettingsBridge(store: store, sync: sync)
    await bridge.start()

    sync.updateApp(.baseline) { $0["textSize"] = "large" }
    let first = Task { await bridge.didApply(sync.documents, snapshot: UIMetaSnapshot()) }
    await store.waitUntilHeld(1)

    sync.updateApp(.baseline) { $0["themeChoice"] = ["kind": "preset", "name": "lime"] }
    let second = Task { await bridge.didApply(sync.documents, snapshot: UIMetaSnapshot()) }
    await store.waitUntilHeld(2)

    // A newer copy is taken in; its own turn at the store comes later.
    sync.updateApp(.baseline) { $0["themeChoice"] = ["kind": "preset", "name": "graphite"] }

    // The first is in, and the store reports lime while the second is still out.
    store.releaseOne()
    await first.value
    await bridge.settingsDidChange()

    store.releaseOne()
    await second.value

    let third = Task { await bridge.didApply(sync.documents, snapshot: UIMetaSnapshot()) }
    await store.waitUntilHeld(1)
    store.releaseOne()
    await third.value
    await bridge.settingsDidChange()

    #expect(sync.app?["themeChoice"] == ["kind": "preset", "name": "graphite"])
    #expect(store.syncedSettings.themeChoice == .preset("graphite"))
    #expect(store.syncedSettings.textSize == .large)
    // Nothing the gateway sent came back as a dated choice of this device's.
    #expect(!sync.pending)
    #expect(sync.app?["updatedAt"] == nil)
  }

  @Test func aLaunchKeepsAValueItCannotReadAndReplacesOneItCan() async {
    let sync = UIMetaSync.device(
      HoldingGateway.unreachable,
      app: ["v": 1, "textSize": "xxlarge", "botNameOrder": "profile"],
      debounce: nil
    )
    let bridge = UIMetaSettingsBridge(
      store: InMemorySettingsStore(SyncedSettings(botNameOrder: .display, textSize: .large)),
      sync: sync
    )

    await bridge.start()

    #expect(sync.app?["textSize"] == "xxlarge")
    #expect(sync.app?["botNameOrder"] == "display")
    #expect(!sync.pending)
  }

  @Test func aValueThisBuildCannotReadIsCarriedNotRepaired() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "textSize": "xxlarge", "themeChoice": ["kind": "preset", "name": "lime"]]])

    let device = await Device.open(gateway, settings: SyncedSettings(textSize: .large))
    await device.sync.reconcile()

    #expect(device.store.syncedSettings.textSize == .large)

    await device.change { $0.themeChoice = .preset("graphite") }
    await device.sync.settle()

    // A newer build's size goes back as it came; only the theme moved.
    #expect(gateway.meta("researcher")[ownerKey]?["textSize"] == "xxlarge")
    #expect(gateway.meta("researcher")[ownerKey]?["themeChoice"] == ["kind": "preset", "name": "graphite"])
  }

  @Test func coalescesARunOfChangesIntoOneRequest() async {
    let gateway = HoldingGateway()
    let device = await Device.open(gateway, debounce: .milliseconds(50))

    await device.sync.reconcile()
    let seeded = gateway.configures.count

    await device.change { $0.textSize = .small }
    await device.change { $0.textSize = .large }
    await device.change { $0.botNameOrder = .profile }
    await device.sync.settle()

    #expect(gateway.configures.count == seeded + 1)
    #expect(gateway.meta("researcher")[ownerKey]?["textSize"] == "large")
    #expect(gateway.meta("researcher")[ownerKey]?["botNameOrder"] == "profile")
  }

  @Test func sendsOneRequestPerProfileNotPerSection() async {
    let gateway = HoldingGateway()
    let device = await Device.open(gateway, debounce: .milliseconds(20))

    await device.sync.reconcile()
    let seeded = gateway.configures.count

    device.sync.updateBot("researcher") { $0["colour"] = "lime" }
    await device.change { $0.themeChoice = .preset("lime") }
    await device.sync.settle()

    let writes = gateway.configures.dropFirst(seeded)
    #expect(writes.count == 1)
    #expect(writes.first?["ui_meta"]?.objectValue.map { Set($0.keys) } == [UIMeta.botKey, ownerKey])
  }

  // MARK: Two devices (ui-meta-devices.ts)

  @Test func aThemeChosenOnOneDeviceArrivesOnTheNextAndStays() async {
    let gateway = HoldingGateway()
    let desktop = await Device.open(gateway)

    await desktop.sync.reconcile()
    await desktop.change { $0.themeChoice = .preset("graphite") }
    await desktop.sync.settle()

    // A phone nobody has used: its defaults must not win over a choice.
    let phone = await Device.open(gateway, clock: TestWallClock(noon + hour))
    await phone.sync.reconcile()
    await phone.sync.settle()

    #expect(phone.store.syncedSettings.themeChoice == .preset("graphite"))
    #expect(gateway.meta("researcher")[ownerKey]?["themeChoice"] == ["kind": "preset", "name": "graphite"])
    #expect(gateway.meta("researcher")[ownerKey]?["updatedAt"] == .number(noon))

    // And the desktop, reconnecting, still has it.
    await desktop.sync.reconcile()
    #expect(desktop.store.syncedSettings.themeChoice == .preset("graphite"))
  }

  @Test func theLaterChoiceWinsInEitherConnectOrder() async {
    for laterFirst in [true, false] {
      let gateway = HoldingGateway()
      let earlierDisk = MemoryPersistence()
      let laterDisk = MemoryPersistence()

      // Both chose with no gateway: lime at noon, graphite an hour later.
      let earlier = await Device.open(HoldingGateway(), disk: earlierDisk, clock: TestWallClock(noon))
      await earlier.change { $0.themeChoice = .preset("lime") }
      await earlier.sync.settle()

      let later = await Device.open(HoldingGateway(), disk: laterDisk, clock: TestWallClock(noon + hour))
      await later.change { $0.themeChoice = .preset("graphite") }
      await later.sync.settle()

      // Relaunched on this gateway, each from its own disk (the store's and the
      // sections') and in this order.
      let earlierLaunch = (earlierDisk, earlier.store.syncedSettings)
      let laterLaunch = (laterDisk, later.store.syncedSettings)
      let order = laterFirst ? [laterLaunch, earlierLaunch] : [earlierLaunch, laterLaunch]
      var devices: [Device] = []

      for (disk, settings) in order {
        let device = await Device.open(gateway, settings: settings, disk: disk, clock: TestWallClock(noon + 2 * hour))
        await device.sync.reconcile()
        await device.sync.settle()
        devices.append(device)
      }

      for device in devices {
        await device.sync.reconcile()
        #expect(device.store.syncedSettings.themeChoice == .preset("graphite"), "later first: \(laterFirst)")
      }

      #expect(gateway.meta("researcher")[ownerKey]?["themeChoice"] == ["kind": "preset", "name": "graphite"])
      #expect(gateway.meta("researcher")[ownerKey]?["updatedAt"] == .number(noon + hour))
    }
  }
}
