import Foundation
import HermieGateway
import Testing

@testable import HermieCore

/// The first-attach table (`.claude/plans/native-rewrite-icloud.md`, "Data model"): a local entry
/// meets a record for its key for the first time. Device 0 publishes; device 1 already holds the
/// same gateway, set up by hand while sync was off, and then turns sync on.
@Suite struct FirstAttachTests {
  static let address = "https://gateway.test"
  static let origin = GatewayAddress.origin(of: address)
  static let key = GatewayKey.of(address)

  /// Device 0 publishes `published`; device 1 holds `local` with sync off.
  static func meet(published: LocalGateway, local: LocalGateway) -> SyncWorld {
    var world = SyncWorld(devices: 2)
    world.devices[0].gateways = [published]
    world.devices[1].gateways = [local]
    world.setEnabled(1, false)
    world.settle()
    world.advance(10_000)
    return world
  }

  static func gateway(
    _ id: String,
    name: String = "Home",
    address: String = address,
    authKind: String = "native_pkce",
    provider: SyncProvider? = nil,
    user: String? = nil,
    token: String? = nil,
    door: String? = nil,
    headers: [String: String]? = nil
  ) -> LocalGateway {
    LocalGateway(
      id: id, name: name, address: address, authKind: authKind, provider: provider, user: user, addedAt: startOfTime,
      frontDoor: door.map { SyncFrontDoor(origin: origin, clientId: "client.access", clientSecret: $0) },
      headers: headers.map { SyncHeaders(origin: origin, headers: $0) },
      sessionToken: token.map { SyncSessionToken(origin: origin, token: $0) })
  }

  // Row "name, provider, user, auth kind": both have a value → the record wins.
  @Test func theRecordWinsForNameProviderUserAndAuthKind() {
    var world = Self.meet(
      published: Self.gateway(
        "g00000000000000a1", name: "Home", authKind: "native_pkce", provider: SyncProvider(name: "self-hosted", label: "OIDC"),
        user: "user-a"),
      local: Self.gateway(
        "g00000000000000b1", name: "Lab", authKind: "session_token", provider: SyncProvider(name: "basic"), user: "user-b"))
    let published = world.cloudRecord(key: Self.key)!

    world.setEnabled(1, true)
    let plan = world.reconcile(1)
    let local = world.devices[1].gateways.first!

    #expect(local.name == "Home")
    #expect(local.authKind == "native_pkce")
    #expect(local.provider == SyncProvider(name: "self-hosted", label: "OIDC"))
    #expect(local.user == "user-a")
    #expect(!plan.hasRemoteWrites)
    for field in [SyncField.name, .authKind, .provider, .user] {
      #expect(world.devices[1].state.entries[local.id]?.stamp(field) == published.registers[field]?.stamp)
    }
  }

  // Row "name, provider, user, auth kind": only one side has a value → it is kept and stamped.
  @Test func aValueOnlyOneSideHasIsKeptAndStamped() {
    var world = Self.meet(
      published: Self.gateway("g00000000000000a1", user: "user-a"),
      local: Self.gateway("g00000000000000b1", provider: SyncProvider(name: "basic", label: "Password")))

    world.setEnabled(1, true)
    world.settle()

    for device in world.devices {
      #expect(device.gateways.first?.user == "user-a")
      #expect(device.gateways.first?.provider == SyncProvider(name: "basic", label: "Password"))
    }
    #expect(world.cloudRecord(key: Self.key)?.registers[.provider]?.stamp.d == world.devices[1].state.device)
  }

  // Row "address (same origin by definition)": the record wins.
  @Test func theRecordWinsForTheAddress() {
    var world = Self.meet(
      published: Self.gateway("g00000000000000a1", address: "https://gateway.test/hermes"),
      local: Self.gateway("g00000000000000b1", address: "https://GATEWAY.test"))

    world.setEnabled(1, true)
    let plan = world.reconcile(1)

    #expect(world.devices[1].gateways.first?.address == "https://gateway.test/hermes")
    #expect(plan.localOps.first.map { op in
      if case let .update(_, fields) = op { return fields.contains(.address) }
      return false
    } == true)
  }

  // Row "front door, headers, session token": both have a value → local wins, stamped now and
  // published.
  @Test func localCredentialsWinAndArePublished() {
    var world = Self.meet(
      published: Self.gateway("g00000000000000a1", authKind: "session_token", token: "tok-a", door: "door-a", headers: ["X-A": "a"]),
      local: Self.gateway("g00000000000000b1", authKind: "session_token", token: "tok-b", door: "door-b", headers: ["X-B": "b"]))

    world.setEnabled(1, true)
    let plan = world.reconcile(1)

    #expect(plan.remotePuts.count == 1)
    let record = plan.remotePuts.first!
    #expect(record.sessionToken?.token == "tok-b")
    #expect(record.frontDoor?.clientSecret == "door-b")
    #expect(record.headers?.headers == ["X-B": "b"])
    for field in [SyncField.sessionToken, .frontDoor, .headers] {
      #expect(record.registers[field]?.stamp == SyncStamp(t: world.now, d: world.devices[1].state.device))
    }

    world.cloud.deliverAll()
    world.settle()
    #expect(world.devices[0].gateways.first?.sessionToken?.token == "tok-b")
    #expect(world.devices[0].gateways.first?.frontDoor?.clientSecret == "door-b")
  }

  // Row "front door, headers, session token": only one side has a value → it is kept.
  @Test func aCredentialOnlyOneSideHasIsKept() {
    var world = Self.meet(
      published: Self.gateway("g00000000000000a1", authKind: "session_token", door: "door-a"),
      local: Self.gateway("g00000000000000b1", authKind: "session_token", token: "tok-b"))

    world.setEnabled(1, true)
    world.settle()

    for device in world.devices {
      #expect(device.gateways.first?.frontDoor?.clientSecret == "door-a")
      #expect(device.gateways.first?.sessionToken?.token == "tok-b")
    }
  }

  // Row "front door, headers, session token": a null in the record never deletes an unstamped
  // local secret.
  @Test func aNullInTheRecordNeverDeletesAnUnstampedLocalSecret() {
    var world = Self.meet(
      published: Self.gateway("g00000000000000a1", authKind: "session_token", token: "tok-a"),
      local: Self.gateway("g00000000000000b1", authKind: "session_token", token: "tok-b", door: "door-b"))

    // Device 0 signs out on all devices and removes its front door: both registers are null now.
    world.signOutEverywhere(0, "g00000000000000a1")
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.registers[.sessionToken]?.value == .null)

    world.setEnabled(1, true)
    world.settle()

    #expect(world.devices[1].gateways.first?.sessionToken?.token == "tok-b")
    #expect(world.devices[1].gateways.first?.frontDoor?.clientSecret == "door-b")
    #expect(world.devices[0].gateways.first?.sessionToken?.token == "tok-b")
  }
}
