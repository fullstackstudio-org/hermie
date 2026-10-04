import Foundation
import Testing

@testable import HermieCore

/// An image attached to a chat is asked of the gateway's own route (`GET /api/files/images/<name>?profile=`)
/// first, and only when its path is in that chat's profile's own `images/` folder; every other path keeps the
/// files and media routes.
@Suite("Attached chat images", .timeLimit(.minutes(1))) @MainActor
struct AttachedImageRouteTests {
  private nonisolated static let home = "/root/.hermes"
  private nonisolated static let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

  // MARK: Which path is asked for

  @Test("a path in the default profile's images folder is the route, as the default profile")
  func defaultProfile() {
    #expect(
      AttachmentOpening.attachedImagePath("@image:\(Self.home)/images/upload_20261004_160406_1.png", profile: "default")
        == "/api/files/images/upload_20261004_160406_1.png?profile=default")
    #expect(
      AttachmentOpening.attachedImagePath("@image:\"\(Self.home)/images/upload_1.JPG\"", profile: "default")
        == "/api/files/images/upload_1.JPG?profile=default")
    #expect(
      AttachmentOpening.attachedImagePath("\(Self.home)/images/a-b_c.webp", profile: "default")
        == "/api/files/images/a-b_c.webp?profile=default")
  }

  @Test("a path in a named profile's own images folder is the route, as that profile")
  func namedProfile() {
    #expect(
      AttachmentOpening.attachedImagePath("@image:\(Self.home)/profiles/researcher/images/upload_2.png", profile: "researcher")
        == "/api/files/images/upload_2.png?profile=researcher")
  }

  @Test("another profile's folder is never asked for, in either direction")
  func otherProfiles() {
    let paths: [(String, String)] = [
      ("\(Self.home)/images/upload_1.png", "researcher"),
      ("\(Self.home)/profiles/writer/images/upload_1.png", "researcher"),
      ("\(Self.home)/profiles/writer/images/upload_1.png", "default"),
      ("\(Self.home)/profiles/researcher/images/upload_1.png", "default"),
      ("\(Self.home)/researcher/images/upload_1.png", "researcher"),
      ("\(Self.home)/profiles/researcher2/images/upload_1.png", "researcher"),
      ("\(Self.home)/profiles/researcher/x/images/upload_1.png", "researcher")
    ]

    for (path, profile) in paths {
      #expect(AttachmentOpening.attachedImagePath(path, profile: profile) == nil, "\(path) for \(profile)")
    }
  }

  @Test("a nested path, or a file that is not directly in images/, is never asked for")
  func nested() {
    for path in [
      "\(Self.home)/images/sub/upload_1.png", "\(Self.home)/images/images/upload_1.png",
      "\(Self.home)/workspace/upload_1.png", "\(Self.home)/images", "/images/upload_1.png"
    ] {
      #expect(AttachmentOpening.attachedImagePath(path, profile: "default") == nil, "\(path)")
    }
  }

  @Test("what the route would not serve, and a path that cannot be trusted, are never asked for")
  func refused() {
    for path in [
      "\(Self.home)/images/upload_1.heic", "\(Self.home)/images/upload_1.pdf", "\(Self.home)/images/upload_1",
      "\(Self.home)/images/.hidden.png", "\(Self.home)/images/a..b.png", "\(Self.home)/images/my shot.png",
      "\(Self.home)/images/up%2Fload.png", "\(Self.home)/images/a.png?x=1", "\(Self.home)/images/a.png#top",
      "\(Self.home)/../images/a.png", "\(Self.home)/./images/a.png", "\(Self.home)//images/a.png",
      "\(Self.home)\\images\\a.png", "//host\(Self.home)/images/a.png", "images/a.png",
      "https://example.com/images/a.png", "/api/files/images/a.png", "\(Self.home)/images/a\0.png"
    ] {
      #expect(AttachmentOpening.attachedImagePath(path, profile: "default") == nil, "\(path)")
    }

    // A profile name the gateway would not take is not put in an address.
    #expect(AttachmentOpening.attachedImagePath("\(Self.home)/images/a.png", profile: "Not A Profile") == nil)
    #expect(AttachmentOpening.attachedImagePath("\(Self.home)/images/a.png", profile: "") == nil)
  }

  // MARK: What the session asks

  @Test("the session asks the attached-image route first, as the chat's profile, and nothing else when it answers")
  func fetchedByTheRoute() async throws {
    let harness = SessionHarness()
    let route = "/api/files/images/upload_1.png?profile=default"
    harness.link.setFiles { $0 == route ? Self.png : nil }

    guard case .preview(let url) = await harness.session.prepareAttachment("@image:\(Self.home)/images/upload_1.png", profile: "default")
    else {
      Issue.record("expected a preview")
      return
    }

    #expect(url.lastPathComponent == "upload_1.png")
    #expect(try Data(contentsOf: url) == Self.png)
    #expect(harness.link.fileCalls == [route])
    #expect(!harness.link.fileCalls.joined().contains("token"), "no credential in an address")

    AttachmentOpening.discardOpened(gateway: harness.session.gatewayID)
    await harness.session.shutdown()
  }

  @Test("a path in another profile's folder, a nested one, and a chat with no profile keep the existing routes")
  func existingRoutes() async throws {
    let harness = SessionHarness()
    let writer = "\(Self.home)/profiles/writer/images/upload_1.png"
    let nested = "\(Self.home)/images/sub/upload_1.png"
    harness.link.setFiles { $0.hasPrefix("/api/files/download?path=") ? Self.png : nil }

    for (reference, profile) in [("@image:\(writer)", "researcher"), ("@image:\(nested)", "default"), ("@image:\(Self.home)/images/a.png", nil)]
      as [(String, String?)]
    {
      guard case .preview(let url) = await harness.session.prepareAttachment(reference, profile: profile) else {
        Issue.record("expected a preview for \(reference)")
        continue
      }
      try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }

    #expect(
      harness.link.fileCalls == [
        "/api/files/download?path=\(writer)", "/api/files/download?path=\(nested)",
        "/api/files/download?path=\(Self.home)/images/a.png"
      ], "the attached-image route is asked of none of them")
    await harness.session.shutdown()
  }

  @Test("the gateway has no such image: the existing routes are tried, and then it is a refusal the reader is told")
  func notFound() async {
    let harness = SessionHarness()
    harness.link.setFiles { _ in nil }

    #expect(
      await harness.session.prepareAttachment("@image:\(Self.home)/images/gone.png", profile: "default")
        == .failed(name: "gone.png"))
    #expect(
      harness.link.fileCalls == [
        "/api/files/images/gone.png?profile=default", "/api/files/download?path=\(Self.home)/images/gone.png",
        "/api/media?path=\(Self.home)/images/gone.png"
      ])
    await harness.session.shutdown()
  }

  // MARK: The placeholder

  @Test("the [image] line of an unnamed image is a chip with nothing to open")
  func placeholder() {
    #expect(AttachmentOpening.target(for: "@image:Image", localFiles: true, fileExists: { _ in false }) == .unavailable(name: "Image"))
    #expect(AttachmentOpening.attachedImagePath("@image:Image", profile: "default") == nil)
  }
}
