import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// HERM-191: a bot section in a schema version this build cannot read (a newer build's `v`) is
/// never written over. A change this device holds for that bot is kept back, still pending, and
/// every other section goes out as usual (`holdBot` in `packages/gateway-client/src/ui-meta.ts`,
/// the web client's "a bot section written by a newer build").
@Suite(.timeLimit(.minutes(1))) struct UIMetaHeldBotTests {
  private let newer: JSONObject = ["v": 2, "shape": "new", "archived": "by-policy"]

  private func wrote(_ gateway: HoldingGateway, _ profile: String) -> Bool {
    gateway.configures.contains { $0["name"] == .string(profile) && $0["ui_meta"]?[UIMeta.botKey] != nil }
  }

  @Test func aChangeToANewerBuildsSectionIsKeptBackAndTheRestGoesOut() async {
    let gateway = HoldingGateway()
    gateway.write("writer", [UIMeta.botKey: .object(newer)])

    let phone = UIMetaSync.device(gateway.gateway)
    await phone.reconcile()

    phone.updateBot("writer") { $0["colour"] = "lime" }
    phone.updateBot("researcher") { $0["colour"] = "teal" }
    await phone.flush()

    #expect(gateway.meta("writer")[UIMeta.botKey] == .object(newer))
    #expect(!wrote(gateway, "writer"))
    #expect(gateway.meta("researcher")[UIMeta.botKey] == ["v": 1, "colour": "teal"])
    #expect(phone.pending)
    #expect(phone.state.dirtyBots == ["writer"])
    #expect(phone.bot("writer")?["colour"] == "lime", "the device keeps its own change")

    // A further reconcile does not send it either.
    await phone.reconcile()

    #expect(gateway.meta("writer")[UIMeta.botKey] == .object(newer))
    #expect(!wrote(gateway, "writer"))
    #expect(phone.pending)
  }

  /// Sent before the roster was read, under revision 0: refused, re-read, and then held.
  @Test func aSendMadeBeforeTheRosterWasReadIsHeldFromTheRetryOn() async {
    let gateway = HoldingGateway()
    gateway.write("writer", [UIMeta.botKey: .object(newer)])

    let phone = UIMetaSync.device(gateway.gateway)
    phone.updateBot("writer") { $0["colour"] = "lime" }
    await phone.flush()

    #expect(gateway.meta("writer")[UIMeta.botKey] == .object(newer))
    #expect(phone.pending)
    #expect(phone.state.dirtyBots == ["writer"])
  }

  /// A section this device would empty is never sent as `null` over one it cannot read.
  @Test func aRemovalIsNeverSentOverASectionThisBuildCannotRead() async {
    let gateway = HoldingGateway()
    gateway.write("writer", [UIMeta.botKey: .object(newer)])

    let phone = UIMetaSync.device(gateway.gateway, bots: ["writer": ["v": 1, "colour": "teal"]])
    phone.updateBot("writer") { $0.removeValue(forKey: "colour") }
    #expect(phone.bot("writer") == nil)

    await phone.reconcile()

    #expect(gateway.meta("writer")[UIMeta.botKey] == .object(newer))
    #expect(phone.pending)
  }

  /// A change stored on the disk before the newer build wrote the section is held as well.
  @Test func aStoredPendingChangeIsHeldToo() async {
    let gateway = HoldingGateway()
    let disk = MemoryPersistence()

    let offline = UIMetaSync.device(HoldingGateway.unreachable, persistence: disk)
    await offline.load()
    offline.updateBot("writer") { $0["colour"] = "lime" }
    await offline.settle()

    gateway.write("writer", [UIMeta.botKey: .object(newer)])

    let phone = UIMetaSync.device(gateway.gateway, persistence: disk)
    await phone.reconcile()

    #expect(gateway.meta("writer")[UIMeta.botKey] == .object(newer))
    #expect(phone.pending)
  }

  /// The default profile is a bot too: its held section stays out of the request, the app
  /// section in the same request still lands.
  @Test func theAppSectionStillLandsBesideAHeldDefaultBot() async {
    let gateway = HoldingGateway()
    gateway.write("researcher", [UIMeta.botKey: .object(newer)])

    let phone = UIMetaSync.device(gateway.gateway)
    await phone.reconcile()

    phone.updateBot("researcher") { $0["colour"] = "lime" }
    phone.updateApp { $0["themeChoice"] = "forest" }
    await phone.flush()

    #expect(gateway.meta("researcher")[UIMeta.botKey] == .object(newer))
    #expect(gateway.meta("researcher")[ownerKey]?["themeChoice"] == "forest")
    #expect(!phone.state.dirtyApp)
    #expect(phone.state.dirtyBots == ["researcher"])
  }

  /// Once the section is one this build reads again, the held change goes out.
  @Test func goesOutOnceTheSectionIsReadableAgain() async {
    let gateway = HoldingGateway()
    gateway.write("writer", [UIMeta.botKey: .object(newer)])

    let phone = UIMetaSync.device(gateway.gateway)
    await phone.reconcile()
    phone.updateBot("writer") { $0["colour"] = "lime" }
    await phone.flush()
    #expect(phone.pending)

    gateway.write("writer", [UIMeta.botKey: ["v": 1, "colour": "red"]])
    await phone.reconcile()

    #expect(gateway.meta("writer")[UIMeta.botKey] == ["v": 1, "colour": "lime"])
    #expect(!phone.pending)
  }

  /// The bookkeeping: the roster names what is held, the outbox leaves it out.
  @Test func theRosterNamesTheHeldBotsAndTheOutboxLeavesThemOut() {
    var state = UIMetaState()
    state.setUser(owner)

    _ = state.ingest(roster: ["profiles": [
      ["name": "researcher", "is_default": true, "ui_meta": [UIMeta.botKey: ["v": 1, "colour": "teal"]]],
      ["name": "writer", "ui_meta": [UIMeta.botKey: ["v": 2]]],
      ["name": "coder", "ui_meta": [UIMeta.botKey: "not an object"]],
      ["name": "tester", "ui_meta": [UIMeta.botKey: .null]],
      ["name": "planner", "ui_meta": [:]]
    ]])

    #expect(state.heldBots == ["writer", "coder"])

    for name in ["researcher", "writer", "coder", "tester", "planner"] {
      state.markBot(name)
    }

    #expect(state.outbox().map(\.profile) == ["researcher", "tester", "planner"])
    #expect(state.pending)

    // A sign-out keeps them: the roster that named them is this gateway's.
    state.reset()
    #expect(state.heldBots == ["writer", "coder"])
  }
}
