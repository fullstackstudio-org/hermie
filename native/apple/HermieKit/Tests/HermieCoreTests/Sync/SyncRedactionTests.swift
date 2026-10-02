import Foundation
import HermieGateway
import Testing

@testable import HermieCore

/// No credential value may reach a description, a debug description, a mirror (`dump`, test
/// failure output) or an error: they end up in logs, crash reports and CI output.
@Suite struct SyncRedactionTests {
  static let token = "TOKEN-MARKER-5c1d"
  static let doorSecret = "DOOR-MARKER-9e2b"
  static let headerValue = "HEADER-MARKER-7a4f"
  static let markers = [token, doorSecret, headerValue]

  static func everyRendering(of value: Any) -> [String] {
    var dumped = ""
    dump(value, to: &dumped)
    return [String(describing: value), String(reflecting: value), dumped, String(describingForTest: value)]
  }

  @Test func noCredentialValueAppearsInAnyRendering() throws {
    var world = SyncWorld(devices: 2)
    let id = world.add(0, address: "https://gateway.test", token: Self.token, frontDoorSecret: Self.doorSecret)
    world.edit(0, id) { $0.headers = SyncHeaders(origin: "https://gateway.test", headers: ["X-Team": Self.headerValue]) }
    let publish = world.plan(0)
    world.apply(publish, to: 0)
    world.cloud.deliverAll()
    let adopt = world.plan(1)
    world.apply(adopt, to: 1)

    let record = try #require(world.cloudRecord(key: GatewayKey.of("https://gateway.test")))
    // The marker really is in there: the record must carry it, only never print it.
    #expect(Self.markers.allSatisfy { try! record.encoded().contains($0) })

    let gateway = try #require(world.devices[1].gateways.first)
    let rendered: [Any] = [
      record, record.registers[.sessionToken] as Any, record.registers.values.map { $0 },
      record.frontDoor as Any, record.headers as Any, record.sessionToken as Any,
      gateway, [gateway], world.snapshot(1), publish, adopt, adopt.localOps, adopt.events, adopt.state,
      adopt.state.entries.values.map { $0 }, publish.remotePuts,
      SyncCodingError.nonFiniteNumber, SyncLocalOp.update(gateway, fields: [.sessionToken])
    ]

    for value in rendered {
      for text in Self.everyRendering(of: value) {
        for marker in Self.markers {
          #expect(!text.contains(marker), "a rendering of \(type(of: value)) shows a credential")
        }
      }
    }
  }

  @Test func thePrintsInTheStateAreNotTheValues() throws {
    var world = SyncWorld(devices: 1)
    world.add(0, address: "https://gateway.test", token: Self.token, frontDoorSecret: Self.doorSecret)
    world.reconcile(0)

    let text = try world.devices[0].state.encoded()
    for marker in Self.markers {
      #expect(!text.contains(marker))
    }
  }
}
