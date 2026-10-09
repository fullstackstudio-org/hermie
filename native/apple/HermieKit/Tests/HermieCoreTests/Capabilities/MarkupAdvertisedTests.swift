import HermieGateway
import Testing

@testable import HermieCore

/// What the app tells the gateway it draws in a reply (`client.capabilities` `markup`).
@Suite struct MarkupAdvertisedTests {
  @MainActor
  @Test("a session announces exactly a chart, cards and alerts by default")
  func byDefault() {
    #expect(GatewaySession.Options().markup == ["chart", "cards", "alerts"])
    #expect(MarkupAdvertisement.supported == ["chart", "cards", "alerts"])
  }
}
