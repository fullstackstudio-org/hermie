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

  @Test func readsTheFieldsOffTheDevicesCopy() {
    let documents = UIMetaDocuments(
      app: [
        "v": 1,
        "archivedBots": ["scout", "", 3, "scout", "gone"],
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

    // The person's list alone: the shared flag on writer says nothing once the list exists.
    #expect(arrangement.archived == ["scout", "gone"])
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

  @Test func archiveWritesTheSortedListAndKeepsTheRest() {
    var app: JSONObject = ["v": 1, "pinned": ["writer"], "archivedBots": ["writer"]]

    ChatListArrangement.setArchived("alpha", true, current: [], in: &app)
    ChatListArrangement.setArchived("writer", true, current: [], in: &app)
    #expect(app == ["v": 1, "pinned": ["writer"], "archivedBots": ["alpha", "writer"]])

    ChatListArrangement.setArchived("writer", false, current: [], in: &app)
    #expect(app["archivedBots"] == ["alpha"])

    // An unseeded section writes what was read (the inherited names) along with the change.
    var fresh: JSONObject = ["v": 1]
    ChatListArrangement.setArchived("b", true, current: ["c", "a"], in: &fresh)
    #expect(fresh["archivedBots"] == ["a", "b", "c"])
  }

  @Test func theSeedComesFromTheSharedFlagsOnlyWhileTheFieldIsMissing() {
    let bots: [String: JSONObject] = ["writer": ["v": 1, "archived": true], "scout": ["v": 1, "archived": true],
      "researcher": ["v": 1, "colour": "red"]]
    var app: JSONObject = ["v": 1]

    #expect(ChatListArrangement.seedArchive(from: bots, in: &app))
    #expect(app["archivedBots"] == ["scout", "writer"])

    // Once there, the list is the only source, empty included.
    var emptied: JSONObject = ["v": 1, "archivedBots": []]
    #expect(!ChatListArrangement.seedArchive(from: bots, in: &emptied))
    #expect(ChatListArrangement(documents: UIMetaDocuments(app: emptied, bots: bots)).archived.isEmpty)
    // Before the seed lands, what it will be is what is shown.
    #expect(ChatListArrangement(documents: UIMetaDocuments(app: ["v": 1], bots: bots)).archived == ["scout", "writer"])
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

  /// What the web client's projection writes for the same choices: the app section's
  /// `archivedBots` (sorted names), `pinned` (names, in order) and `mutes` (name to second, 0 for
  /// never), and nothing on any bot's profile.
  @Test func theWireIsTheWebClientsShape() async {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)

    sync.updateApp(.choice) {
      ChatListArrangement.setArchived("writer", true, current: [], in: &$0)
      ChatListArrangement.setArchived("researcher", true, current: [], in: &$0)
      ChatListArrangement.setPinned("researcher", true, in: &$0)
      ChatListArrangement.setPinned("writer", true, in: &$0)
      ChatListArrangement.setMute("writer", until: MuteDuration.oneHour.until(now: noon), in: &$0)
      ChatListArrangement.setMute("researcher", until: MuteDuration.forever.until(now: noon), in: &$0)
    }
    await sync.reconcile()

    // No bot section is written.
    #expect(gateway.meta("writer")[UIMeta.botKey] == nil)

    // `projectApp`: `pinned` as `Object.keys(pinned)` (insertion order), `mutes` as the map.
    let app = gateway.meta("researcher")[ownerKey]?.objectValue
    #expect(app?["pinned"] == ["researcher", "writer"])
    #expect(app?["mutes"] == ["writer": .number(noon + 3600), "researcher": 0])
    #expect(app?["archivedBots"] == ["researcher", "writer"])
    // A choice dates the section, so it wins over an older copy on another device.
    #expect(app?["updatedAt"] == .number(noon))

    // The request itself: one per profile, only the keys that changed.
    let writes = gateway.configures.map { ($0["name"]?.stringValue ?? "", Set(($0["ui_meta"]?.objectValue ?? [:]).keys)) }
    #expect(!writes.contains { $0.1.contains(UIMeta.botKey) })
    #expect(writes.contains { $0.0 == "researcher" && $0.1.contains(ownerKey) })
  }

  /// The shared flag an older build or the Expo app wrote is left exactly as it was: archiving and
  /// unarchiving here neither sets nor clears it.
  @MainActor
  @Test func archivingNeverTouchesTheSharedFlag() async {
    let gateway = HoldingGateway()
    gateway.write("writer", [UIMeta.botKey: ["v": 1, "archived": true, "colour": "teal"]])
    let sync = UIMetaSync.device(gateway.gateway)
    let model = ChatArrangementModel(now: { noon })
    model.attach(sync)
    await sync.reconcile()
    await eventually("the inherited archive") { model.isArchived("writer") }

    model.setArchived("writer", false)
    model.setArchived("researcher", true)
    await sync.reconcile()

    #expect(gateway.meta("researcher")[ownerKey]?["archivedBots"] == ["researcher"])
    #expect(gateway.meta("writer")[UIMeta.botKey] == ["v": 1, "archived": true, "colour": "teal"])
    #expect(gateway.meta("researcher")[UIMeta.botKey] == nil)
    #expect(!model.isArchived("writer"))
  }

  @Test func whatTheWebClientWroteIsReadBack() async {
    // A section as the web client's `takeApp` leaves it, `archivedBots` included.
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: [
      "v": 1,
      "updatedAt": .number(noon),
      "archivedBots": ["writer"],
      "entries": [],
      "pinned": ["writer"],
      "mutes": ["researcher": .number(noon + 8 * hour)],
      "textSize": "large"
    ]])
    gateway.write("writer", [UIMeta.botKey: ["v": 1, "colour": "teal"]])

    let sync = UIMetaSync.device(gateway.gateway)
    await sync.reconcile()

    let arrangement = ChatListArrangement(documents: sync.documents)
    #expect(arrangement == ChatListArrangement(
      archived: ["writer"],
      pinned: ["writer"],
      mutes: ["researcher": noon + 8 * hour],
      accents: ["writer": .teal]
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
    // A bot the arrangement does not place yet comes at the end of the loose run before the first
    // folder, in roster order: where a move or the fold writes it.
    #expect(arrangement.looseHead == 1)
    #expect(arrangement.ordered(["a", "new2", "b", "c", "new1", "d", "e"]) { $0 } == ["c", "new2", "new1", "d", "b", "a", "e"])
    #expect(arrangement.folderOf == ["d": "f1", "b": "f1", "e": "f2"])
    #expect(arrangement.sameContainer("d", "b") && !arrangement.sameContainer("d", "c") && arrangement.sameContainer("c", "new1"))
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

    // A move never drops a name: with the roster painted from the cache, a bot made on the web and
    // put in "Werk" is unknown here, and stays in its folder.
    app["entries"] = [["kind": "chat", "name": "a"], ["kind": "chat", "name": "b"], ["kind": "folder", "id": "werk"]]
    app["folders"] = [["id": "werk", "name": "Werk", "bots": ["x", "made-on-the-web"]]]
    #expect(ChatListArrangement.move("b", to: .before("a"), roster: ["a", "b", "x"], in: &app))
    #expect(app["entries"] == [["kind": "chat", "name": "b"], ["kind": "chat", "name": "a"], ["kind": "folder", "id": "werk"]])
    #expect(app["folders"] == [["id": "werk", "name": "Werk", "bots": ["x", "made-on-the-web"]]])

    // Out of a folder is not a step this build takes.
    let held = app
    #expect(!ChatListArrangement.move("x", to: .before("a"), roster: [], in: &app))
    #expect(app == held)
  }

  /// The fold (`reconcileBots`): only with a roster the gateway answered, and it drops what is
  /// gone, keeps every folder's other fields, and places new bots before the first folder.
  @Test func theFoldDropsWhatIsGoneAndPlacesWhatIsNew() {
    var app: JSONObject = [
      "v": 1,
      "entries": [["kind": "chat", "name": "gone"], ["kind": "chat", "name": "a"], ["kind": "folder", "id": "werk"]],
      "folders": [["id": "werk", "name": "Werk", "colour": "teal", "bots": ["x", "old"]]]
    ]

    #expect(ChatListArrangement.reconcile(roster: ["a", "x", "new"], in: &app))
    #expect(app["entries"] == [["kind": "chat", "name": "a"], ["kind": "chat", "name": "new"], ["kind": "folder", "id": "werk"]])
    #expect(app["folders"] == [["id": "werk", "name": "Werk", "colour": "teal", "bots": ["x"]]])

    // Nothing to fold: nothing written. An empty roster folds nothing.
    let held = app
    #expect(!ChatListArrangement.reconcile(roster: ["a", "x", "new"], in: &app))
    #expect(!ChatListArrangement.reconcile(roster: [], in: &app))
    #expect(app == held)
  }

  /// The fold runs only on a roster the gateway answered, as a chore: against the gateway's own
  /// (undated) arrangement it is not what lands, and it is redone on top of what was taken.
  @MainActor
  @Test func theFoldOfAFreshRosterIsAChoreOnTopOfTheGateway() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: [
      "v": 1,
      "entries": [["kind": "folder", "id": "werk"], ["kind": "chat", "name": "gone"]],
      "folders": [["id": "werk", "name": "Werk", "bots": ["writer"]]]
    ]])
    let sync = UIMetaSync.device(gateway.gateway)
    let model = ChatArrangementModel(now: { noon })
    model.attach(sync)
    // The attach has read the stored copy once the archive seed has landed (the seed and the fold
    // both wait for that read); only a roster answered after it folds on its own.
    await eventually("the attach's first read") { sync.app?["archivedBots"] != nil }

    model.rosterRefreshed(["researcher", "writer"])
    #expect(sync.state.dirtyApp && !sync.state.appChoice)

    await sync.reconcile()
    await eventually("the fold on top of the gateway's copy") { model.arrangement.folderOf["writer"] == "werk" }
    // The fold, redone on the copy taken in: gone dropped, researcher placed before the folder,
    // writer left in Werk.
    #expect(sync.app?["entries"] == [["kind": "chat", "name": "researcher"], ["kind": "folder", "id": "werk"]])
    #expect(sync.app?["folders"] == [["id": "werk", "name": "Werk", "bots": ["writer"]]])
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

  /// Two people archive independently: each list is in their own section, and neither person's
  /// archive hides a chat from the other.
  @MainActor
  @Test func twoPeopleOnOneGatewayHaveTheirOwnArchive() async {
    let gateway = HoldingGateway()
    let anneSync = UIMetaSync.device(gateway.gateway, user: "anne")
    let bobSync = UIMetaSync.device(gateway.gateway, user: "bob@example.com")
    let anne = ChatArrangementModel(now: { noon })
    let bob = ChatArrangementModel(now: { noon })
    anne.attach(anneSync)
    bob.attach(bobSync)

    anne.setArchived("writer", true)
    await anneSync.reconcile()
    bob.setArchived("researcher", true)
    await bobSync.reconcile()
    await anneSync.reconcile()
    await bobSync.reconcile()

    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "anne")]?["archivedBots"] == ["writer"])
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "bob@example.com")]?["archivedBots"] == ["researcher"])
    #expect(gateway.meta("writer")[UIMeta.botKey] == nil)

    #expect(anne.isArchived("writer") && !anne.isArchived("researcher"))
    #expect(bob.isArchived("researcher") && !bob.isArchived("writer"))

    // Anne unarchives; Bob's archive does not move.
    anne.setArchived("writer", false)
    await anneSync.reconcile()
    await bobSync.reconcile()
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "bob@example.com")]?["archivedBots"] == ["researcher"])
    #expect(!anne.isArchived("writer"))
  }

  /// The one-time inheritance: a person whose section has no `archivedBots` starts from the shared
  /// flags; once their list exists it is the only source, and a flag set later by somebody else
  /// (the Expo app) does not reach it.
  @MainActor
  @Test func aPersonsArchiveIsSeededOnceFromTheSharedFlags() async {
    let gateway = HoldingGateway()
    gateway.write("writer", [UIMeta.botKey: ["v": 1, "archived": true]])
    let sync = UIMetaSync.device(gateway.gateway, user: "anne")
    let model = ChatArrangementModel(now: { noon })
    model.attach(sync)

    await sync.reconcile()
    await eventually("the seed") { model.isArchived("writer") }
    #expect(sync.app?["archivedBots"] == ["writer"])
    // The gateway had no section for Anne: the seed is what it takes.
    await sync.reconcile()
    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "anne")]?["archivedBots"] == ["writer"])

    // Later the Expo app archives researcher with the shared flag: Anne's list does not follow.
    // The colour rides in the same section as the shared flag, so the model showing it says the
    // change was taken in and the rows were redrawn from it.
    gateway.write("researcher", [UIMeta.botKey: ["v": 1, "archived": true, "colour": "teal"]])
    await sync.reconcile()
    await eventually("the model to follow the gateway's copy") { model.accent("researcher") == .teal }
    #expect(!model.isArchived("researcher"))
    #expect(sync.app?["archivedBots"] == ["writer"])
  }

  /// The seed is a chore: against a section the gateway already holds (another device's, dated),
  /// it is not what lands, and the person's list there wins.
  @MainActor
  @Test func theSeedNeverBeatsTheGatewaysArchive() async {
    let gateway = HoldingGateway()
    gateway.write("writer", [UIMeta.botKey: ["v": 1, "archived": true]])
    gateway.write("researcher", [UIMeta.appKey(for: "anne"): ["v": 1, "updatedAt": .number(noon), "archivedBots": []]])
    let sync = UIMetaSync.device(gateway.gateway, user: "anne")
    let model = ChatArrangementModel(now: { noon })
    model.attach(sync)
    // The attach has read the stored copy once the archive seed has landed.
    await eventually("the attach's first read") { sync.app?["archivedBots"] != nil }

    await sync.reconcile()
    await sync.reconcile()

    #expect(gateway.meta("researcher")[UIMeta.appKey(for: "anne")]?["archivedBots"] == [])
    await eventually("the gateway's empty archive") { !model.isArchived("writer") }
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
