import Foundation
import HermieGateway
import HermieProtocol
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/// Whatever iCloud Keychain holds after a reinstall, "Sync with iCloud" must not stop the process:
/// random records (well formed, half formed and damaged) at the keys of the gateways set up again,
/// then the disclosure answered and a few syncs run.
@MainActor
@Suite(.timeLimit(.minutes(5))) struct ReinstallFuzzTests {
  struct Generator: RandomNumberGenerator {
    var state: UInt64

    mutating func next() -> UInt64 {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
  }

  static let addresses = [
    "https://gateway.test", "https://lab.test", "http://127.0.0.1:8642", "https://x.test:8443/base",
    "https://GATEWAY.test/", "https://work.test"
  ]

  static func chance(_ p: Double, _ g: inout Generator) -> Bool { Double.random(in: 0..<1, using: &g) < p }

  static func pick<T>(_ items: [T], _ g: inout Generator) -> T { items[Int.random(in: 0..<items.count, using: &g)] }

  static func junk(_ g: inout Generator, depth: Int = 0) -> JSONValue {
    switch Int.random(in: 0..<(depth > 1 ? 5 : 7), using: &g) {
    case 0: return .null
    case 1: return .bool(chance(0.5, &g))
    case 2: return .number(pick([0, -1, 1.5, 1e300, -1e300, 9_007_199_254_740_992, startOfTime], &g))
    case 3: return .string(pick(["", " ", "x", "native_pkce", "session_token", "https://gateway.test", "\u{0}"], &g))
    case 4: return .string(String(repeating: "a", count: Int.random(in: 0..<40, using: &g)))
    case 5: return .array((0..<Int.random(in: 0..<3, using: &g)).map { _ in junk(&g, depth: depth + 1) })
    default:
      var object: JSONObject = [:]
      for _ in 0..<Int.random(in: 0..<4, using: &g) {
        let name = pick(["origin", "token", "kind", "clientId", "clientSecret", "headers", "name", "label", "z"], &g)
        object[name] = junk(&g, depth: depth + 1)
      }
      return .object(object)
    }
  }

  static func stamp(_ g: inout Generator) -> JSONObject {
    var object: JSONObject = [:]
    if chance(0.95, &g) {
      let times = [0, 1, startOfTime - 1, startOfTime, startOfTime + 1, startOfTime + year, SyncStamp.maximumT, -1, 1e300]
      object["t"] = .number(pick(times, &g))
    }
    if chance(0.95, &g) {
      object["d"] = .string(pick(["00000000", "ffffffff", "0a1b2c3d", "", "ZZ", "0000000000"], &g))
    }
    return object
  }

  static func value(_ field: SyncField, address: String, _ g: inout Generator) -> JSONValue {
    let origin = chance(0.8, &g) ? GatewayAddress.origin(of: address) : pick(addresses, &g)
    if chance(0.15, &g) { return junk(&g) }

    switch field {
    case .address: return .string(chance(0.85, &g) ? address : pick(addresses, &g))
    case .name: return .string(pick(["Home", "", "Lab", "hermes"], &g))
    case .authKind: return .string(pick(["native_pkce", "session_token", "cookie", "password"], &g))
    case .provider: return .object(["name": .string(pick(["self-hosted", "", "google"], &g)), "label": .string("L")])
    case .user: return .string(pick(["tester", ""], &g))
    case .frontDoor:
      return .object([
        "origin": .string(origin), "kind": .string("cloudflare-access"), "clientId": .string("id.access"),
        "clientSecret": .string(pick(["s", ""], &g))
      ])
    case .headers:
      return .object(["origin": .string(origin), "headers": .object(["X-Team": .string(pick(["a", " b", ""], &g))])])
    case .sessionToken: return .object(["origin": .string(origin), "token": .string(pick(["tok-old", ""], &g))])
    case .signIn, .addedAt: return junk(&g)
    }
  }

  static func record(at address: String, _ g: inout Generator) -> String {
    let key = GatewayKey.of(address)
    var root: JSONObject = ["v": .number(chance(0.92, &g) ? 1 : pick([0, 2, 1.5], &g)), "key": .string(key)]

    if chance(0.05, &g) { root["key"] = .string(GatewayKey.of(pick(addresses, &g))) }

    for field in SyncField.registers where chance(0.6, &g) {
      var register = stamp(&g)
      if chance(0.95, &g) { register["v"] = value(field, address: address, &g) }
      if chance(0.05, &g) { register["extra"] = junk(&g) }
      root[field.rawValue] = .object(register)
    }

    if chance(0.3, &g) { root["deleted"] = .object(stamp(&g)) }
    if chance(0.5, &g) { root["addedAt"] = .number(pick([startOfTime - day, 0, -5, 1e300], &g)) }
    if chance(0.1, &g) { root["future"] = junk(&g) }
    if chance(0.03, &g) { return "{" }

    return (try? JSONValue.object(root).canonicalString()) ?? "{}"
  }

  static func put(_ store: InMemorySyncedItemStore, at address: String, _ g: inout Generator) throws {
    let account = SyncedGatewayRecord.account(forKey: GatewayKey.of(address))
    try store.put(SyncedItem(account: account, value: record(at: address, &g)))
  }

  @Test(arguments: 0..<300)
  func syncWithICloudAfterAReinstallOverRandomRecords(_ seed: Int) async throws {
    var g = Generator(state: UInt64(seed) &* 7919 &+ 17)
    var world = try EngineWorld(2)
    try await world.discloseAll()

    // The earlier install, and another device, each with gateways of their own.
    for address in Self.addresses where Self.chance(0.4, &g) {
      try await addGateway(world[0], address: address, token: Self.chance(0.5, &g) ? "tok-old" : nil)
    }
    for address in Self.addresses where Self.chance(0.3, &g) {
      try await addGateway(world[1], address: address, token: Self.chance(0.5, &g) ? "tok-mac" : nil)
    }
    await world.settle()

    // Whatever else is in iCloud Keychain.
    let other = world.cloud.replica("seed")
    for address in Self.addresses where Self.chance(0.5, &g) {
      try Self.put(other, at: address, &g)
    }
    world.cloud.deliverAll()

    world[0] = EngineDevice(reinstalling: world[0])
    let screen = await ICloudSyncModelTests.Screen(world[0])
    await world[0].reconcile()
    screen.model.lookInICloud()
    await screen.idle()

    for address in Self.addresses where Self.chance(0.35, &g) {
      _ = try? await addGateway(world[0], address: address, token: Self.chance(0.5, &g) ? "tok-new" : nil)
    }
    await screen.idle()

    if Self.chance(0.3, &g), !screen.model.available.isEmpty, screen.model.setupCanUseAvailable {
      _ = await screen.model.useAvailable()
    } else {
      await screen.model.acceptDisclosure()
    }

    for _ in 0..<3 {
      if Self.chance(0.5, &g) {
        try Self.put(other, at: Self.pick(Self.addresses, &g), &g)
      }
      await world.settle(rounds: 4)
      await screen.idle()
    }

    let gateways = try await world[0].gateways()
    #expect(Set(gateways.map(\.id)).count == gateways.count)
  }
}
