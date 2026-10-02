import Foundation
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// `packages/gateway-client/src/ui-meta.test.ts`, against a gateway that keeps
/// what it is told (the black-box versions over a real socket are in
/// `HermieIntegrationTests/UIMetaIntegrationTests.swift`).
@Suite(.timeLimit(.minutes(1))) struct UIMetaSyncTests {
  // MARK: One device writing

  @Test func sendsABotSectionAndReadsItBack() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.setBot("researcher", ["archived": true, "colour": "lime"])
    await phone.flush()

    #expect(gateway.meta("researcher")[UIMeta.botKey] == ["v": 1, "archived": true, "colour": "lime"])
    #expect(!phone.pending)
    #expect(phone.mode == .synced)
  }

  @Test func leavesTheMarkerAnotherToolOwnsWhereItWas() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.setBot("researcher", ["colour": "teal"])
    await phone.flush()

    #expect(Set(gateway.meta("researcher").keys) == [UIMeta.botMarkerKey, UIMeta.pluginKey, UIMeta.botKey])
    #expect(gateway.meta("researcher")[UIMeta.botMarkerKey] == [:])
  }

  @Test func putsTheAppSectionOnTheDefaultProfileOnly() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.setApp(["order": ["writer", "researcher"]])
    await phone.flush()

    #expect(gateway.meta("researcher")[ownerKey] != nil)
    #expect(gateway.meta("writer")[ownerKey] == nil)
  }

  // MARK: A second device

  @Test func aSecondDeviceReadsWhatTheFirstWrote() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.setApp(["dividers": ["Finance"]])
    phone.setBot("writer", ["archived": true])
    await phone.flush()

    let desktop = UIMetaSync.device(gateway.gateway)
    await desktop.reconcile()

    #expect(desktop.app?["dividers"] == ["Finance"])
    #expect(desktop.bot("writer")?["archived"] == true)
  }

  @Test func ignoresASectionWhoseVersionItDoesNotKnow() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [UIMeta.botKey: ["v": 99, "colour": "from-the-future"]])

    let phone = UIMetaSync.device(gateway.gateway, bots: ["researcher": ["v": 1, "colour": "teal"]])
    await phone.reconcile()

    #expect(phone.bot("researcher") == nil)
  }

  // MARK: Two devices at once

  @Test func retriesARefusedWriteWithTheRevisionThatWonAndLands() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)
    let desktop = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    await desktop.reconcile()

    desktop.setBot("researcher", ["colour": "teal"])
    await desktop.flush()

    // The phone holds a revision that is now stale, and writes anyway.
    phone.setBot("researcher", ["colour": "lime"])
    await phone.flush()

    #expect(gateway.meta("researcher")[UIMeta.botKey]?["colour"] == "lime")
    #expect(!phone.pending)
    // One refused, one re-read, one landed.
    #expect(gateway.configures.count == 3)
  }

  @Test func landsTheSectionsOfARequestWhoseOtherSectionConflicts() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)
    let desktop = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    await desktop.reconcile()

    desktop.setApp(["order": ["writer"]])
    await desktop.flush()

    phone.setApp(["order": ["researcher"]])
    phone.setBot("researcher", ["archived": true])
    await phone.flush()

    let meta = gateway.meta("researcher")
    #expect(meta[UIMeta.botKey]?["archived"] == true)
    #expect(meta[ownerKey]?["order"] == ["researcher"])
    #expect(meta[UIMeta.botMarkerKey] != nil)
  }

  @Test func leavesASectionDirtyWhenAThirdWriterKeepsWinning() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    gateway.interfere(times: 2)
    phone.setBot("researcher", ["colour": "lime"])
    await phone.flush()

    // Two attempts (the retry is bounded at one), each refused, each followed
    // by a re-read; then it waits for the next reconcile rather than spinning.
    #expect(gateway.configures.count == 2)
    #expect(phone.pending)
    #expect(gateway.meta("researcher")[UIMeta.botKey] == nil)

    await phone.reconcile()

    #expect(!phone.pending)
    #expect(gateway.meta("researcher")[UIMeta.botKey]?["colour"] == "lime")
  }

  /// The reason a conflict re-reads before it re-sends: the rows another device
  /// put in the section are not a rival version of ours.
  @Test func aRetryCarriesTheRowsTheWinningWriterAdded() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)
    let tablet = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    await tablet.reconcile()

    let tabletRow: JSONValue = ["v": 1, "transport": "relay", "handle": "h-tablet"]
    tablet.setApp(["themeChoice": ["kind": "preset", "name": "lime"], "push": ["registrations": ["i-tablet": tabletRow]]])
    await tablet.flush()

    phone.updateApp { $0["themeChoice"] = ["kind": "preset", "name": "graphite"] }
    await phone.flush()

    let app = gateway.meta("researcher")[ownerKey]
    #expect(app?["themeChoice"]?["name"] == "graphite")
    #expect(app?["push"]?["registrations"]?["i-tablet"] == tabletRow)
  }

  // MARK: No gateway, and then one

  @Test func keepsAWriteLocalAndSendsItOnTheNextReconcile() async {
    let gateway = HoldingGateway()
    let failing = UIMetaSync.device(HoldingGateway.unreachable)

    failing.setBot("researcher", ["colour": "lime"])

    #expect(await failing.reconcile() == nil)
    #expect(failing.mode == .local)
    #expect(failing.pending)
    #expect(gateway.meta("researcher")[UIMeta.botKey] == nil)

    // The same pending write, once a gateway is reachable.
    let back = UIMetaSync.device(gateway.gateway, bots: failing.documents.bots)
    back.markBot("researcher")
    await back.reconcile()

    #expect(gateway.meta("researcher")[UIMeta.botKey]?["colour"] == "lime")
    #expect(back.mode == .synced)
    #expect(!back.pending)
  }

  @Test func aRefusedWriteIsKeptAndSentWhenTheGatewayIsBack() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    gateway.offline = true
    phone.updateApp { $0["themeChoice"] = ["kind": "preset", "name": "lime"] }
    await phone.flush()

    #expect(phone.mode == .local)
    #expect(phone.pending)

    gateway.offline = false
    await phone.reconcile()

    #expect(gateway.meta("researcher")[ownerKey]?["themeChoice"]?["name"] == "lime")
    #expect(!phone.pending)
  }

  @Test func aRemoteCopyDoesNotOverwriteAChangeMadeWhileAway() async {
    let gateway = HoldingGateway()
    let desktop = UIMetaSync.device(gateway.gateway)

    await desktop.reconcile()
    desktop.setBot("researcher", ["colour": "teal"])
    await desktop.flush()

    let phone = UIMetaSync.device(gateway.gateway, bots: ["researcher": ["v": 1, "colour": "lime"]])
    phone.markBot("researcher")
    await phone.reconcile()

    #expect(gateway.meta("researcher")[UIMeta.botKey]?["colour"] == "lime")
  }

  // MARK: One key per person

  @Test func keepsTwoPeopleOutOfEachOthersArrangement() async {
    let gateway = HoldingGateway()
    let alice = UIMetaSync.device(gateway.gateway, user: "alice")
    let bob = UIMetaSync.device(gateway.gateway, user: "bob")

    await alice.reconcile()
    alice.setApp(["themeChoice": "midnight", "entries": [["kind": "chat", "name": "writer"]]])
    await alice.flush()

    await bob.reconcile()
    #expect(bob.app == nil)

    bob.setApp(["themeChoice": "sand", "entries": [["kind": "chat", "name": "researcher"]]])
    await bob.flush()

    let meta = gateway.meta("researcher")
    #expect(meta[UIMeta.appKey(for: "alice")]?["themeChoice"] == "midnight")
    #expect(meta[UIMeta.appKey(for: "bob")]?["themeChoice"] == "sand")

    await alice.reconcile()
    #expect(alice.app?["themeChoice"] == "midnight")
  }

  @Test func aSecondDeviceOfTheSamePersonGetsTheSameArrangement() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway, user: "alice")

    await phone.reconcile()
    phone.setApp(["entries": [["kind": "chat", "name": "writer"]], "themeChoice": "midnight"])
    await phone.flush()

    let tablet = UIMetaSync.device(gateway.gateway, user: "alice")
    await tablet.reconcile()

    #expect(tablet.app?["entries"] == [["kind": "chat", "name": "writer"]])
    #expect(tablet.app?["themeChoice"] == "midnight")
  }

  @Test func writesNoArrangementWhileTheGatewayHasNamedNobody() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway, user: "")

    await phone.reconcile()
    phone.setApp(["themeChoice": "midnight"])
    phone.setBot("writer", ["archived": true])
    await phone.flush()

    #expect(gateway.meta("researcher").keys.filter { $0.hasPrefix(UIMeta.legacyAppKey) }.isEmpty)
    #expect(gateway.meta("writer")[UIMeta.botKey]?["archived"] == true)
  }

  @Test func aDifferentPersonDropsThePendingAppWrite() {
    let phone = UIMetaSync.device(HoldingGateway.unreachable, user: "alice")

    phone.setApp(["themeChoice": "midnight"])
    phone.setBot("writer", ["archived": true])
    phone.setUser("bob")

    #expect(!phone.state.dirtyApp)
    #expect(phone.state.dirtyBots == ["writer"])
  }

  // MARK: The newest choice, wherever it was made

  private func appOn(_ gateway: HoldingGateway) -> JSONObject? {
    gateway.meta("researcher")[ownerKey]?.objectValue
  }

  @Test func takesALaterChoiceOntoTheDeviceThatChoseEarlier() async {
    let gateway = HoldingGateway()
    let desktop = UIMetaSync.device(gateway.gateway)

    await desktop.reconcile()
    desktop.setApp(["themeChoice": "graphite", "updatedAt": .number(noon)])
    await desktop.flush()

    let phone = UIMetaSync.device(gateway.gateway, app: ["v": 1, "themeChoice": "lime", "updatedAt": .number(noon - hour)])
    phone.markApp()
    await phone.reconcile()

    #expect(phone.app?["themeChoice"] == "graphite")
    #expect(appOn(gateway)?["themeChoice"] == "graphite")
  }

  @Test func doesTheSameInTheOtherConnectOrder() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.setApp(["themeChoice": "lime", "updatedAt": .number(noon - hour)])
    await phone.flush()

    // Not marked by the caller: the date says this device holds something the
    // gateway has not got, which is all there is to go on after a relaunch.
    let desktop = UIMetaSync.device(gateway.gateway, app: ["v": 1, "themeChoice": "graphite", "updatedAt": .number(noon)])
    await desktop.reconcile()

    #expect(desktop.app?["themeChoice"] == "graphite")
    #expect(appOn(gateway)?["themeChoice"] == "graphite")
  }

  @Test func givesATieToTheGateway() async {
    let gateway = HoldingGateway()
    let desktop = UIMetaSync.device(gateway.gateway)

    await desktop.reconcile()
    desktop.setApp(["themeChoice": "graphite", "updatedAt": .number(noon)])
    await desktop.flush()

    let phone = UIMetaSync.device(gateway.gateway, app: ["v": 1, "themeChoice": "lime", "updatedAt": .number(noon)])
    phone.markApp()
    await phone.reconcile()

    #expect(phone.app?["themeChoice"] == "graphite")
    #expect(appOn(gateway)?["themeChoice"] == "graphite")
  }

  @Test func keepsAnUndatedLocalChange() async {
    let gateway = HoldingGateway()
    let desktop = UIMetaSync.device(gateway.gateway)

    await desktop.reconcile()
    desktop.setApp(["themeChoice": "graphite"])
    await desktop.flush()

    let phone = UIMetaSync.device(gateway.gateway, app: ["v": 1, "themeChoice": "lime"])
    phone.markApp()
    await phone.reconcile()

    #expect(phone.app?["themeChoice"] == "lime")
    #expect(appOn(gateway)?["themeChoice"] == "lime")
  }

  @Test func prefersADatedChoiceToAnUndatedOne() async {
    let gateway = HoldingGateway()
    let older = UIMetaSync.device(gateway.gateway)

    await older.reconcile()
    older.setApp(["themeChoice": "lime"])
    await older.flush()

    let newer = UIMetaSync.device(gateway.gateway, app: ["v": 1, "themeChoice": "graphite", "updatedAt": .number(noon)])
    newer.markApp()
    await newer.reconcile()

    #expect(newer.app?["themeChoice"] == "graphite")
    #expect(appOn(gateway)?["themeChoice"] == "graphite")
  }

  @Test func stillSeedsAGatewayThatHasNoSectionWhateverTheDates() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway, app: ["v": 1, "themeChoice": "lime", "updatedAt": .number(noon - hour)])

    await phone.reconcile()

    #expect(appOn(gateway)?["themeChoice"] == "lime")
  }

  // MARK: A gateway whose notifier cannot read the per-person key yet

  @Test func leavesTheRegistrationsOnTheBareKeyAndMovesTheRest() async {
    let gateway = HoldingGateway(capabilities: ["push.expo"])
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.setApp([
      "themeChoice": "midnight",
      "push": ["registrations": ["i-phone": ["v": 1, "transport": "expo", "token": "x"]], "seen": [:]]
    ])
    await phone.flush()

    let meta = gateway.meta("researcher")
    #expect(meta[ownerKey]?["themeChoice"] == "midnight")
    #expect(meta[ownerKey]?["push"] == nil)
    #expect(meta[UIMeta.legacyAppKey]?["push"] != nil)
  }

  @Test func readsItsOwnRegistrationsBackFromTheBareKey() async {
    let gateway = HoldingGateway(capabilities: ["push.expo"])
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.setApp(["push": ["registrations": ["i-phone": ["v": 1, "transport": "expo", "token": "x"]], "seen": [:]]])
    await phone.flush()

    let tablet = UIMetaSync.device(gateway.gateway)
    let seen = await tablet.pull()

    #expect(seen?.pushHome?["push"] != nil)
    #expect(seen?.app?["push"] == nil)
  }

  @Test func sendsBothKeysInOneRequest() async {
    let gateway = HoldingGateway(capabilities: ["push.expo"])
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.setApp(["themeChoice": "sand", "push": ["registrations": [:], "seen": [:]]])
    await phone.flush()

    #expect(!phone.pending)
    #expect(phone.mode == .synced)
    #expect(gateway.configures.count == 1)
    let keys = gateway.configures.first?["ui_meta"]?.objectValue.map { Set($0.keys) }
    #expect(keys == [ownerKey, UIMeta.legacyAppKey])
  }

  @Test func theBareKeyGoesBackAsItCameWithOnlyThePushRowsChanged() async {
    let gateway = HoldingGateway(capabilities: ["push.expo"])
    gateway.write("researcher", [UIMeta.legacyAppKey: ["v": 1, "themeChoice": "forest", "olderBuildField": [1, 2]]])

    let phone = UIMetaSync.device(gateway.gateway, user: "alice")
    await phone.reconcile()
    phone.updateApp(.chore) { $0["push"] = ["registrations": ["i-phone": ["v": 1]]] }
    await phone.flush()

    let legacy = gateway.meta("researcher")[UIMeta.legacyAppKey]
    #expect(legacy?["themeChoice"] == "forest")
    #expect(legacy?["olderBuildField"] == [1, 2])
    #expect(legacy?["push"]?["registrations"]?["i-phone"] == ["v": 1])
  }

  // MARK: Inheriting the anonymous arrangement

  private func seedLegacy(_ gateway: HoldingGateway) {
    gateway.write("researcher", [
      UIMeta.legacyAppKey: [
        "v": 1,
        "themeChoice": "midnight",
        "entries": [["kind": "chat", "name": "writer"]],
        "push": ["registrations": ["install-a": ["v": 1, "transport": "expo", "token": "x"]]],
        "context": ["users": ["someone": ["userId": "someone"]]]
      ]
    ])
  }

  @Test func copiesTheArrangementIntoTheNewKeyOnTheFirstReconcile() async {
    let gateway = HoldingGateway()
    seedLegacy(gateway)

    let phone = UIMetaSync.device(gateway.gateway, user: "alice")
    await phone.reconcile()

    #expect(phone.app?["themeChoice"] == "midnight")
    #expect(phone.app?["entries"] == [["kind": "chat", "name": "writer"]])
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "alice")] != nil)
  }

  @Test func leavesThePerDeviceAndPerPersonMapsBehind() async {
    let gateway = HoldingGateway()
    seedLegacy(gateway)

    let phone = UIMetaSync.device(gateway.gateway, user: "alice")
    await phone.reconcile()

    #expect(phone.app?["push"] == nil)
    #expect(phone.app?["context"] == nil)

    let inherited = gateway.meta("researcher")[UIMeta.appKey(for: "alice")]
    #expect(inherited?["push"] == nil)
    #expect(inherited?["context"] == nil)
  }

  @Test func copiesOnceAndNeverLooksAtTheLegacyKeyAgain() async {
    let gateway = HoldingGateway()
    seedLegacy(gateway)

    let phone = UIMetaSync.device(gateway.gateway, user: "alice")
    await phone.reconcile()
    phone.updateApp { $0["themeChoice"] = "sand" }
    await phone.flush()

    gateway.write("researcher", [UIMeta.legacyAppKey: ["v": 1, "themeChoice": "forest"]])
    await phone.reconcile()

    #expect(phone.app?["themeChoice"] == "sand")
  }

  @Test func startsAPersonWhoArrivesAfterTheCopyFromTheDefaults() async {
    let gateway = HoldingGateway()
    let alice = UIMetaSync.device(gateway.gateway, user: "alice")

    await alice.reconcile()
    alice.setApp(["themeChoice": "midnight"])
    await alice.flush()

    let bob = UIMetaSync.device(gateway.gateway, user: "bob")
    await bob.reconcile()

    #expect(bob.app == nil)
  }

  @Test func leavesTheAnonymousSectionExactlyWhereItWas() async {
    let gateway = HoldingGateway()
    seedLegacy(gateway)

    let phone = UIMetaSync.device(gateway.gateway, user: "alice")
    await phone.reconcile()
    phone.updateApp { $0["themeChoice"] = "sand" }
    await phone.flush()

    #expect(gateway.meta("researcher")[UIMeta.legacyAppKey]?["themeChoice"] == "midnight")
    #expect(gateway.meta("researcher")[UIMeta.legacyAppKey]?["push"] != nil)
  }

  // MARK: Unknown fields and foreign rows

  @Test func carriesFieldsAndRowsThisBuildDoesNotKnow() async {
    let gateway = HoldingGateway()
    let foreignRow: JSONValue = ["v": 1, "transport": "webpush", "endpoint": "e", "keys": ["p256dh": "k"]]
    let future: JSONValue = ["nested": [1, nil, ["deep": true]], "n": 1.5]

    gateway.write("researcher", [
      ownerKey: [
        "v": 1,
        "themeChoice": ["kind": "preset", "name": "lime", "tint": "#123456"],
        "fromTheFuture": future,
        "push": ["registrations": ["other-install": foreignRow], "perBot": ["writer": ["message": false]]]
      ],
      UIMeta.botKey: ["v": 1, "colour": "teal", "pattern": "stripes"]
    ])

    let phone = UIMetaSync.device(gateway.gateway)
    await phone.reconcile()

    phone.updateApp { $0["textSize"] = "large" }
    phone.updateBot("researcher") { $0["archived"] = true }
    await phone.flush()

    let app = gateway.meta("researcher")[ownerKey]
    #expect(app?["fromTheFuture"] == future)
    #expect(app?["themeChoice"] == ["kind": "preset", "name": "lime", "tint": "#123456"])
    #expect(app?["push"]?["registrations"]?["other-install"] == foreignRow)
    #expect(app?["push"]?["perBot"] == ["writer": ["message": false]])
    #expect(app?["textSize"] == "large")
    #expect(gateway.meta("researcher")[UIMeta.botKey] == ["v": 1, "colour": "teal", "pattern": "stripes", "archived": true])
  }

  @Test func aSectionWithNothingLeftIsRemovedNotEmptied() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.updateBot("writer") { $0["archived"] = true }
    await phone.flush()
    phone.updateBot("writer") { $0.removeValue(forKey: "archived") }
    await phone.flush()

    #expect(gateway.configures.last?["ui_meta"] == [UIMeta.botKey: nil])
    #expect(gateway.meta("writer")[UIMeta.botKey] == nil)
    #expect(gateway.meta("writer")[UIMeta.botMarkerKey] != nil)
  }

  // MARK: Debounce and changes

  @Test func editsWithinTheDebounceGoOutAsOneRequest() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway, debounce: .milliseconds(50))

    await phone.reconcile()

    for name in ["blue", "graphite", "lime"] {
      phone.updateApp { $0["themeChoice"] = ["kind": "preset", "name": .string(name)] }
    }

    await phone.settle()

    #expect(gateway.configures.count == 1)
    #expect(appOn(gateway)?["themeChoice"]?["name"] == "lime")
  }

  @Test func announcesEveryCopyItTakesIn() async throws {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)
    let changes = phone.changes()

    gateway.write("researcher", [ownerKey: ["v": 1, "textSize": "large"]])
    await phone.reconcile()

    var iterator = changes.makeAsyncIterator()
    let change = try #require(await iterator.next())

    #expect(change.documents.app?["textSize"] == "large")
    #expect(change.snapshot.remote?["textSize"] == "large")
  }

  // MARK: Persistence

  @Test func anOfflineChoiceSurvivesARelaunchAndLandsOnTheNextConnect() async {
    let gateway = HoldingGateway()
    let disk = MemoryPersistence()
    let clock = TestWallClock(noon)

    // A desktop chose graphite an hour ago.
    let desktop = UIMetaSync.device(gateway.gateway)
    await desktop.reconcile()
    desktop.setApp(["themeChoice": "graphite", "updatedAt": .number(noon - hour)])
    await desktop.flush()

    // The phone chooses lime with no gateway, and is then quit.
    let offline = UIMetaSync.device(HoldingGateway.unreachable, persistence: disk, clock: clock)
    await offline.load()
    offline.updateApp { $0["themeChoice"] = "lime" }
    await offline.settle()

    // Relaunched: nothing is marked any more; the date is all that is left.
    let phone = UIMetaSync.device(gateway.gateway, persistence: disk, clock: clock)
    await phone.reconcile()

    #expect(appOn(gateway)?["themeChoice"] == "lime")
    #expect(appOn(gateway)?["updatedAt"] == .number(noon))
  }

  @Test func theKeyValueStoreKeepsTheCopyPerGateway() async throws {
    let store = KeyValueStore(store: try SQLiteStore(.inMemory))
    let here = KeyValueUIMetaPersistence(store: store, namespace: GatewayNamespace("g-here"))
    let there = KeyValueUIMetaPersistence(store: store, namespace: GatewayNamespace("g-there"))
    let copy = UIMetaStoredCopy(
      documents: UIMetaDocuments(
        app: ["v": 1, "themeChoice": ["kind": "user", "id": "t1"], "n": 1.5, "updatedAt": .number(noon)],
        bots: ["writer": ["v": 1, "archived": true]]
      ),
      owner: owner,
      gateway: "g-here",
      pendingApp: true,
      pendingBots: ["writer"]
    )

    await here.save(copy)

    #expect(await here.load() == copy)
    #expect(await there.load() == nil)
  }

  // MARK: Review: an edit made while a send is out

  @Test func aBotEditMadeWhileItsWriteIsOutIsSentAfterIt() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway)

    await phone.reconcile()
    phone.updateBot("writer", .chore) { $0["archived"] = true }

    gateway.hold("profiles.configure")
    let flush = Task { await phone.flush() }
    await gateway.waitUntilHeld()

    phone.updateBot("writer") { $0["colour"] = "teal" }
    gateway.release()
    await flush.value
    await phone.settle()

    #expect(!phone.pending)
    #expect(gateway.meta("writer")[UIMeta.botKey] == ["v": 1, "archived": true, "colour": "teal"])

    // And the next reconcile does not take it back.
    await phone.reconcile()
    #expect(phone.bot("writer")?["colour"] == "teal")
  }

  @Test func anAppChoiceMadeWhileItsWriteIsOutIsSentAfterIt() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway, debounce: .zero)

    await phone.reconcile()
    gateway.hold("profiles.configure")
    phone.updateApp { $0["themeChoice"] = "lime" }
    await gateway.waitUntilHeld()

    phone.updateApp { $0["textSize"] = "large" }
    gateway.release()
    await phone.settle()

    #expect(!phone.pending)
    #expect(appOn(gateway)?["themeChoice"] == "lime")
    #expect(appOn(gateway)?["textSize"] == "large")
  }

  @Test func aReconcileDuringADebouncedRunHasItsMarkSent() async {
    let gateway = HoldingGateway()
    seedLegacy(gateway)

    let phone = UIMetaSync.device(gateway.gateway, user: "alice", debounce: .zero)

    // A debounced bot write is out ...
    gateway.hold("profiles.configure")
    phone.updateBot("writer") { $0["archived"] = true }
    await gateway.waitUntilHeld()

    // ... when the first reconcile marks the inherited section, and its flush
    // joins the run that took its outbox before that mark.
    let reconcile = Task { await phone.reconcile() }
    await uiMetaEventually("the inheritance is marked") { phone.state.dirtyApp }

    gateway.release()
    _ = await reconcile.value
    await phone.settle()

    #expect(!phone.pending)
    #expect(gateway.meta("writer")[UIMeta.botKey] == ["v": 1, "archived": true])
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "alice")]?["themeChoice"] == "midnight")
  }

  // MARK: Review: one person's copy is not another's

  @Test func anotherPersonNeverInheritsThePersistedArrangement() async {
    let gateway = HoldingGateway()
    let disk = MemoryPersistence()

    let alice = UIMetaSync.device(gateway.gateway, user: "alice", persistence: disk)
    await alice.reconcile()
    alice.updateApp { $0["labels"] = ["writer": "Her name for it"] }
    await alice.flush()
    await alice.settle()

    // Bob signs in on the same device and gateway.
    let bob = UIMetaSync.device(gateway.gateway, user: "bob", persistence: disk)
    await bob.reconcile()
    await bob.settle()

    #expect(bob.app == nil)
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "bob")] == nil)
    #expect(disk.stored.withLock { $0?.owner } == "bob")
  }

  @Test func aSwitchOfPersonOnALiveSyncDropsTheOldArrangement() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway, user: "alice")

    await phone.reconcile()
    phone.updateApp { $0["themeChoice"] = "midnight" }
    await phone.flush()

    phone.reset()
    phone.setUser("bob")
    await phone.reconcile()

    #expect(phone.app == nil)
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "bob")] == nil)
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "alice")]?["themeChoice"] == "midnight")
  }

  @Test func signOutKeepsTheBotSectionsAndDropsThePersonsOwn() {
    let phone = UIMetaSync.device(HoldingGateway.unreachable, app: ["v": 1, "themeChoice": "x"], bots: ["writer": ["v": 1, "archived": true]])
    phone.setPushRow(UIMetaPushRow(transport: "relay", handle: "h"), installation: "i-1")

    phone.reset()

    #expect(phone.app == nil)
    #expect(phone.bot("writer") == ["v": 1, "archived": true])
    #expect(!phone.pending)
  }

  // MARK: Review: in-flight work is fenced by a sign-out

  @Test(arguments: [true, false])
  func aChangeOfPersonDuringAConflictingWriteDoesNotLandTheNewArrangementUnderTheOldKey(signOut: Bool) async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway, user: "alice")

    await phone.reconcile()
    phone.updateApp { $0["themeChoice"] = "alice-theme" }

    // Another device wins the first attempt; the re-read after it is held.
    gateway.interfere(times: 1)
    gateway.hold("profiles.list")
    let flush = Task { await phone.flush() }
    await gateway.waitUntilHeld()

    // With or without a sign-out in between: a direct switch keeps the
    // revisions, so a retry that was not fenced off would land.
    if signOut {
      phone.reset()
    }
    phone.setUser("bob")
    phone.updateApp { $0["themeChoice"] = "bob-theme" }
    gateway.release()
    await flush.value
    await phone.reconcile()
    await phone.settle()

    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "alice")]?["themeChoice"] != "bob-theme")
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "bob")]?["themeChoice"] == "bob-theme")
    #expect(!phone.pending)
  }

  @Test func aSignOutDuringALandingWriteDoesNotCleanTheNextPersonsSeed() async {
    let gateway = HoldingGateway()
    let phone = UIMetaSync.device(gateway.gateway, user: "alice")

    await phone.reconcile()
    phone.updateApp { $0["themeChoice"] = "alice-theme" }

    gateway.hold("profiles.configure")
    let flush = Task { await phone.flush() }
    await gateway.waitUntilHeld()

    phone.reset()
    phone.setUser("bob")
    phone.updateApp(.baseline) { $0["textSize"] = "small" }
    let reconcile = Task { await phone.reconcile() }
    await uiMetaEventually("the seed is marked") { phone.state.dirtyApp }

    gateway.release()
    await flush.value
    _ = await reconcile.value
    await phone.settle()

    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "bob")]?["textSize"] == "small")
    #expect(!phone.pending)
  }

  // MARK: Review: removed fields, push rows and the disk

  @Test func aFieldAnotherClientRemovedStaysRemoved() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "retiredByThem": 1, "context": ["users": [:]], "updatedAt": .number(noon - hour)]])

    let phone = UIMetaSync.device(gateway.gateway)
    await phone.reconcile()
    #expect(phone.app?["retiredByThem"] == 1)
    #expect(phone.app?["context"] == nil)

    // Another client writes the section without it.
    gateway.write("researcher", [ownerKey: ["v": 1, "textSize": "large", "updatedAt": .number(noon - hour + 1)]])
    await phone.reconcile()
    phone.updateApp { $0["themeChoice"] = "lime" }
    await phone.flush()

    #expect(appOn(gateway)?["retiredByThem"] == nil)
    #expect(appOn(gateway)?["context"] == nil)
    #expect(appOn(gateway)?["textSize"] == "large")
  }

  @Test func noPushRowEverReachesTheDisk() async {
    let gateway = HoldingGateway()
    let disk = MemoryPersistence()
    gateway.write("researcher", [ownerKey: ["v": 1, "push": ["registrations": ["other": ["v": 1, "sendSecret": "their-secret"]]]]])

    let phone = UIMetaSync.device(gateway.gateway, persistence: disk)
    await phone.reconcile()
    phone.setPushRow(UIMetaPushRow(transport: "relay", handle: "h", sendSecret: "my-secret"), installation: "mine")
    await phone.flush()
    await phone.settle()

    #expect(phone.app?["push"]?["registrations"]?["other"] != nil)
    #expect(!disk.bytes.isEmpty)
    #expect(!disk.bytes.contains("secret"))
    #expect(!disk.bytes.contains("registrations"))
  }

  @Test func aPendingEditSurvivesANewSyncObject() async {
    let gateway = HoldingGateway()
    let disk = MemoryPersistence()
    gateway.write("writer", [UIMeta.botKey: ["v": 1, "colour": "teal"]])

    let offline = UIMetaSync.device(HoldingGateway.unreachable, persistence: disk)
    await offline.load()
    offline.updateBot("writer") { $0["colour"] = "lime" }
    await offline.settle()

    // The gateway already has a section for the bot, so only the stored mark
    // can say this device holds a newer one.
    let phone = UIMetaSync.device(gateway.gateway, persistence: disk)
    await phone.reconcile()

    #expect(gateway.meta("writer")[UIMeta.botKey]?["colour"] == "lime")
    #expect(!phone.pending)
  }

  // MARK: The push row seam

  @Test func aPushRowReachesItsOwnRowAndNothingElse() async {
    let gateway = HoldingGateway()
    let foreign: JSONValue = ["v": 1, "transport": "expo", "token": "t"]
    gateway.write("researcher", [ownerKey: ["v": 1, "themeChoice": "a", "push": ["registrations": ["other": foreign], "seen": ["x": 1]]]])

    let phone = UIMetaSync.device(gateway.gateway)
    await phone.reconcile()
    let before = phone.app

    phone.setPushRow(
      UIMetaPushRow(
        transport: "relay",
        relay: "https://relay.example",
        handle: "h-1",
        sendSecret: "s-1",
        carried: ["enc": ["k": "pub"], "transport": "spoofed", "v": 9]
      ),
      installation: "mine"
    )

    let after = phone.app
    #expect(UIMetaDocuments.choices(of: after) == UIMetaDocuments.choices(of: before))
    #expect(after?["updatedAt"] == before?["updatedAt"])
    #expect(after?["push"]?["seen"] == ["x": 1])
    #expect(after?["push"]?["registrations"]?["other"] == foreign)
    #expect(after?["push"]?["registrations"]?["mine"] == [
      "v": 1, "transport": "relay", "relay": "https://relay.example", "handle": "h-1", "sendSecret": "s-1", "enc": ["k": "pub"]
    ])

    // Kept across a copy taken in that does not have it yet, and sent.
    await phone.reconcile()
    #expect(appOn(gateway)?["push"]?["registrations"]?["mine"]?["handle"] == "h-1")
    #expect(appOn(gateway)?["push"]?["registrations"]?["other"] == foreign)

    phone.setPushRow(nil, installation: "mine")
    await phone.flush()
    #expect(appOn(gateway)?["push"]?["registrations"]?["mine"] == nil)
    #expect(appOn(gateway)?["push"]?["registrations"]?["other"] == foreign)
  }
}
