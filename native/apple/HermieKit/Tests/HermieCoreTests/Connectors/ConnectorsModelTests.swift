import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A gateway's connectors for one account: a list, and an operation whose target settles after a chosen
/// number of reads, as the gateway's own watcher would notice the vendor account.
private final class ConnectorsGateway: Sendable {
  struct State {
    var available = true
    var connected: Set<String> = ["gmail"]
    var readsBeforeSettling = 2
    var settlesAs = "connected"
    var connectURL: String? = "https://vendor.example.test/authorize/notion"
    var startState = "initiated"
    var seq = 10
    /// What a read answers when it is not the settled one: a frame stamped with this `seq`, when set.
    var staleSeq: Int?
    var operationSettles = false
    var connectRefusal: String?
  }

  let rpc = ScriptedRPC()
  let state = Mutex(State())

  init() {
    rpc.handle("connectors.list") { _ in
      let (available, connected) = self.state.withLock { ($0.available, $0.connected) }
      let rows = ["gmail", "notion", "slack"].map { slug -> JSONValue in
        .object([
          "connector": .string(slug), "connected": .bool(connected.contains(slug)), "enabled": true,
          "connectionStatus": .string(connected.contains(slug) ? "active" : "not_connected")
        ])
      }

      return .object(["available": .bool(available), "connectors": .array(available ? rows : [])])
    }
    rpc.handle("connectors.connect") { params in
      if let refusal = self.state.withLock({ $0.connectRefusal }) {
        throw GatewayRPCError(.rejected, refusal, code: 4002)
      }

      let slug = params["connectors"]?[0]?.stringValue ?? ""
      let (url, start, seq) = self.state.withLock { ($0.connectURL, $0.startState, $0.seq) }
      var target: JSONObject = ["name": .string(slug), "kind": "connector", "state": .string(start)]

      if let url {
        target["connect_url"] = .string(url)
      }

      return .object(["op_id": "op-1", "seq": .number(Double(seq)), "settled": false, "targets": .array([.object(target)])])
    }
    rpc.handle("connectors.operation.status") { _ in
      self.state.withLock { state -> JSONValue in
        if let stale = state.staleSeq {
          state.staleSeq = nil

          return .object([
            "op_id": "op-1", "seq": .number(Double(stale)), "settled": false,
            "targets": .array([.object(["name": "notion", "state": "connected"])])
          ])
        }

        state.seq += 1

        if state.readsBeforeSettling > 0 {
          state.readsBeforeSettling -= 1

          return .object([
            "op_id": "op-1", "seq": .number(Double(state.seq)), "settled": .bool(state.operationSettles),
            "targets": .array([.object(["name": "notion", "state": "initiated"])])
          ])
        }

        return .object([
          "op_id": "op-1", "seq": .number(Double(state.seq)), "settled": true,
          "targets": .array([
            .object(["name": "notion", "state": .string(state.settlesAs), "detail": "the workspace refused the grant"])
          ])
        ])
      }
    }
    rpc.respond("connectors.operation.wake", jsonValue(#"{"status": "ok"}"#))
  }
}

@MainActor
private final class Browser {
  var opened: [URL] = []
  var accepts = true

  func open(_ url: URL) -> Bool {
    opened.append(url)

    return accepts
  }
}

@MainActor
private func opened(profile: String? = "writer", maxPolls: Int = 10) async -> (ConnectorsModel, ConnectorsGateway) {
  let gateway = ConnectorsGateway()
  let model = ConnectorsModel(
    service: ConnectorsService(gateway: gateway.rpc.gateway), profile: profile, pollInterval: .zero,
    maxPolls: maxPolls)
  await model.load()

  return (model, gateway)
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct ConnectorsModelTests {
  // MARK: Reading

  @Test func startsLoadingAndThenHoldsTheConnectors() async {
    let gateway = ConnectorsGateway()
    let model = ConnectorsModel(service: ConnectorsService(gateway: gateway.rpc.gateway), profile: "writer")

    #expect(model.phase == .loading)
    await model.load()

    #expect(model.phase == .ready)
    #expect(model.connectors.map(\.slug) == ["gmail", "notion", "slack"])
    #expect(model.connector("gmail")?.connected == true)
  }

  @Test func switchedOffIsItsOwnStateAndNotAnEmptyAccount() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.available = false }

    await model.load()

    #expect(model.phase == .unavailable)
    #expect(model.connectors.isEmpty)
  }

  @Test func aFailedFirstReadIsAFailureAndAFailedRefreshKeepsTheList() async {
    let (model, gateway) = await opened()
    gateway.rpc.refuse("connectors.list", "Connector request failed. Try again explicitly.", code: 5034)

    await model.load()

    #expect(model.phase == .ready)
    #expect(model.connectors.count == 3)
    #expect(model.notice == .readFailed("Connector request failed. Try again explicitly."))

    let fresh = ConnectorsModel(service: ConnectorsService(gateway: gateway.rpc.gateway), profile: nil)
    await fresh.load()

    #expect(fresh.phase == .failed("Connector request failed. Try again explicitly."))
  }

  // MARK: Connecting

  @Test func aWalkOpensTheLinkFollowsTheOperationAndReadsTheListAfter() async {
    let (model, gateway) = await opened()
    let browser = Browser()

    _ = gateway.state.withLock { $0.connected.insert("notion") }
    let done = await model.connect("notion", open: browser.open)

    #expect(done)
    #expect(browser.opened == [URL(string: "https://vendor.example.test/authorize/notion")!])
    #expect(gateway.rpc.calls("connectors.operation.status").count == 3, "two reads that moved nothing and the settled one")
    #expect(model.notice == .connected("notion"))
    #expect(model.connecting == nil)
    #expect(model.connector("notion")?.connected == true, "the list is read again after the walk")
  }

  @Test func aWalkWithARealIntervalBetweenReadsSettlesToo() async {
    // A real suspension between reads, which the zero-interval tests do not make: the walk's loop
    // crashed the Swift 6.4 runtime once on exactly this.
    let gateway = ConnectorsGateway()
    let model = ConnectorsModel(
      service: ConnectorsService(gateway: gateway.rpc.gateway), profile: "writer", pollInterval: .milliseconds(2))
    _ = gateway.state.withLock { $0.connected.insert("notion") }

    #expect(await model.connect("notion", open: Browser().open))
    #expect(gateway.rpc.calls("connectors.operation.status").count == 3)
  }

  @Test func aTargetThatFailsIsToldInTheVendorsWords() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.settlesAs = "failed" }

    let done = await model.connect("notion", open: Browser().open)

    #expect(done == false)
    #expect(model.notice == .failed("the workspace refused the grant"))
  }

  @Test func aTargetThatExpiredAndOneTheOperationSettledWithoutAreNotFailures() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.settlesAs = "expired" }

    #expect(await model.connect("notion", open: Browser().open) == false)
    #expect(model.notice == .expired)

    let (other, otherGateway) = await opened()
    otherGateway.state.withLock {
      $0.readsBeforeSettling = 1
      $0.operationSettles = true
      $0.settlesAs = "initiated"
    }

    #expect(await other.connect("notion", open: Browser().open) == false)
    #expect(other.notice == .skipped, "the operation settled under the target: nothing more is coming")
  }

  @Test func aWalkThatNeverSettlesGivesUpAsExpired() async {
    let (model, gateway) = await opened(maxPolls: 3)
    gateway.state.withLock { $0.readsBeforeSettling = 100 }

    #expect(await model.connect("notion", open: Browser().open) == false)

    #expect(gateway.rpc.calls("connectors.operation.status").count == 3)
    #expect(model.notice == .expired)
  }

  @Test func aSnapshotOlderThanOneAlreadySeenIsDropped() async {
    let (model, gateway) = await opened()
    // The first read answers a frame stamped before the connect's own, which says connected: it is
    // the status read losing a race with the watcher, and applying it would be wrong.
    gateway.state.withLock {
      $0.staleSeq = 5
      $0.readsBeforeSettling = 1
      $0.settlesAs = "failed"
    }

    #expect(await model.connect("notion", open: Browser().open) == false)
    #expect(model.notice == .failed("the workspace refused the grant"), "the stale 'connected' was ignored")
  }

  @Test func aNoAuthConnectorThatIsConnectedAtOnceNeverOpensTheBrowser() async {
    let (model, gateway) = await opened()
    gateway.state.withLock {
      $0.startState = "connected"
      $0.connectURL = nil
    }
    let browser = Browser()

    #expect(await model.connect("notion", open: browser.open))
    #expect(browser.opened.isEmpty)
    #expect(gateway.rpc.calls("connectors.operation.status").isEmpty)
  }

  @Test func aGatewayThatSendsNoLinkSaysSoInsteadOfWaitingForTheDeadline() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.connectURL = nil }
    let browser = Browser()

    #expect(await model.connect("notion", open: browser.open) == false)

    #expect(browser.opened.isEmpty)
    #expect(model.notice == .noLink)
    #expect(gateway.rpc.calls("connectors.operation.status").isEmpty)
  }

  @Test func aLinkThatIsNotHttpsOrWillNotOpenIsRefused() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.connectURL = "http://vendor.example.test/x" }
    let browser = Browser()

    #expect(await model.connect("notion", open: browser.open) == false)
    #expect(browser.opened.isEmpty)
    #expect(model.notice == .linkRefused)

    gateway.state.withLock { $0.connectURL = "https://vendor.example.test/x" }
    browser.accepts = false

    #expect(await model.connect("notion", open: browser.open) == false)
    #expect(model.notice == .linkRefused)
  }

  @Test func aRefusedConnectIsToldInTheGatewaysWords() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.connectRefusal = "Reopen the stored link." }

    #expect(await model.connect("notion", reconnect: true, open: Browser().open) == false)

    #expect(model.notice == .failed("Reopen the stored link."))
    #expect(gateway.rpc.calls("connectors.connect").first?["reconnect"] == true)
  }

  @Test func oneWalkRunsAtATime() async {
    let (model, gateway) = await opened()
    gateway.rpc.hold("connectors.connect")

    let first = Task { await model.connect("notion", open: Browser().open) }
    await eventually { gateway.rpc.isHolding }

    #expect(model.connecting == "notion")
    #expect(await model.connect("slack", open: Browser().open) == false)

    gateway.rpc.release()
    _ = await first.value
    #expect(gateway.rpc.calls("connectors.connect").count == 1)
  }

  @Test func leavingThePageMidWalkStopsFollowingWithoutAFailure() async {
    let (model, gateway) = await opened(maxPolls: 1_000_000)
    gateway.state.withLock { $0.readsBeforeSettling = 10_000_000 }

    let walk = Task { await model.connect("notion", open: Browser().open) }
    await eventually { gateway.rpc.calls("connectors.operation.status").count >= 2 }

    walk.cancel()

    #expect(await walk.value == false)
    #expect(model.connecting == nil)
    #expect(model.notice == nil, "a person who left is owed no red line")
  }

  @Test func theWakeNamesTheOpenOperationAndIsNothingWithoutOne() async {
    let (model, gateway) = await opened(maxPolls: 1_000_000)

    await model.wake()
    #expect(gateway.rpc.calls("connectors.operation.wake").isEmpty)

    gateway.state.withLock { $0.readsBeforeSettling = 10_000_000 }
    let walk = Task { await model.connect("notion", open: Browser().open) }
    await eventually { gateway.rpc.calls("connectors.operation.status").count >= 1 }

    await model.wake()
    walk.cancel()
    _ = await walk.value

    #expect(gateway.rpc.calls("connectors.operation.wake").first?["op_id"] == "op-1")
  }

  @Test func anotherBotReadsTheListAgainForItsOwnAccount() async {
    let (model, gateway) = await opened()

    await model.setProfile("researcher")

    #expect(gateway.rpc.calls("connectors.list").last?["profile"] == "researcher")
    #expect(gateway.rpc.calls("connectors.list").count == 2)
  }
}
