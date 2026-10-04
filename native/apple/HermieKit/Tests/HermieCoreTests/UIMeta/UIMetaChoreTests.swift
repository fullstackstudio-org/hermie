import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// HERM-191: an app-section change made only of chores (housekeeping nobody chose) never wins over
/// a section the gateway holds (`dropLosingChores` in `packages/gateway-client/src/ui-meta.ts`).
@Suite(.timeLimit(.minutes(1))) struct UIMetaChoreTests {
  /// A fresh install folds the roster into the order as a chore, undated. The gateway's
  /// arrangement (undated too, from an older build) must win, and the chore is not sent.
  @Test func aFreshInstallsChoreNeverWinsOverTheGateway() async {
    let gateway = HoldingGateway()
    let theirs: JSONObject = [
      "v": 1,
      "entries": [["kind": "folder", "id": "f1"], ["kind": "chat", "name": "researcher"]],
      "folders": [["id": "f1", "name": "Work", "bots": ["writer"]]],
      "pinned": ["writer"]
    ]
    gateway.write("researcher", [ownerKey: .object(theirs)])

    let sync = UIMetaSync.device(gateway.gateway)
    sync.updateApp(.chore) { app in
      app["entries"] = [["kind": "chat", "name": "researcher"], ["kind": "chat", "name": "writer"]]
    }
    #expect(sync.pending)

    await sync.reconcile()

    #expect(gateway.meta("researcher")[ownerKey]?["entries"] == theirs["entries"])
    #expect(gateway.meta("researcher")[ownerKey]?["folders"] == theirs["folders"])
    #expect(sync.app?["entries"] == theirs["entries"])
    #expect(!sync.pending)
    #expect(!gateway.configures.contains { $0["ui_meta"]?[ownerKey] != nil })
  }

  /// The same edit as a choice (a drag) does win over an undated section, as before.
  @Test func aChoiceStillWinsOverAnUndatedGatewaySection() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "entries": [["kind": "chat", "name": "researcher"]]]])

    let sync = UIMetaSync.device(gateway.gateway)
    sync.updateApp(.choice) { $0["entries"] = [["kind": "chat", "name": "writer"], ["kind": "chat", "name": "researcher"]] }
    await sync.reconcile()

    #expect(gateway.meta("researcher")[ownerKey]?["entries"] == [
      ["kind": "chat", "name": "writer"], ["kind": "chat", "name": "researcher"]
    ])
  }

  /// A gateway with no section at all still takes the device's chore (nothing up there to lose).
  @Test func aChoreSeedsAGatewayThatHasNoSection() async {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)
    sync.updateApp(.chore) { $0["entries"] = [["kind": "chat", "name": "writer"]] }

    await sync.reconcile()

    #expect(gateway.meta("researcher")[ownerKey]?["entries"] == [["kind": "chat", "name": "writer"]])
  }

  /// A chore made while a choice is in flight stays a chore once the choice lands: when its own
  /// write then meets another device's undated section, the gateway's copy wins. (A plain flag
  /// stayed set after the choice landed, and the chore, dated by the choice, overwrote it.)
  @Test func aChoreMadeDuringAChoicesFlightStaysAChore() async {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)
    let theirs: JSONObject = ["v": 1, "pinned": ["zed"]]

    sync.updateApp(.choice) { $0["pinned"] = ["writer"] }
    await sync.reconcile()

    gateway.hold("profiles.configure")
    sync.updateApp(.choice) { $0["pinned"] = ["writer", "researcher"] }
    let flight = Task { await sync.flush() }
    await gateway.waitUntilHeld()

    // During the choice's flight: a chore, and the next write held too.
    sync.updateApp(.chore) { $0["entries"] = [["kind": "chat", "name": "writer"]] }
    gateway.hold("profiles.configure")
    gateway.release()
    await gateway.waitUntilHeld()
    #expect(!sync.state.appChoice, "the choice landed; what is left is a chore")

    // Another device writes an undated section before the chore's write arrives.
    gateway.write("researcher", [ownerKey: .object(theirs)])
    gateway.release()
    await flight.value

    #expect(gateway.meta("researcher")[ownerKey]?["pinned"] == ["zed"])
    #expect(sync.app?["pinned"] == ["zed"])
  }

  /// Dated or not: a chore loses to a section the gateway holds with a date as well.
  @Test func aChoreLosesToADatedGatewaySectionToo() async {
    let gateway = HoldingGateway()
    let theirs: JSONObject = [
      "v": 1,
      "entries": [["kind": "folder", "id": "f1"], ["kind": "chat", "name": "researcher"]],
      "folders": [["id": "f1", "name": "Finance", "bots": ["writer"]]],
      "updatedAt": .number(noon - hour)
    ]
    gateway.write("researcher", [ownerKey: .object(theirs)])

    let sync = UIMetaSync.device(gateway.gateway)
    sync.updateApp(.chore) { $0["entries"] = [["kind": "chat", "name": "researcher"], ["kind": "chat", "name": "writer"]] }
    await sync.reconcile()

    #expect(gateway.meta("researcher")[ownerKey] == .object(theirs))
    #expect(sync.app?["entries"] == theirs["entries"])
    #expect(!sync.pending)
    #expect(!gateway.configures.contains { $0["ui_meta"]?[ownerKey] != nil })
  }

  /// On the one pull that inherits the anonymous section, a chore loses to it as well: what lands
  /// under the person's key is the inherited arrangement.
  @Test func aChoreLosesToTheAnonymousSectionOnTheInheritancePull() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [UIMeta.legacyAppKey: [
      "v": 1,
      "entries": [["kind": "folder", "id": "f1"], ["kind": "chat", "name": "researcher"]],
      "folders": [["id": "f1", "name": "Finance", "bots": ["writer"]]]
    ]])

    let sync = UIMetaSync.device(gateway.gateway)
    sync.updateApp(.chore) { $0["entries"] = [["kind": "chat", "name": "researcher"], ["kind": "chat", "name": "writer"]] }
    await sync.reconcile()

    let landed = gateway.meta("researcher")[ownerKey]
    #expect(landed?["folders"] == [["id": "f1", "name": "Finance", "bots": ["writer"]]])
    #expect(landed?["entries"] == [["kind": "folder", "id": "f1"], ["kind": "chat", "name": "researcher"]])
  }

  /// A chore beside a choice is part of a choice, and the choice's date decides.
  @Test func aChoreBesideAChoiceWinsByTheChoicesDate() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: ["v": 1, "folders": ["Finance"], "updatedAt": .number(noon - hour)]])

    let sync = UIMetaSync.device(gateway.gateway, app: ["v": 1, "folders": ["Travel"]])
    sync.updateApp(.chore) { $0["entries"] = [["kind": "chat", "name": "writer"]] }
    sync.updateApp(.choice) { $0["folders"] = ["Travel", "Home"] }
    await sync.reconcile()

    #expect(gateway.meta("researcher")[ownerKey]?["folders"] == ["Travel", "Home"])
    #expect(gateway.meta("researcher")[ownerKey]?["entries"] == [["kind": "chat", "name": "writer"]])
  }

  /// A chore made while a choice is out is sent by a further round of the same flush.
  @Test func aChoreMadeDuringAChoicesFlightIsSentInAFurtherRound() async {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)
    await sync.reconcile()

    gateway.hold("profiles.configure")
    sync.updateApp(.choice) { $0["folders"] = ["Finance"] }
    let flight = Task { await sync.flush() }
    await gateway.waitUntilHeld()

    sync.updateApp(.chore) { $0["entries"] = [["kind": "chat", "name": "writer"]] }
    gateway.release()
    await flight.value

    #expect(gateway.meta("researcher")[ownerKey]?["folders"] == ["Finance"])
    #expect(gateway.meta("researcher")[ownerKey]?["entries"] == [["kind": "chat", "name": "writer"]])
    #expect(!sync.pending)
  }

  /// The bookkeeping: a chore alone is dropped against any remote section; a choice is kept.
  @Test func onlyAChoreIsDropped() {
    var state = UIMetaState()
    state.setUser(owner)
    state.markApp(choice: false)
    state.dropLosingChores(remote: UIMetaSnapshot(app: ["v": 1]))
    #expect(!state.dirtyApp)

    state.markApp(choice: false)
    state.dropLosingChores(remote: UIMetaSnapshot(app: nil))
    #expect(state.dirtyApp, "a gateway with no section takes the chore")

    state.markApp()
    state.dropLosingChores(remote: UIMetaSnapshot(app: ["v": 1]))
    #expect(state.dirtyApp)
    #expect(state.appChoice)
    #expect(state.choiceMark == state.markCount)
  }
}
