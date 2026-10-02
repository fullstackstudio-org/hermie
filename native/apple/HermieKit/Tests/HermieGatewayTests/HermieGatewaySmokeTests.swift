import Testing

@testable import HermieGateway

@Test func moduleLinksItsDependencies() {
  #expect(HermieGatewayModule.name == "HermieGateway")
  #expect(HermieGatewayModule.dependencies == ["HermieProtocol"])
}
