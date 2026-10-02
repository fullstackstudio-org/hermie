import HermieCore
import SwiftUI
import Testing

@testable import HermieUI

@Test func moduleLinksItsDependencies() {
  #expect(HermieUIModule.dependencies == ["HermieCore", "HermieMarkdown"])
}

@MainActor
@Test func placeholderRendersTheBuildItIsGiven() {
  let renderer = ImageRenderer(
    content: PlaceholderView(info: BuildInfo(version: "0.2.0", build: "512", commit: "1a2b3c4"))
      .frame(width: 320, height: 480)
  )
  #expect(renderer.cgImage != nil)
}
