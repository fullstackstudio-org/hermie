import Foundation
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/// The one label a gateway goes by (its name, else its host) and the title the chat list shows.
@MainActor
@Suite("Gateway label") struct GatewayLabelTests {
  private actor NoSync: GatewayListSync {
    func removeGateway(id: String, scope: RemovalScope) async throws {}
    func trigger(_ reason: SyncReason) async {}
  }

  private func record(_ id: String, name: String, address: String) -> GatewayRecord {
    GatewayRecord(id: id, name: name, address: address, authKind: .nativePKCE, addedAt: 1)
  }

  private func directory(_ records: [GatewayRecord], active: String?) throws -> GatewayDirectory {
    let database = try SQLiteStore(.inMemory)
    let directory = GatewayDirectory(
      store: GatewayRegistryStore(store: database), changes: KeyValueStore(store: database), remover: NoSync())

    directory.apply(GatewayRegistry(gateways: records, activeGatewayId: active))
    return directory
  }

  @Test func anUnnamedGatewayGoesByItsHost() {
    let entry = GatewayDirectory.Entry(
      GatewayRecord(
        id: "g1", name: "", address: "https://hermes.fullstackstudio.nl/", authKind: .nativePKCE, addedAt: 1))

    #expect(entry.displayLabel == "hermes.fullstackstudio.nl")
    #expect(entry.customName == nil)
    #expect(entry.host == "hermes.fullstackstudio.nl")
  }

  @Test func aGatewayNamedAsItsHostCountsAsUnnamed() {
    let entry = GatewayDirectory.Entry(
      record("g1", name: "hermes.example.com", address: "https://hermes.example.com"))

    #expect(entry.customName == nil)
  }

  @Test func aNamedGatewayGoesByItsName() {
    let entry = GatewayDirectory.Entry(record("g1", name: "  Studio  ", address: "https://hermes.example.com"))

    #expect(entry.displayLabel == "Studio")
    #expect(entry.customName == "Studio")
    #expect(entry.host == "hermes.example.com")
  }

  @Test func oneGatewayLeavesTheListUntitled() throws {
    let directory = try directory([record("g1", name: "Studio", address: "https://a.example.com")], active: "g1")

    #expect(directory.chatListTitle(showing: "g1") == nil)
  }

  @Test func twoGatewaysTitleTheListWithTheShownOnesLabel() throws {
    let directory = try directory(
      [
        record("g1", name: "Studio", address: "https://a.example.com"),
        record("g2", name: "", address: "https://b.example.com"),
      ], active: "g1")

    #expect(directory.chatListTitle(showing: "g1") == "Studio")
    #expect(directory.chatListTitle(showing: "g2") == "b.example.com")
    #expect(directory.chatListTitle(showing: nil) == "Studio")
  }
}
