import Foundation
import Testing

/// The software passkey authenticator signs whatever it is handed with a key in memory. It belongs
/// to the tests (`HermiePasskeyTesting`), never to a target an app or an extension links.
@Suite struct SoftAuthenticatorPlacementTests {
  static var sources: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // Passkey
      .deletingLastPathComponent()  // HermieCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // HermieKit
      .appendingPathComponent("Sources", isDirectory: true)
  }

  @Test("no library target an app links declares the software authenticator")
  func notInSources() throws {
    let enumerator = FileManager.default.enumerator(at: Self.sources, includingPropertiesForKeys: nil)
    var files = 0
    var declaring: [String] = []

    while let url = enumerator?.nextObject() as? URL {
      guard url.pathExtension == "swift" else { continue }
      files += 1
      let text = try String(contentsOf: url, encoding: .utf8)

      if text.contains("class SoftPasskeyAuthenticator") || text.contains("struct SoftPasskeyAuthenticator") {
        declaring.append(url.lastPathComponent)
      }
    }

    #expect(files > 100, "the scan found the sources")
    #expect(declaring.isEmpty, "declared in \(declaring)")
  }
}
