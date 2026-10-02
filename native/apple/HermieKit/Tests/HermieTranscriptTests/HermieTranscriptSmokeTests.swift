import Testing

@testable import HermieTranscript

@Test func moduleLinksItsDependencies() {
  #expect(HermieTranscriptModule.name == "HermieTranscript")
  #expect(HermieTranscriptModule.dependencies == ["HermieProtocol"])
}
