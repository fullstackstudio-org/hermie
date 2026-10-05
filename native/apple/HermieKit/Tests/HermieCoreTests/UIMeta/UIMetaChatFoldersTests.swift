import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The chat list's folders: what is read off the app section, the edits that write it back (the web
/// client's `state/folders.ts`), what the list draws from it, and the closed folders kept on the
/// device.
///
/// The time limit is a safety net, not a budget: these tests live on the main actor, which the UI
/// suites in the same process keep busy for as long as a loaded runner takes to lay their windows out.
@Suite(.timeLimit(.minutes(5))) struct UIMetaChatFoldersTests {
  /// a, F(x, y), b, G(z): loose chats on both sides of a folder.
  private func section() -> JSONObject {
    [
      "v": 1,
      "entries": [
        ["kind": "chat", "name": "a"], ["kind": "folder", "id": "f"], ["kind": "chat", "name": "b"],
        ["kind": "folder", "id": "g"]
      ],
      "folders": [
        ["id": "f", "name": "Work", "colour": "teal", "bots": ["x", "y"], "pinnedByAnotherBuild": true],
        ["id": "g", "name": "Home", "bots": ["z"]]
      ]
    ]
  }

  private let roster = ["a", "b", "x", "y", "z"]

  // MARK: Reading

  @Test func readsTheFoldersAndKeepsAChatInOnePlace() {
    let app: JSONObject = [
      "entries": [
        ["kind": "chat", "name": "a"], ["kind": "chat", "name": "a"], ["kind": "chat", "name": ""],
        ["kind": "folder", "id": "f"], ["kind": "folder", "id": "f"], ["kind": "folder", "id": "missing"],
        ["kind": "divider", "id": "d"], "junk", ["kind": "chat", "name": "b"]
      ],
      "folders": [
        ["id": "f", "name": "Work", "colour": "teal", "bots": ["a", "x", "x", "", 4, "b"]],
        ["id": "f", "name": "Duplicate", "bots": ["q"]],
        ["id": "g", "name": "Never placed", "colour": "nonsense", "bots": ["y"]],
        ["name": "No id"]
      ]
    ]

    let layout = ChatLayout(app: app)

    // First place wins: `a` and `b` are loose, so the folder keeps `x` once; a repeated or missing
    // folder id is dropped, a defined folder nobody placed is appended, an unknown kind stays.
    #expect(layout.entries == [
      .chat("a"), .folder("f"), .other(["kind": "divider", "id": "d"]), .chat("b"), .folder("g")
    ])
    #expect(layout.folders == [
      ChatFolder(id: "f", name: "Work", colour: .teal, bots: ["x"]),
      ChatFolder(id: "g", name: "Never placed", colour: .default, bots: ["y"])
    ])
    #expect(layout.placed == ["a", "x", "b", "y"])
    #expect(layout.folderID(of: "x") == "f")
    #expect(layout.folderID(of: "a") == nil)
  }

  @Test func theArrangementCarriesTheLayout() {
    let arrangement = ChatListArrangement(documents: UIMetaDocuments(app: section(), bots: [:]))

    #expect(arrangement.layout.folders.map(\.name) == ["Work", "Home"])
    #expect(arrangement.layout.folder("f")?.colour == .teal)
  }

  // MARK: Writing

  @Test func aNewFolderIsAtTheEndAndTakesTheChatWithIt() {
    var app = section()

    #expect(ChatListArrangement.addFolder(id: "n", name: "New", containing: "a", roster: roster, in: &app))
    #expect(app["entries"] == [
      ["kind": "folder", "id": "f"], ["kind": "chat", "name": "b"], ["kind": "folder", "id": "g"],
      ["kind": "folder", "id": "n"]
    ])
    #expect(app["folders"]?.arrayValue?.last == ["id": "n", "name": "New", "bots": ["a"]])

    // The same id again changes nothing.
    let held = app
    #expect(!ChatListArrangement.addFolder(id: "n", name: "Again", in: &app))
    #expect(app == held)
  }

  @Test func renameAndColourKeepWhatThisBuildDoesNotKnow() {
    var app = section()

    #expect(ChatListArrangement.renameFolder("f", to: "Office", in: &app))
    #expect(ChatListArrangement.setFolderColour("f", to: .violet, in: &app))
    #expect(app["folders"]?.arrayValue?.first == [
      "id": "f", "name": "Office", "colour": "violet", "bots": ["x", "y"], "pinnedByAnotherBuild": true
    ])

    // The default colour is the absence of a choice: it is never stored.
    #expect(ChatListArrangement.setFolderColour("f", to: .default, in: &app))
    #expect(app["folders"]?.arrayValue?.first?["colour"] == nil)

    // A folder that is not there changes nothing.
    let held = app
    #expect(!ChatListArrangement.renameFolder("nope", to: "x", in: &app))
    #expect(!ChatListArrangement.setFolderColour("nope", to: .red, in: &app))
    #expect(app == held)
  }

  @Test func deletingAFolderKeepsEveryChatWhereTheFolderWas() {
    var app = section()

    #expect(ChatListArrangement.removeFolder("f", in: &app))
    #expect(app["entries"] == [
      ["kind": "chat", "name": "a"], ["kind": "chat", "name": "x"], ["kind": "chat", "name": "y"],
      ["kind": "chat", "name": "b"], ["kind": "folder", "id": "g"]
    ])
    #expect(app["folders"] == [["id": "g", "name": "Home", "bots": ["z"]]])
    #expect(ChatLayout(app: app).placed == ["a", "x", "y", "b", "z"])

    // The last folder: the field is kept, as an empty list.
    #expect(ChatListArrangement.removeFolder("g", in: &app))
    #expect(app["folders"] == [])
    #expect(!ChatListArrangement.removeFolder("g", in: &app))
  }

  @Test func aChatMovesIntoAFolderAndOutBelowIt() {
    var app = section()

    // Into a folder: at its end, from the top level.
    #expect(ChatListArrangement.move("a", toFolder: "f", roster: roster, in: &app))
    #expect(ChatLayout(app: app).folder("f")?.bots == ["x", "y", "a"])
    #expect(ChatLayout(app: app).entries == [.folder("f"), .chat("b"), .folder("g")])

    // From one folder to another.
    #expect(ChatListArrangement.move("x", toFolder: "g", roster: roster, in: &app))
    #expect(ChatLayout(app: app).folder("f")?.bots == ["y", "a"])
    #expect(ChatLayout(app: app).folder("g")?.bots == ["z", "x"])

    // Out of any folder: loose, right below the folder it left.
    #expect(ChatListArrangement.move("y", toFolder: nil, roster: roster, in: &app))
    #expect(ChatLayout(app: app).entries == [.folder("f"), .chat("y"), .chat("b"), .folder("g")])
    #expect(ChatLayout(app: app).folder("f")?.bots == ["a"])

    // Nothing to do: already there, loose to loose, a folder that does not exist, a chat nobody has.
    let held = app
    #expect(!ChatListArrangement.move("a", toFolder: "f", roster: roster, in: &app))
    #expect(!ChatListArrangement.move("b", toFolder: nil, roster: roster, in: &app))
    #expect(!ChatListArrangement.move("b", toFolder: "missing", roster: roster, in: &app))
    #expect(!ChatListArrangement.move("ghost", toFolder: "f", roster: roster, in: &app))
    #expect(app == held)
  }

  @Test func aChatTheArrangementDoesNotPlaceYetIsFoldedInBeforeItMoves() {
    var app: JSONObject = [
      "v": 1,
      "entries": [["kind": "chat", "name": "a"], ["kind": "folder", "id": "f"]],
      "folders": [["id": "f", "name": "Work", "bots": []]]
    ]

    // `new` is on the gateway and not in the section yet: placed before the folder, then moved in.
    #expect(ChatListArrangement.move("new", toFolder: "f", roster: ["a", "new"], in: &app))
    #expect(ChatLayout(app: app).entries == [.chat("a"), .folder("f")])
    #expect(ChatLayout(app: app).folder("f")?.bots == ["new"])

    // A move that turns out to be nothing writes nothing, not even the fold.
    var untouched: JSONObject = ["v": 1, "entries": [["kind": "chat", "name": "a"]]]
    #expect(!ChatListArrangement.move("a", toFolder: nil, roster: ["a", "new"], in: &untouched))
    #expect(untouched["entries"] == [["kind": "chat", "name": "a"]])
  }

  @Test func aDropPlacesAChatNextToAnotherInTheOthersContainer() {
    var app = section()

    // Within a folder, and across containers in both directions.
    #expect(ChatListArrangement.place("y", at: .before("x"), roster: roster, in: &app))
    #expect(ChatLayout(app: app).folder("f")?.bots == ["y", "x"])

    #expect(ChatListArrangement.place("a", at: .after("y"), roster: roster, in: &app))
    #expect(ChatLayout(app: app).folder("f")?.bots == ["y", "a", "x"])
    #expect(ChatLayout(app: app).entries == [.folder("f"), .chat("b"), .folder("g")])

    #expect(ChatListArrangement.place("x", at: .before("b"), roster: roster, in: &app))
    #expect(ChatLayout(app: app).entries == [.folder("f"), .chat("x"), .chat("b"), .folder("g")])

    // Itself, and a chat nobody has: nothing.
    let held = app
    #expect(!ChatListArrangement.place("b", at: .after("b"), roster: roster, in: &app))
    #expect(!ChatListArrangement.place("ghost", at: .after("b"), roster: roster, in: &app))
    #expect(!ChatListArrangement.place("b", at: .after("ghost"), roster: roster, in: &app))
    #expect(app == held)
  }

  @Test func foldersMoveAmongFoldersAndStepAtTheEdges() {
    var app = section()

    #expect(ChatListArrangement.stepFolder("f", by: 1, in: &app))
    #expect(ChatLayout(app: app).entries == [.chat("a"), .chat("b"), .folder("g"), .folder("f")])
    #expect(ChatLayout(app: app).folders.map(\.id) == ["g", "f"])

    // At the edges there is nowhere to step.
    let held = app
    #expect(!ChatListArrangement.stepFolder("f", by: 1, in: &app))
    #expect(!ChatListArrangement.stepFolder("g", by: -1, in: &app))
    #expect(app == held)

    #expect(ChatListArrangement.moveFolder("f", toIndex: 0, in: &app))
    #expect(ChatLayout(app: app).folders.map(\.id) == ["f", "g"])
    // The chats of a folder go with it.
    #expect(ChatLayout(app: app).folder("f")?.bots == ["x", "y"])
  }

  @Test func theWireIsTheWebsShapeAndUnknownEntriesStay() {
    var app: JSONObject = [
      "v": 1, "pinned": ["a"], "entries": [["kind": "divider", "id": "d", "name": "Old"]]
    ]

    #expect(ChatListArrangement.addFolder(id: "n", name: "New", roster: ["a"], in: &app))
    #expect(app["pinned"] == ["a"])
    #expect(app["entries"] == [
      ["kind": "divider", "id": "d", "name": "Old"], ["kind": "chat", "name": "a"], ["kind": "folder", "id": "n"]
    ])
    #expect(app["folders"] == [["id": "n", "name": "New", "bots": []]])
  }

  @Test func folderIDsAreSafeNamesAndDistinct() {
    let first = ChatFolderID.make(now: Date(timeIntervalSince1970: 1_790_000_000))
    let second = ChatFolderID.make(now: Date(timeIntervalSince1970: 1_790_000_000))

    #expect(first != second)
    #expect(first.hasPrefix("f"))
    #expect(ChatFolderID.isSafe(first))
    #expect(ChatFolderID.isSafe("f1_a-B"))
    #expect(!ChatFolderID.isSafe(""))
    #expect(!ChatFolderID.isSafe("../x"))
    #expect(!ChatFolderID.isSafe("a b"))
    #expect(!ChatFolderID.isSafe(String(repeating: "a", count: 65)))
    #expect(ChatFolder.cleaned("  Work \n") == "Work")
    #expect(ChatFolder.cleaned(String(repeating: "w", count: 90)).count == 64)
  }

  // MARK: What the list draws

  private func arrangement(
    pinned: [String] = [], archived: Set<String> = [], app: JSONObject? = nil
  ) -> ChatListArrangement {
    ChatListArrangement(archived: archived, pinned: pinned, layout: ChatLayout(app: app ?? section()))
  }

  private func shape(_ sections: ChatListSections<String>) -> [String] {
    sections.blocks.map { block in
      switch block {
      case .chats(let key, let rows): "\(key):" + rows.joined(separator: ",")
      case .folder(let folder): "\(folder.name):" + folder.chats.joined(separator: ",")
      }
    }
  }

  @Test func theListDrawsRunsAndFoldersInTheLayoutsOrder() {
    let sections = arrangement().sections(roster) { $0 }

    #expect(shape(sections) == ["run-0:a", "Work:x,y", "run-1:b", "Home:z"])
    #expect(sections.visible == ["a", "x", "y", "b", "z"])
    #expect(sections.folders.map(\.colour) == [.teal, .default])
    #expect(sections.archived.isEmpty)
  }

  @Test func pinnedChatsLeadTheirContainer() {
    let sections = arrangement(pinned: ["b", "y"]).sections(roster) { $0 }

    // Loose pinned chats lead the top level; a folder's pinned chat leads that folder.
    #expect(shape(sections) == ["pinned:b", "run-0:a", "Work:y,x", "Home:z"])
    #expect(sections.visible == ["b", "a", "y", "x", "z"])
  }

  @Test func archivedChatsLeaveTheirFolderAndAFolderWithNothingLeftIsNotDrawn() {
    let sections = arrangement(archived: ["y", "z"]).sections(roster) { $0 }

    #expect(shape(sections) == ["run-0:a", "Work:x", "run-1:b"])
    // In the order the layout would have drawn them.
    #expect(sections.archived == ["y", "z"])
  }

  @Test func aChatTheArrangementDoesNotPlaceYetComesBeforeTheFirstFolder() {
    let sections = arrangement().sections(["new", "a", "b", "x", "y", "z", "newer"]) { $0 }

    #expect(shape(sections) == ["run-0:a,new,newer", "Work:x,y", "run-1:b", "Home:z"])
  }

  @Test func anEmptyArrangementDrawsTheRostersOrder() {
    let sections = ChatListArrangement().sections(["c", "a", "b"]) { $0 }

    #expect(shape(sections) == ["run-0:c,a,b"])
  }

  @Test func aSearchNarrowsTheRowsAndAFolderWithNoMatchGoesAway() {
    let sections = arrangement().sections(["y", "z"]) { $0 }

    #expect(shape(sections) == ["Work:y", "Home:z"])
  }

  @Test func aFolderWithNoChatsDoesNotSplitTheRunAroundIt() {
    var app = section()
    app["folders"] = [["id": "f", "name": "Empty", "bots": []], ["id": "g", "name": "Home", "bots": ["z"]]]
    let sections = arrangement(app: app).sections(["a", "b", "z"]) { $0 }

    #expect(shape(sections) == ["run-0:a,b", "Home:z"])
  }

  @Test func aChatStepsAmongItsContainersChatsOfTheSamePinnedKind() {
    let sections = arrangement(pinned: ["b", "y"]).sections(roster) { $0 }

    // The loose chats on both sides of a folder are one set, pinned ones apart.
    #expect(sections.moveGroup(of: "a") == ["a"])
    #expect(sections.moveGroup(of: "b") == ["b"])
    #expect(sections.moveGroup(of: "x") == ["x"])
    #expect(sections.moveGroup(of: "y") == ["y"])

    let plain = arrangement().sections(roster) { $0 }
    #expect(plain.moveGroup(of: "a") == ["a", "b"])
    #expect(plain.moveGroup(of: "b") == ["a", "b"])
    #expect(plain.moveGroup(of: "x") == ["x", "y"])
    #expect(plain.moveGroup(of: "z") == ["z"])
    #expect(plain.moveGroup(of: "unknown") == ["unknown"])
  }

  @Test func stepsAreTheNeighboursInTheSet() {
    let sections = arrangement().sections(roster) { $0 }

    #expect(sections.steps(of: "a").up == nil)
    #expect(sections.steps(of: "a").down == .after("b"))
    #expect(sections.steps(of: "b").up == .before("a"))
    #expect(sections.steps(of: "b").down == nil)
    // Alone in its set: nowhere to step.
    #expect(sections.steps(of: "z").up == nil)
    #expect(sections.steps(of: "z").down == nil)
    #expect(sections.steps(of: "x").down == .after("y"))
  }

  @Test func aDragWithinARunLandsInsideItsSet() {
    // A folder with a pinned chat leading: [y (pinned), x, w].
    var app = section()
    app["folders"] = [["id": "f", "name": "Work", "bots": ["x", "y", "w"]], ["id": "g", "name": "Home", "bots": ["z"]]]
    let sections = arrangement(pinned: ["y"], app: app).sections(["a", "b", "x", "y", "w", "z"]) { $0 }
    let names = ["y", "x", "w"]

    // An unpinned chat dragged above the pinned one stops at the edge of the unpinned ones.
    #expect(sections.dropAnchor(moving: "w", in: names, at: 0) == .before("x"))
    // Dragged to the end: after the last of its own.
    #expect(sections.dropAnchor(moving: "x", in: names, at: 3) == .after("w"))
    #expect(sections.dropAnchor(moving: "x", in: names, at: 2) == .before("w"))
    // The pinned one has no neighbour to land by except itself.
    #expect(sections.dropAnchor(moving: "y", in: names, at: 2) == .after("y"))
    // The loose chats on both sides of a folder are one set: a run is a part of it.
    let plain = arrangement().sections(roster) { $0 }
    #expect(plain.dropAnchor(moving: "b", in: ["b"], at: 0) == .before("b"))
    #expect(plain.dropAnchor(moving: "ghost", in: ["a", "b"], at: 1) == nil)
  }

  @Test func aDropOnARowLandsNextToItInItsContainer() {
    let sections = arrangement(pinned: ["b"]).sections(roster) { $0 }

    // Same folder: after it when moving down, before it when moving up.
    #expect(sections.dropAnchor(moving: "x", onto: "y") == .after("y"))
    #expect(sections.dropAnchor(moving: "y", onto: "x") == .before("x"))
    // Another container, either way: right before it.
    #expect(sections.dropAnchor(moving: "x", onto: "a") == .before("a"))
    #expect(sections.dropAnchor(moving: "a", onto: "z") == .before("z"))
    #expect(sections.dropAnchor(moving: "x", onto: "z") == .before("z"))
    // Not itself, and not across the pinned line of one container.
    #expect(sections.dropAnchor(moving: "x", onto: "x") == nil)
    #expect(sections.dropAnchor(moving: "a", onto: "b") == nil)
  }

  // MARK: Closed folders

  private func defaults(_ name: String = #function) -> UserDefaults {
    let suite = "hermie.tests.collapse.\(name).\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
  }

  @MainActor
  @Test func aClosedFolderStaysClosedAfterARelaunchOnThatGatewayOnly() {
    let store = defaults()
    let collapse = ChatFolderCollapse(defaults: store)

    #expect(!collapse.isCollapsed("f", gateway: "one"))
    collapse.toggle("f", gateway: "one")
    #expect(collapse.isCollapsed("f", gateway: "one"))
    #expect(!collapse.isCollapsed("f", gateway: "two"))

    let relaunched = ChatFolderCollapse(defaults: store)
    #expect(relaunched.isCollapsed("f", gateway: "one"))
    #expect(!relaunched.isCollapsed("g", gateway: "one"))

    relaunched.setCollapsed(false, folder: "f", gateway: "one")
    #expect(!ChatFolderCollapse(defaults: store).isCollapsed("f", gateway: "one"))
    #expect(store.object(forKey: ChatFolderCollapse.defaultsKey) == nil)
  }

  // MARK: Through the model

  @MainActor
  @Test func theModelEditsFoldersThroughTheSyncAndTheOtherDeviceFollows() async {
    let gateway = HoldingGateway()
    let phoneSync = UIMetaSync.device(gateway.gateway)
    let macSync = UIMetaSync.device(gateway.gateway)
    let phone = ChatArrangementModel(now: { noon })
    let mac = ChatArrangementModel(now: { noon })
    phone.attach(phoneSync)
    mac.attach(macSync)

    // An empty name makes no folder.
    #expect(phone.newFolder("  ", roster: ["researcher", "writer"]) == nil)

    guard let folder = phone.newFolder(" Work ", containing: "writer", roster: ["researcher", "writer"]) else {
      Issue.record("the folder was not made")
      return
    }

    #expect(phone.arrangement.layout.folder(folder)?.name == "Work")
    #expect(phone.arrangement.layout.folderID(of: "writer") == folder)

    phone.setFolderColour(folder, to: .green)
    phone.renameFolder(folder, to: "Office")
    await phoneSync.reconcile()
    await macSync.reconcile()
    await uiMetaEventually("the Mac's folder to follow") {
      mac.arrangement.layout.folder(folder)?.name == "Office"
    }

    #expect(mac.arrangement.layout.folder(folder)?.colour == .green)
    #expect(gateway.meta("researcher")[ownerKey]?["folders"] == [
      ["id": .string(folder), "name": "Office", "colour": "green", "bots": ["writer"]]
    ])

    // Deleting the folder keeps the chat, and that follows too.
    mac.removeFolder(folder)
    await macSync.reconcile()
    await phoneSync.reconcile()
    await uiMetaEventually("the phone's folder to go") { phone.arrangement.layout.folders.isEmpty }
    #expect(phone.arrangement.layout.placed.contains("writer"))
  }

  @MainActor
  @Test func aDetachedModelMakesNoFolder() {
    let sync = UIMetaSync.device(HoldingGateway().gateway)
    let model = ChatArrangementModel(now: { noon })

    model.attach(sync)
    model.detach(sync)

    #expect(model.newFolder("Work", roster: ["a"]) == nil)
    #expect(!sync.pending)
  }
}
