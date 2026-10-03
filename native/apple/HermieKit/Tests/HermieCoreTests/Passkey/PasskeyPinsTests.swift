import Foundation
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/// The pins in the launch's key-value store: one key per stored gateway, removed with it.
@Suite struct PasskeyPinsTests {
  static func gatewayID(_ index: Int) -> String {
    "g" + String(format: "%02x", index)
  }

  @Test("twenty sessions saving their pins at once all keep them")
  func concurrentSaves() async throws {
    let pins = KeyValuePasskeyPins(store: KeyValueStore(store: try SQLiteStore(.inMemory)))

    await withTaskGroup(of: Void.self) { group in
      for index in 0..<20 {
        group.addTask {
          await pins.save(PasskeyPinRecord(gatewayID: "id-\(index)", seenAt: 1), for: Self.gatewayID(index))
        }
      }
    }

    for index in 0..<20 {
      #expect(await pins.record(for: Self.gatewayID(index)).gatewayID == "id-\(index)", "gateway \(index)")
    }
  }

  @Test("removing a gateway removes its pins")
  func purgedWithTheGateway() async throws {
    let database = try SQLiteStore(.inMemory)
    let registry = GatewayRegistryStore(store: database)
    let pins = KeyValuePasskeyPins(store: KeyValueStore(store: database))

    try await registry.add(GatewayRecord(id: "g0a", name: "Home", address: "https://gw.example.com", authKind: .nativePKCE, addedAt: 1))
    try await registry.add(GatewayRecord(id: "g0b", name: "Work", address: "https://gw.example.org", authKind: .nativePKCE, addedAt: 2))
    await pins.save(PasskeyPinRecord(gatewayID: "home", seenAt: 1), for: "g0a")
    await pins.save(PasskeyPinRecord(gatewayID: "work", seenAt: 1), for: "g0b")

    try await registry.remove(id: "g0a")

    #expect(await pins.record(for: "g0a") == PasskeyPinRecord())
    #expect(await pins.record(for: "g0b").gatewayID == "work")
    #expect(await pins.others(except: "g0b").isEmpty)
  }

  @Test("an undecodable record is reported as such and survives every other gateway's save")
  func undecodableKept() async throws {
    let values = KeyValueStore(store: try SQLiteStore(.inMemory))
    let pins = KeyValuePasskeyPins(store: values)
    try await values.setString("[1, 2", forKey: KeyValuePasskeyPins.key(for: "g0a"))

    await pins.save(PasskeyPinRecord(gatewayID: "work", seenAt: 1), for: "g0b")

    #expect(await pins.read("g0a") == .unreadable)
    #expect(try await values.string(forKey: KeyValuePasskeyPins.key(for: "g0a")) == "[1, 2")
    #expect(await pins.others(except: "g0b") == [PasskeyOtherPin(storedGatewayID: "g0a", name: nil, record: nil)])
  }

  @Test("the other gateways come with their names from the gateway list, and a pin without one has none")
  func othersNamed() async throws {
    let database = try SQLiteStore(.inMemory)
    let registry = GatewayRegistryStore(store: database)
    let pins = KeyValuePasskeyPins(store: KeyValueStore(store: database))

    try await registry.add(GatewayRecord(id: "g0a", name: "Home (LAN)", address: "http://gw.lan.example:9119", authKind: .nativePKCE, addedAt: 1))
    await pins.save(PasskeyPinRecord(gatewayID: "home", seenAt: 1), for: "g0a")
    await pins.save(PasskeyPinRecord(gatewayID: "gone", seenAt: 1), for: "g0c")

    let others = await pins.others(except: "g0b")
    #expect(others.map(\.storedGatewayID) == ["g0a", "g0c"])
    #expect(others.map(\.name) == ["Home (LAN)", nil])
    #expect(others.map(\.record?.gatewayID) == ["home", "gone"])
  }

  @Test("records written before linked_gateway_ids existed still decode")
  func olderRecord() throws {
    let text = #"{"gateway_id":"abc","known_credential_ids":["x"],"app_credential_ids":["x"],"seen_at":5}"#
    let record = try JSONDecoder().decode(PasskeyPinRecord.self, from: Data(text.utf8))
    #expect(record == PasskeyPinRecord(gatewayID: "abc", knownCredentialIDs: ["x"], appCredentialIDs: ["x"], seenAt: 5))
  }
}
