import Foundation
import Testing

@testable import HermieCore

/// The decision table of `PushPlan.steps`: pure, so every row is a snapshot in and steps out.
@Suite("Push plan")
struct PushPlanTests {
  typealias F = PushFixtures

  static let day = PushPlan.refreshInterval
  static let start = 1_000_000.0

  static func input(
    now: Double = start,
    token: APNsDeviceToken? = F.tokenA,
    environment: APNsEnvironment = .sandbox,
    topic: String = F.topic,
    relay: String = F.relay,
    wanted: Bool = true,
    gateways: [String] = ["g1"],
    stored: [PushPlanRecord] = [],
    backedOff: Set<String> = []
  ) -> PushPlanInput {
    PushPlanInput(
      now: now,
      token: token,
      environment: environment,
      topic: topic,
      relay: relay,
      wanted: wanted,
      gatewayIds: gateways,
      stored: stored,
      backedOff: backedOff
    )
  }

  static func record(_ registration: PushRegistration, manage: Bool = true, send: Bool = true) -> PushPlanRecord {
    PushPlanRecord(registration: registration, hasManageSecret: manage, hasSendSecret: send)
  }

  @Test("first launch: one registration per gateway, in gateway order")
  func firstLaunch() {
    #expect(
      PushPlan.steps(Self.input(gateways: ["g2", "g1"]))
        == [.register(gatewayId: "g2"), .register(gatewayId: "g1")]
    )
  }

  @Test("first launch before APNs answered: nothing, since registering needs the token")
  func noTokenYet() {
    #expect(PushPlan.steps(Self.input(token: nil)) == [])
  }

  @Test("a duplicate gateway id is registered once")
  func duplicateGateway() {
    #expect(PushPlan.steps(Self.input(gateways: ["g1", "g1"])) == [.register(gatewayId: "g1")])
  }

  @Test("up to date and refreshed less than a day ago: nothing")
  func upToDate() {
    let stored = [Self.record(F.registration("g1", refreshedAt: Self.start - Self.day + 1))]
    #expect(PushPlan.steps(Self.input(stored: stored)) == [])
  }

  @Test("token change: refresh, whenever it happens")
  func tokenChange() {
    let stored = [Self.record(F.registration("g1", refreshedAt: Self.start - 10))]
    #expect(
      PushPlan.steps(Self.input(token: F.tokenB, stored: stored))
        == [.refresh(gatewayId: "g1", reason: .tokenChanged)]
    )
  }

  @Test("daily refresh: exactly a day after the last one, not a second before")
  func dailyRefresh() {
    let stored = [Self.record(F.registration("g1", refreshedAt: Self.start - Self.day))]
    #expect(PushPlan.steps(Self.input(stored: stored)) == [.refresh(gatewayId: "g1", reason: .daily)])

    let fresh = [Self.record(F.registration("g1", refreshedAt: Self.start - Self.day + 0.5))]
    #expect(PushPlan.steps(Self.input(stored: fresh)) == [])
  }

  @Test("environment change: refresh with the new environment")
  func environmentChange() {
    let stored = [Self.record(F.registration("g1", environment: .sandbox, refreshedAt: Self.start))]
    #expect(
      PushPlan.steps(Self.input(environment: .production, stored: stored))
        == [.refresh(gatewayId: "g1", reason: .environmentChanged)]
    )
  }

  @Test("clock moved back past the tolerance: refresh, which re-stamps; a small step back: nothing")
  func clockBackwards() {
    let future = [Self.record(F.registration("g1", refreshedAt: Self.start + PushPlan.futureTolerance + 1))]
    #expect(PushPlan.steps(Self.input(stored: future)) == [.refresh(gatewayId: "g1", reason: .clockSkew)])

    let slightly = [Self.record(F.registration("g1", refreshedAt: Self.start + 30))]
    #expect(PushPlan.steps(Self.input(stored: slightly)) == [])
  }

  @Test("switched off or permission revoked: every registration is deleted, no token needed")
  func notWanted() {
    let stored = [Self.record(F.registration("g2")), Self.record(F.registration("g1"))]

    for token in [F.tokenA, nil] as [APNsDeviceToken?] {
      #expect(
        PushPlan.steps(Self.input(token: token, wanted: false, gateways: ["g1", "g2"], stored: stored))
          == [.delete(gatewayId: "g1", reason: .notWanted), .delete(gatewayId: "g2", reason: .notWanted)]
      )
    }
  }

  @Test("gateway removed: its registration is deleted, the others are left alone")
  func gatewayRemoved() {
    let stored = [Self.record(F.registration("g1", refreshedAt: Self.start)), Self.record(F.registration("g2"))]
    #expect(
      PushPlan.steps(Self.input(gateways: ["g1"], stored: stored))
        == [.delete(gatewayId: "g2", reason: .gatewayGone)]
    )
  }

  @Test("removal comes first, then registration, even without a token for the rest")
  func removalFirst() {
    let stored = [Self.record(F.registration("g9"))]
    #expect(
      PushPlan.steps(Self.input(gateways: ["g1"], stored: stored))
        == [.delete(gatewayId: "g9", reason: .gatewayGone), .register(gatewayId: "g1")]
    )
    #expect(
      PushPlan.steps(Self.input(token: nil, gateways: ["g1"], stored: stored))
        == [.delete(gatewayId: "g9", reason: .gatewayGone)]
    )
  }

  @Test("no manage secret: it cannot be revoked from here, so forget it and register again")
  func manageSecretMissing() {
    let stored = [Self.record(F.registration("g1", refreshedAt: Self.start), manage: false)]
    #expect(
      PushPlan.steps(Self.input(stored: stored))
        == [.forget(gatewayId: "g1", reason: .manageSecretMissing), .register(gatewayId: "g1")]
    )
    #expect(
      PushPlan.steps(Self.input(wanted: false, stored: stored))
        == [.forget(gatewayId: "g1", reason: .manageSecretMissing)]
    )
  }

  @Test("no send secret but the manage secret is there: revoke the old one first, never just drop it")
  func sendSecretMissing() {
    let stored = [Self.record(F.registration("g1", refreshedAt: Self.start), send: false)]
    #expect(
      PushPlan.steps(Self.input(stored: stored))
        == [.delete(gatewayId: "g1", reason: .sendSecretMissing), .register(gatewayId: "g1")]
    )
    #expect(
      PushPlan.steps(Self.input(wanted: false, stored: stored)) == [.delete(gatewayId: "g1", reason: .notWanted)]
    )
  }

  @Test("at most eight registrations: the ninth gateway is not registered, and revoked if it was")
  func limit() {
    let ids = (1...9).map { "g\($0)" }

    #expect(PushPlan.steps(Self.input(gateways: ids)) == ids.prefix(8).map { PushStep.register(gatewayId: $0) })
    #expect(PushPlan.selection(ids + ["g1"]) == (Array(ids.prefix(8)), ["g9"]))

    let stored = ids.map { Self.record(F.registration($0, refreshedAt: Self.start)) }
    #expect(PushPlan.steps(Self.input(gateways: ids, stored: stored)) == [.delete(gatewayId: "g9", reason: .overLimit)])
  }

  @Test("the selection is sticky: a held slot is kept whatever the order, free slots fill in list order")
  func stickySelection() {
    let ids = (1...9).map { "g\($0)" }
    let holding = Set(ids.prefix(8))

    #expect(PushPlan.selection(ids, holding: holding).limited == ["g9"])
    #expect(PushPlan.selection(["g9"] + ids.prefix(8), holding: holding).limited == ["g9"])
    #expect(PushPlan.selection(ids.filter { $0 != "g3" }, holding: holding).limited.isEmpty)

    let stored = ids.prefix(8).map { Self.record(F.registration($0, refreshedAt: Self.start)) }
    #expect(PushPlan.steps(Self.input(gateways: ["g9"] + ids.prefix(8), stored: stored)) == [])
  }

  @Test("a frozen gateway gets no step and keeps its slot")
  func frozen() {
    let ids = (1...9).map { "g\($0)" }
    let stored = ids.prefix(8).filter { $0 != "g3" }.map { Self.record(F.registration($0, refreshedAt: Self.start)) }
    var input = Self.input(gateways: ids, stored: stored)
    input.frozen = ["g3"]

    #expect(PushPlan.steps(input) == [])

    input.wanted = false
    #expect(!PushPlan.steps(input).contains { $0.gatewayId == "g3" })
  }

  @Test("a gateway backed off after a failed store is not registered again in this pass")
  func backedOff() {
    #expect(PushPlan.steps(Self.input(gateways: ["g1", "g2"], backedOff: ["g1"])) == [.register(gatewayId: "g2")])
  }

  @Test("another relay origin: forgotten without contacting it, then registered here")
  func relayChanged() {
    let stored = [Self.record(F.registration("g1", relay: "https://old.example.test", refreshedAt: Self.start))]
    #expect(
      PushPlan.steps(Self.input(stored: stored))
        == [.forget(gatewayId: "g1", reason: .relayChanged), .register(gatewayId: "g1")]
    )
    #expect(
      PushPlan.steps(Self.input(wanted: false, stored: stored)) == [.forget(gatewayId: "g1", reason: .relayChanged)]
    )
  }

  @Test("another topic: deleted, then registered for this one")
  func topicChanged() {
    let stored = [Self.record(F.registration("g1", topic: "dev.hermie.other", refreshedAt: Self.start))]
    #expect(
      PushPlan.steps(Self.input(stored: stored))
        == [.delete(gatewayId: "g1", reason: .topicChanged), .register(gatewayId: "g1")]
    )
  }

  @Test("a token change wins over the daily rule: one refresh, not two")
  func oneRefresh() {
    let stored = [Self.record(F.registration("g1", environment: .production, refreshedAt: Self.start - 3 * Self.day))]
    #expect(
      PushPlan.steps(Self.input(token: F.tokenB, stored: stored))
        == [.refresh(gatewayId: "g1", reason: .tokenChanged)]
    )
  }

  @Test("same input, same steps")
  func deterministic() {
    let input = Self.input(
      gateways: ["g3", "g1", "g2"],
      stored: [Self.record(F.registration("g2", refreshedAt: 0)), Self.record(F.registration("g7"))]
    )

    #expect(PushPlan.steps(input) == PushPlan.steps(input))
    #expect(
      PushPlan.steps(input)
        == [
          .delete(gatewayId: "g7", reason: .gatewayGone),
          .register(gatewayId: "g3"),
          .register(gatewayId: "g1"),
          .refresh(gatewayId: "g2", reason: .daily)
        ]
    )
  }
}
