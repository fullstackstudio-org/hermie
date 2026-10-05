import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The reusable prompts through the ui_meta sync (NX-13): written as the person's choices, followed from the
/// gateway's copy, round-tripped between two devices, and additive: what another build wrote is carried.
@Suite(.timeLimit(.minutes(1))) @MainActor struct PromptsModelTests {
  private func entries(_ gateway: HoldingGateway) -> [JSONValue] {
    gateway.meta("researcher")[ownerKey]?["prompts"]?.arrayValue ?? []
  }

  private func model(_ sync: UIMetaSync, ids: [String] = []) -> PromptsModel {
    let queue = IDQueue(ids)
    let model = PromptsModel(makeID: { queue.next() })

    model.attach(sync)
    return model
  }

  // MARK: Editing

  @Test func withoutASyncNothingIsWritten() {
    let model = PromptsModel()

    #expect(!model.canEdit && !model.canAdd)
    #expect(model.add(title: "T", text: "x", scope: .global) == nil)
    #expect(model.prompts.isEmpty)
  }

  @Test func addsEditsOrdersAndDeletesThroughTheSync() async {
    let sync = UIMetaSync.device(HoldingGateway().gateway)
    let prompts = model(sync, ids: ["a", "b", "c"])

    #expect(prompts.canEdit && prompts.canAdd)
    #expect(prompts.add(title: "Weekly", text: "Summarise {{week}}", scope: .global) == "a")
    #expect(prompts.add(title: "Review", text: "Review this", scope: .bot("writer")) == "b")
    #expect(prompts.add(title: "Mail", text: "Dear {{who}}", scope: .global) == "c")
    #expect(prompts.add(title: "Empty", text: "  ", scope: .global) == nil)

    // Painted at once, in the person's order, and a bot sees its own first.
    #expect(prompts.global.map(\.id) == ["a", "c"])
    #expect(prompts.prompts(of: "writer").map(\.id) == ["b"])
    #expect(prompts.available(for: "writer").map(\.id) == ["b", "a", "c"])
    #expect(prompts.available(for: "researcher").map(\.id) == ["a", "c"])
    #expect(prompts.count(of: "writer") == 1 && prompts.count(of: "researcher") == 0)

    var weekly = prompts.prompt(id: "a")!
    weekly.title = "Weekly report"
    #expect(prompts.update(weekly))
    #expect(prompts.prompt(id: "a")?.title == "Weekly report")

    prompts.step(id: "c", by: -1)
    #expect(prompts.global.map(\.id) == ["c", "a"])
    prompts.move(id: "c", toIndex: 5)
    #expect(prompts.global.map(\.id) == ["a", "c"])
    prompts.step(id: "a", by: -1)
    #expect(prompts.global.map(\.id) == ["a", "c"], "a step past the front stays at the front")

    prompts.remove(id: "a")
    #expect(prompts.prompts.map(\.id) == ["b", "c"])
    // The edits are the person's choices: they date the section, so the gateway's older copy cannot win.
    #expect(sync.app?[UIMeta.appUpdatedAt] != nil)
  }

  @Test func theChoicesAreSentToTheGatewayAsTheSectionsPromptsField() async {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)
    let prompts = model(sync, ids: ["a"])

    await sync.reconcile()
    prompts.add(title: "Weekly", text: "Summarise {{week}}", scope: .bot("writer"))
    await sync.flush()

    #expect(entries(gateway) == [["id": "a", "title": "Weekly", "text": "Summarise {{week}}", "bot": "writer"]])
  }

  // MARK: Two devices

  @Test func aPromptReachesTheOtherDeviceAndTheOtherDevicesEditComesBack() async {
    let gateway = HoldingGateway()
    let phoneSync = UIMetaSync.device(gateway.gateway)
    let macSync = UIMetaSync.device(gateway.gateway)
    let phone = model(phoneSync, ids: ["a", "m"])
    let mac = model(macSync, ids: ["m"])

    await phoneSync.reconcile()
    await macSync.reconcile()

    phone.add(title: "Weekly", text: "Summarise {{week}}", scope: .global)
    await phoneSync.reconcile()
    await macSync.reconcile()
    await botSettingsEventually("the Mac to follow") { mac.prompts.map(\.id) == ["a"] }
    #expect(mac.prompt(id: "a")?.fields == ["week"])

    var edited = mac.prompt(id: "a")!
    edited.text = "Summarise {{week}} for {{team}}"
    mac.update(edited)
    mac.add(title: "Mail", text: "Dear {{who}}", scope: .bot("writer"))
    await macSync.reconcile()
    await phoneSync.reconcile()
    await botSettingsEventually("the phone to follow") { phone.prompts.count == 2 }

    #expect(phone.prompt(id: "a")?.fields == ["week", "team"])
    #expect(phone.prompts(of: "writer").map(\.title) == ["Mail"])
  }

  @Test func theOtherDevicesOrderIsTheOrderHere() async {
    let gateway = HoldingGateway()
    let phoneSync = UIMetaSync.device(gateway.gateway)
    let macSync = UIMetaSync.device(gateway.gateway)
    let phone = model(phoneSync, ids: ["a", "b", "c"])
    let mac = model(macSync)

    await phoneSync.reconcile()
    await macSync.reconcile()
    for title in ["A", "B", "C"] {
      phone.add(title: title, text: title, scope: .global)
    }

    phone.move(id: "c", toIndex: 0)
    await phoneSync.reconcile()
    await macSync.reconcile()
    await botSettingsEventually("the Mac to follow") { mac.global.map(\.id) == ["c", "a", "b"] }
  }

  // MARK: Additive

  @Test func whatAnotherBuildWroteIsCarriedWhenAPromptIsEdited() async {
    let gateway = HoldingGateway()
    gateway.write(
      "researcher",
      [
        ownerKey: [
          "v": 1,
          "updatedAt": .number(noon - hour),
          "futureField": ["x": [1, 2]],
          "prompts": [
            ["id": "a", "title": "A", "text": "x", "emoji": "wave", "nested": ["k": true]],
            "a newer build's entry",
            ["id": "b", "title": "B", "text": "y"]
          ]
        ]
      ])

    let sync = UIMetaSync.device(gateway.gateway)
    let prompts = model(sync)

    await sync.reconcile()
    await botSettingsEventually("the gateway's prompts") { prompts.prompts.count == 2 }
    #expect(prompts.prompts.map(\.id) == ["a", "b"], "the entry that is not a prompt is not offered")

    var edited = prompts.prompt(id: "a")!
    edited.title = "A2"
    prompts.update(edited)
    prompts.move(id: "b", toIndex: 0)
    await sync.flush()

    let written = gateway.meta("researcher")[ownerKey]

    #expect(written?["futureField"] == ["x": [1, 2]])
    #expect(
      written?["prompts"] == [
        ["id": "b", "title": "B", "text": "y"],
        "a newer build's entry",
        ["id": "a", "title": "A2", "text": "x", "emoji": "wave", "nested": ["k": true]]
      ])
  }

  @Test func theOtherFieldsOfTheSectionAreNotTouchedByPrompts() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "labels": ["writer": "W"], "pinned": ["writer"], "themeChoice": ["kind": "preset", "name": "lime"]]])

    let sync = UIMetaSync.device(gateway.gateway)
    let prompts = model(sync, ids: ["a"])

    await sync.reconcile()
    prompts.add(title: "T", text: "x", scope: .global)
    await sync.flush()

    let written = gateway.meta("researcher")[ownerKey]

    #expect(written?["labels"] == ["writer": "W"])
    #expect(written?["pinned"] == ["writer"])
    #expect(written?["themeChoice"] == ["kind": "preset", "name": "lime"])
    #expect(written?["prompts"]?.arrayValue?.count == 1)
  }

  @Test func aBuildThatDoesNotKnowPromptsDoesNotWipeThem() {
    var documents = UIMetaDocuments(app: ["v": 1, "prompts": [["id": "a", "title": "A", "text": "x"]]])

    // The gateway's copy, written by an older build: no `prompts` at all.
    documents.take(UIMetaSnapshot(app: ["v": 1, "themeChoice": ["kind": "preset", "name": "lime"]]))
    #expect(documents.app?["prompts"]?.arrayValue?.count == 1, "silence is not 'none'")
    #expect(documents.app?["themeChoice"] == ["kind": "preset", "name": "lime"])

    // The same for null.
    documents.take(UIMetaSnapshot(app: ["v": 1, "prompts": .null]))
    #expect(documents.app?["prompts"]?.arrayValue?.count == 1)

    // A device that deleted them all says so with an empty list, which is taken.
    documents.take(UIMetaSnapshot(app: ["v": 1, "prompts": []]))
    #expect(documents.app?["prompts"] == [])
  }

  @Test func theDevicesOwnCopyServesPromptsBeforeAnyGatewayHasAnswered() async {
    let persistence = MemoryPersistence()
    let first = UIMetaSync.device(HoldingGateway.unreachable, persistence: persistence)
    let prompts = model(first, ids: ["a"])

    prompts.add(title: "Offline", text: "x", scope: .global)
    await first.settle()

    // A new launch with no network: the stored copy is read and the prompts are there.
    let second = UIMetaSync.device(HoldingGateway.unreachable, persistence: persistence)
    let later = model(second)

    await botSettingsEventually("the stored copy") { later.prompts.map(\.id) == ["a"] }
  }

  @Test func detachingStopsFollowing() async {
    let sync = UIMetaSync.device(HoldingGateway().gateway)
    let prompts = model(sync, ids: ["a"])

    prompts.add(title: "T", text: "x", scope: .global)
    prompts.detach(sync)
    #expect(!prompts.canEdit)
    prompts.remove(id: "a")
    #expect(prompts.prompts.map(\.id) == ["a"], "nothing is written once detached")
    #expect(PromptLibrary.prompts(in: sync.app).map(\.id) == ["a"])
  }
}

/// Ids handed out in order, for a model that makes them itself.
private final class IDQueue: @unchecked Sendable {
  private let lock = NSLock()
  private var ids: [String]

  init(_ ids: [String]) { self.ids = ids }

  func next() -> String {
    lock.lock()
    defer { lock.unlock() }
    return ids.isEmpty ? PromptID.make() : ids.removeFirst()
  }
}
