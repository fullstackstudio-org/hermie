import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The chat list's archive, pins and mutes in `ui_meta`: what is read off a section, what an edit
/// writes, what reaches the gateway, and that the bytes are the web client's
/// (`projectApp` / `projectBots` / `applyToStores` in `native/web/src/core/ui-meta-bridge.ts`,
/// `setArchived` / `setPinned` / `setMute` in `native/web/src/state/layout.ts`).
@Suite(.timeLimit(.minutes(1))) struct UIMetaChatListTests {
  // MARK: Reading

  @Test func readsTheThreeFieldsOffTheDevicesCopy() {
    let documents = UIMetaDocuments(
      app: [
        "v": 1,
        "pinned": ["writer", "", 7, "writer", "researcher"],
        "mutes": ["writer": 1_789_953_600.9, "researcher": 0, "bad": "soon", "negative": -1, "": 5]
      ],
      bots: [
        "writer": ["v": 1, "archived": true, "colour": "teal"],
        "researcher": ["v": 1, "colour": "red"],
        "scout": ["v": 1, "archived": "yes"]
      ]
    )

    let arrangement = ChatListArrangement(documents: documents)

    #expect(arrangement.archived == ["writer"])
    // Non-strings, empty names and repeats are not pins (the web's `names`).
    #expect(arrangement.pinned == ["writer", "researcher"])
    // Finite, non-negative, floored (`mutesOf`).
    #expect(arrangement.mutes == ["writer": 1_789_953_600, "researcher": 0])
  }

  @Test func aMuteIsADeadlineAndZeroIsForever() {
    let arrangement = ChatListArrangement(mutes: ["writer": noon + hour, "researcher": 0])

    #expect(arrangement.isMuted("writer", now: noon))
    #expect(arrangement.mutedUntil("writer", now: noon) == noon + hour)
    #expect(!arrangement.isMuted("writer", now: noon + hour))
    #expect(arrangement.isMuted("researcher", now: noon + 1_000 * hour))
    #expect(arrangement.mutedUntil("researcher", now: noon) == 0)
    #expect(!arrangement.isMuted("scout", now: noon))
    #expect(arrangement.nextLapse(after: noon) == noon + hour)
    #expect(arrangement.nextLapse(after: noon + hour) == nil)
  }

  @Test func theDurationsAreTheWebsSpans() {
    #expect(MuteDuration.allCases.map(\.rawValue) == ["1h", "8h", "1w", "forever"])
    #expect(MuteDuration.oneHour.until(now: noon + 0.7) == noon + 3600)
    #expect(MuteDuration.eightHours.until(now: noon) == noon + 8 * 3600)
    #expect(MuteDuration.oneWeek.until(now: noon) == noon + 7 * 86_400)
    #expect(MuteDuration.forever.until(now: noon) == 0)
  }

  @Test func pinnedChatsComeFirstAndKeepTheirOrder() {
    let arrangement = ChatListArrangement(pinned: ["d", "b"])

    #expect(arrangement.pinnedFirst(["a", "b", "c", "d"]) { $0 } == ["b", "d", "a", "c"])
  }

  // MARK: Writing, field by field

  @Test func archiveSetsTheFlagAndUnarchiveRemovesItKeepingTheRest() {
    var section: JSONObject = ["v": 1, "colour": "teal", "future": ["x": 1]]

    ChatListArrangement.setArchived(true, in: &section)
    #expect(section == ["v": 1, "colour": "teal", "future": ["x": 1], "archived": true])

    ChatListArrangement.setArchived(false, in: &section)
    #expect(section == ["v": 1, "colour": "teal", "future": ["x": 1]])
  }

  @Test func pinsAppendInTheOrderChosenAndUnpinRemoves() {
    var app: JSONObject = ["v": 1, "entries": [["kind": "bot", "name": "writer"]]]

    ChatListArrangement.setPinned("writer", true, in: &app)
    ChatListArrangement.setPinned("researcher", true, in: &app)
    ChatListArrangement.setPinned("writer", true, in: &app)
    #expect(app["pinned"] == ["writer", "researcher"])

    ChatListArrangement.setPinned("writer", false, in: &app)
    #expect(app["pinned"] == ["researcher"])
    // Everything else in the section is carried.
    #expect(app["entries"] == [["kind": "bot", "name": "writer"]])
  }

  @Test func mutesAreWholeSecondsZeroForNeverAndUnmuteRemoves() {
    var app: JSONObject = ["v": 1, "mutes": ["scout": 5]]

    ChatListArrangement.setMute("writer", until: noon + hour + 0.9, in: &app)
    ChatListArrangement.setMute("researcher", until: 0, in: &app)
    #expect(app["mutes"] == ["scout": 5, "writer": .number(noon + hour), "researcher": 0])

    ChatListArrangement.setMute("writer", until: nil, in: &app)
    #expect(app["mutes"] == ["scout": 5, "researcher": 0])
  }

  @Test func theSweepDropsOnlyLapsedMutesAndTouchesNothingWhenNoneLapsed() {
    var app: JSONObject = ["v": 1, "mutes": ["old": .number(noon - 1), "live": .number(noon + hour), "ever": 0, "junk": "x"]]

    ChatListArrangement.dropExpiredMutes(now: noon, in: &app)
    #expect(app["mutes"] == ["live": .number(noon + hour), "ever": 0])

    let swept = app
    ChatListArrangement.dropExpiredMutes(now: noon, in: &app)
    #expect(app == swept)
  }

  // MARK: The wire

  /// What the web client's projection writes for the same choices: the bot section of an archived
  /// chat, and the app section's `pinned` (names, in order) and `mutes` (name to second, 0 for never).
  @Test func theWireIsTheWebClientsShape() async {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)

    sync.updateBot("writer", .choice) { ChatListArrangement.setArchived(true, in: &$0) }
    sync.updateApp(.choice) {
      ChatListArrangement.setPinned("researcher", true, in: &$0)
      ChatListArrangement.setPinned("writer", true, in: &$0)
      ChatListArrangement.setMute("writer", until: MuteDuration.oneHour.until(now: noon), in: &$0)
      ChatListArrangement.setMute("researcher", until: MuteDuration.forever.until(now: noon), in: &$0)
    }
    await sync.reconcile()

    // `projectBots`: `{ archived: true }`, versioned.
    #expect(gateway.meta("writer")[UIMeta.botKey] == ["v": 1, "archived": true])

    // `projectApp`: `pinned` as `Object.keys(pinned)` (insertion order), `mutes` as the map.
    let app = gateway.meta("researcher")[ownerKey]?.objectValue
    #expect(app?["pinned"] == ["researcher", "writer"])
    #expect(app?["mutes"] == ["writer": .number(noon + 3600), "researcher": 0])
    // A choice dates the section, so it wins over an older copy on another device.
    #expect(app?["updatedAt"] == .number(noon))

    // The request itself: one per profile, only the keys that changed.
    let writes = gateway.configures.map { ($0["name"]?.stringValue ?? "", Set(($0["ui_meta"]?.objectValue ?? [:]).keys)) }
    #expect(writes.contains { $0.0 == "writer" && $0.1 == [UIMeta.botKey] })
    #expect(writes.contains { $0.0 == "researcher" && $0.1.contains(ownerKey) })
  }

  @Test func unarchivingRemovesTheSectionOnTheGateway() async {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)

    sync.updateBot("writer", .choice) { ChatListArrangement.setArchived(true, in: &$0) }
    await sync.reconcile()
    #expect(gateway.meta("writer")[UIMeta.botKey] != nil)

    sync.updateBot("writer", .choice) { ChatListArrangement.setArchived(false, in: &$0) }
    await sync.flush()

    // Sent as `null`, which removes the key; the other tool's marker stays.
    #expect(gateway.configures.last?["ui_meta"] == [UIMeta.botKey: .null])
    #expect(gateway.meta("writer")[UIMeta.botKey] == nil)
    #expect(gateway.meta("writer")[UIMeta.botMarkerKey] != nil)
  }

  @Test func whatTheWebClientWroteIsReadBack() async {
    // A section as the web client's `takeApp` / `projectBots` leave it.
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: [
      "v": 1,
      "updatedAt": .number(noon),
      "entries": [],
      "pinned": ["writer"],
      "mutes": ["researcher": .number(noon + 8 * hour)],
      "textSize": "large"
    ]])
    gateway.write("writer", [UIMeta.botKey: ["v": 1, "archived": true, "colour": "teal"]])

    let sync = UIMetaSync.device(gateway.gateway)
    await sync.reconcile()

    let arrangement = ChatListArrangement(documents: sync.documents)
    #expect(arrangement == ChatListArrangement(
      archived: ["writer"],
      pinned: ["writer"],
      mutes: ["researcher": noon + 8 * hour]
    ))
  }

  // MARK: Round trip, two devices

  @MainActor
  @Test func aChoiceOnOneDeviceReachesTheOther() async {
    let gateway = HoldingGateway()
    let phoneSync = UIMetaSync.device(gateway.gateway)
    let macSync = UIMetaSync.device(gateway.gateway)
    let phone = ChatArrangementModel(now: { noon })
    let mac = ChatArrangementModel(now: { noon })

    #expect(!phone.canEdit)
    phone.attach(phoneSync)
    mac.attach(macSync)
    #expect(phone.canEdit)

    phone.setArchived("writer", true)
    phone.setPinned("researcher", true)
    phone.mute("researcher", for: .eightHours)

    // The phone's own rows change at once, before anything is sent.
    #expect(phone.isArchived("writer"))
    #expect(phone.isPinned("researcher"))
    #expect(phone.mutedUntil("researcher") == noon + 8 * hour)
    #expect(phoneSync.pending)

    await phoneSync.reconcile()
    #expect(!phoneSync.pending)

    await macSync.reconcile()
    await eventually("the Mac's rows to follow") { mac.isArchived("writer") }
    #expect(mac.arrangement == phone.arrangement)

    // And back: the Mac unarchives, unpins and unmutes.
    mac.setArchived("writer", false)
    mac.setPinned("researcher", false)
    mac.setMute("researcher", until: nil)
    await macSync.reconcile()
    await phoneSync.reconcile()
    await eventually("the phone's rows to follow") { !phone.isArchived("writer") }
    #expect(phone.arrangement == ChatListArrangement())
    #expect(gateway.meta("writer")[UIMeta.botKey] == nil)
  }

  /// Until `condition` holds on the main actor, where the model lives.
  @MainActor
  private func eventually(_ what: String, _ condition: () -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(5)

    while !condition() {
      guard ContinuousClock.now < deadline else {
        Issue.record("Timed out waiting for \(what)")
        return
      }

      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  @MainActor
  @Test func aDetachedModelWritesNothing() async {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)
    let model = ChatArrangementModel(now: { noon })

    model.attach(sync)
    model.detach(sync)
    model.setArchived("writer", true)

    #expect(!model.canEdit)
    #expect(!sync.pending)
    #expect(sync.bot("writer") == nil)
  }

  // MARK: The order

  @Test func theOrderIsTheEntriesWithAFoldersChatsInItsPlace() {
    let app: JSONObject = [
      "v": 1,
      "entries": [
        ["kind": "chat", "name": "c"],
        ["kind": "folder", "id": "f1"],
        ["kind": "chat", "name": "a"],
        ["kind": "chat", "name": "c"],
        ["kind": "something-new", "name": "x"]
      ],
      "folders": [["id": "f1", "name": "Work", "bots": ["d", "b"]], ["id": "f2", "name": "Loose", "bots": ["e"]]]
    ]

    let arrangement = ChatListArrangement(documents: UIMetaDocuments(app: app))
    // Repeats dropped, unknown kinds skipped, an unplaced folder's bots after the rest.
    #expect(arrangement.order == ["c", "d", "b", "a", "e"])
    // A bot the arrangement does not place yet comes last, in roster order.
    #expect(arrangement.ordered(["a", "new2", "b", "c", "new1", "d", "e"]) { $0 } == ["c", "d", "b", "a", "e", "new2", "new1"])
    // Nobody ordered anything: the roster's order.
    #expect(ChatListArrangement().ordered(["z", "y"]) { $0 } == ["z", "y"])
  }

  @Test func aMoveFoldsTheRosterInAndWritesTheEntriesAsTheWebDoes() {
    var app: JSONObject = ["v": 1, "pinned": ["b"]]

    // Nothing ordered yet: the roster is folded in, then the move is made.
    #expect(ChatListArrangement.move("c", to: .before("a"), roster: ["a", "b", "c"], in: &app))
    #expect(app["entries"] == [
      ["kind": "chat", "name": "c"], ["kind": "chat", "name": "a"], ["kind": "chat", "name": "b"]
    ])
    #expect(app["pinned"] == ["b"])

    // After, and onto itself (nothing).
    #expect(ChatListArrangement.move("c", to: .after("b"), roster: ["a", "b", "c"], in: &app))
    #expect(ChatListArrangement.botsInOrder(app) == ["a", "b", "c"])
    #expect(!ChatListArrangement.move("c", to: .before("c"), roster: ["a", "b", "c"], in: &app))

    // A new bot lands at the end of the loose run, before the first folder.
    app["entries"] = [["kind": "chat", "name": "a"], ["kind": "folder", "id": "f1"], ["kind": "chat", "name": "b"]]
    app["folders"] = [["id": "f1", "name": "Work", "colour": "teal", "bots": ["x", "y"]]]
    #expect(ChatListArrangement.move("b", to: .before("a"), roster: ["a", "b", "x", "y", "new"], in: &app))
    #expect(app["entries"] == [
      ["kind": "chat", "name": "b"], ["kind": "chat", "name": "a"], ["kind": "chat", "name": "new"],
      ["kind": "folder", "id": "f1"]
    ])

    // Within a folder: its bots, the folder's other fields carried.
    #expect(ChatListArrangement.move("y", to: .before("x"), roster: [], in: &app))
    #expect(app["folders"] == [["id": "f1", "name": "Work", "colour": "teal", "bots": ["y", "x"]]])

    // Out of a folder is not a step this build takes.
    let held = app
    #expect(!ChatListArrangement.move("x", to: .before("a"), roster: [], in: &app))
    #expect(app == held)
  }

  @Test func aDropIsAnAnchorWithinTheGroup() {
    let names = ["p1", "p2", "a", "b", "c"]

    #expect(ChatListArrangement.Anchor.forDrop(names, group: 0..<2, at: 0) == .before("p1"))
    #expect(ChatListArrangement.Anchor.forDrop(names, group: 0..<2, at: 2) == .after("p2"))
    #expect(ChatListArrangement.Anchor.forDrop(names, group: 2..<5, at: 3) == .before("b"))
    #expect(ChatListArrangement.Anchor.forDrop(names, group: 2..<5, at: 5) == .after("c"))
    #expect(ChatListArrangement.Anchor.forDrop(names, group: 2..<2, at: 2) == nil)
  }

  @MainActor
  @Test func aMoveSyncsToTheOtherDevice() async {
    let gateway = HoldingGateway()
    let phoneSync = UIMetaSync.device(gateway.gateway)
    let macSync = UIMetaSync.device(gateway.gateway)
    let phone = ChatArrangementModel(now: { noon })
    let mac = ChatArrangementModel(now: { noon })
    phone.attach(phoneSync)
    mac.attach(macSync)

    phone.move("writer", to: .before("researcher"), roster: ["researcher", "writer"])
    await phoneSync.reconcile()
    await macSync.reconcile()
    await eventually("the Mac's order to follow") { mac.arrangement.order == ["writer", "researcher"] }

    #expect(gateway.meta("researcher")[ownerKey]?["entries"] == [
      ["kind": "chat", "name": "writer"], ["kind": "chat", "name": "researcher"]
    ])
  }

  // MARK: Per person

  /// Two people signed in to one gateway: each has their own `hermie-app:<user id>`, and neither
  /// sees nor overwrites the other's pins, mutes or order.
  @MainActor
  @Test func twoPeopleOnOneGatewayKeepTheirOwnArrangement() async {
    let gateway = HoldingGateway()
    let anneSync = UIMetaSync.device(gateway.gateway, user: "anne")
    let bobSync = UIMetaSync.device(gateway.gateway, user: "bob@example.com")
    let anne = ChatArrangementModel(now: { noon })
    let bob = ChatArrangementModel(now: { noon })
    anne.attach(anneSync)
    bob.attach(bobSync)

    anne.setPinned("writer", true)
    anne.mute("researcher", for: .forever)
    anne.move("writer", to: .before("researcher"), roster: ["researcher", "writer"])
    await anneSync.reconcile()

    bob.setPinned("researcher", true)
    await bobSync.reconcile()
    await anneSync.reconcile()

    let anneApp = gateway.meta("researcher")[UIMeta.appKey(for: "anne")]?.objectValue
    let bobApp = gateway.meta("researcher")[UIMeta.appKey(for: "bob@example.com")]?.objectValue

    #expect(anneApp?["pinned"] == ["writer"])
    #expect(anneApp?["mutes"] == ["researcher": 0])
    #expect(bobApp?["pinned"] == ["researcher"])
    #expect(bobApp?["mutes"] == nil)
    #expect(bobApp?["entries"] == nil)

    #expect(anne.arrangement.pinned == ["writer"])
    #expect(anne.arrangement.order == ["writer", "researcher"])
    #expect(bob.arrangement.pinned == ["researcher"])
    #expect(bob.arrangement.order.isEmpty)
    #expect(!bob.isMuted("researcher"))
  }

  /// A person with no key of their own inherits the anonymous `hermie-app` once, and then writes
  /// under their own name; the anonymous section is not written by that choice.
  @MainActor
  @Test func aNewPersonInheritsTheSharedArrangementOnce() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [UIMeta.legacyAppKey: [
      "v": 1, "updatedAt": .number(noon - hour), "pinned": ["writer"],
      "entries": [["kind": "chat", "name": "writer"], ["kind": "chat", "name": "researcher"]]
    ]])

    let sync = UIMetaSync.device(gateway.gateway, user: "anne")
    let model = ChatArrangementModel(now: { noon })
    model.attach(sync)
    await sync.reconcile()
    await eventually("the inherited arrangement") { model.isPinned("writer") }

    #expect(model.arrangement.order == ["writer", "researcher"])
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "anne")]?["pinned"] == ["writer"])

    model.setPinned("researcher", true)
    await sync.reconcile()

    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "anne")]?["pinned"] == ["writer", "researcher"])
    #expect(gateway.meta("researcher")[UIMeta.legacyAppKey]?["pinned"] == ["writer"])
  }
}
