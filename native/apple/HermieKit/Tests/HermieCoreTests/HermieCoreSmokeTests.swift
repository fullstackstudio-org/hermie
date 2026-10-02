import Testing

@testable import HermieCore

@Test func moduleLinksEveryLayerBelowIt() {
  #expect(
    HermieCoreModule.dependencies == [
      "HermieProtocol",
      "HermieTranscript",
      "HermieGateway",
      "HermieStore",
      "HermieShared",
      "HermieMarkdown"
    ]
  )
}

@Test func buildInfoReadsTheInfoPlistKeys() {
  let info = BuildInfo(infoDictionary: [
    "CFBundleShortVersionString": "0.2.0",
    "CFBundleVersion": "512",
    "HermieCommit": "1a2b3c4"
  ])
  #expect(info == BuildInfo(version: "0.2.0", build: "512", commit: "1a2b3c4"))
  #expect(info.summary == "Version 0.2.0 (512) · 1a2b3c4")
}

@Test func buildInfoFallsBackWhenAKeyIsMissingOrEmpty() {
  let info = BuildInfo(infoDictionary: ["CFBundleVersion": "  ", "HermieCommit": 7])
  #expect(info == BuildInfo(version: "0.0.0", build: "1", commit: "dev"))
  #expect(BuildInfo(infoDictionary: nil) == info)
}
