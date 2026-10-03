import Foundation
import Testing

@testable import HermieCore

/// The rules of `attachments.ts` and `file-upload.ts`, held by the native copy.
@Suite struct AttachmentRulesTests {
  @Test func theCapsAreTheGatewaysOwn() {
    #expect(AttachmentRules.maxImageBytes == 25 * 1024 * 1024)
    #expect(AttachmentRules.maxFileBytes == 100 * 1024 * 1024)
  }

  @Test(arguments: [
    ("photo.png", "image/png", "photo.png"),
    ("SHOT.PNG", nil, "SHOT.PNG"),
    ("a.jpeg", "image/jpeg", "a.jpeg"),
    ("scan.tif", "", "scan.tif"),
    ("anim.gif", "image/gif", "anim.gif")
  ] as [(String, String?, String?)])
  func anImageByItsExtensionTakesTheImageRoad(name: String, type: String?, expected: String?) {
    #expect(AttachmentRules.imageName(for: name, mimeType: type) == expected)
  }

  @Test(arguments: [
    ("logo.svg", "image/svg+xml"),
    ("favicon.ico", "image/x-icon"),
    ("photo.heic", "image/heic"),
    ("notes.txt", "text/plain"),
    ("fake.png", "text/plain"),
    ("report.pdf", "application/pdf")
  ])
  func anythingElseTakesTheFileRoad(name: String, type: String) {
    #expect(AttachmentRules.imageName(for: name, mimeType: type) == nil)
  }

  @Test func aNamelessImageIsGivenTheExtensionOfItsType() {
    #expect(AttachmentRules.imageName(for: "", mimeType: "image/png") == "image.png")
    #expect(AttachmentRules.imageName(for: "Screenshot", mimeType: "image/jpeg") == "Screenshot.jpg")
    #expect(AttachmentRules.imageName(for: "blob", mimeType: nil) == nil)
    #expect(AttachmentRules.imageName(for: "blob", mimeType: "application/octet-stream") == nil)
  }

  @Test(arguments: [
    ("../../etc/passwd", "passwd"),
    ("C:\\Users\\me\\report.pdf", "report.pdf"),
    ("my report (final).pdf", "my-report-final-.pdf"),
    (".hidden", "hidden"),
    ("---x", "x"),
    ("a   b", "a-b"),
    ("é.txt", "txt"),
    ("tab\tin.txt", "tab-in.txt"),
    ("", "attachment"),
    ("///", "attachment"),
    ("...", "attachment")
  ])
  func aNameCannotClimbOutOfItsFolder(name: String, expected: String) {
    #expect(AttachmentRules.sanitisedName(name) == expected)
  }

  @Test func aLongNameIsCutAtEightyCharacters() {
    #expect(AttachmentRules.sanitisedName(String(repeating: "a", count: 200)).count == 80)
  }

  @Test func theUploadPathIsUnderTheWorkspaceByDateWithATokenAndTheNameKept() throws {
    let day = try #require(
      Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 10, day: 3, hour: 12)))

    #expect(
      AttachmentRules.uploadPath(cwd: "/work/space", name: "my notes.txt", now: day, token: "abc12345")
        == "/work/space/uploads/hermie/2026-10-03/abc12345-my-notes.txt")
    #expect(
      AttachmentRules.uploadPath(cwd: "/work/space///", name: "a.pdf", now: day, token: "t")
        == "/work/space/uploads/hermie/2026-10-03/t-a.pdf", "trailing slashes do not double")

    let random = try #require(AttachmentRules.uploadPath(cwd: "/w", name: "a.pdf", now: day))
    #expect(random.hasPrefix("/w/uploads/hermie/2026-10-03/"))
    #expect(random.hasSuffix("-a.pdf"))
  }

  @Test(arguments: [nil, "", "/", "//", "///"] as [String?])
  func noWorkspaceMeansNoPathNotTheRootOfTheMachine(cwd: String?) {
    #expect(AttachmentRules.uploadPath(cwd: cwd, name: "a.pdf") == nil)
  }

  @Test func aPathWithWhitespaceIsWrappedInBackticks() {
    #expect(AttachmentRules.fileReference(path: "/w/a.pdf") == "@file:/w/a.pdf")
    #expect(AttachmentRules.fileReference(path: "/w/my docs/a.pdf") == "@file:`/w/my docs/a.pdf`")
    #expect(AttachmentRules.imageReference(name: "shot.png") == "@image:shot.png")
    #expect(AttachmentRules.imageReference(name: "my shot.png") == "@image:`my shot.png`")
  }

  @Test func theReferencesFollowTheWordsAfterABlankLine() {
    #expect(AttachmentRules.withFileReferences("look", paths: []) == "look")
    #expect(AttachmentRules.withFileReferences("look  ", paths: ["/w/a"]) == "look\n\n@file:/w/a")
    #expect(AttachmentRules.withFileReferences("", paths: ["/w/a", "/w/b c"]) == "@file:/w/a\n@file:`/w/b c`")
  }

  @Test func anOutgoingAttachmentNamesItselfTheWayTheRowWill() {
    #expect(OutgoingAttachment.image(filename: "a.png", base64: "AAAA").reference == "@image:a.png")
    #expect(OutgoingAttachment.file(filename: "a.pdf", path: "/w/x-a.pdf").reference == "@file:/w/x-a.pdf")
    #expect(OutgoingAttachment.image(filename: "a.png", base64: "AAAA").filePath == nil)
    #expect(OutgoingAttachment.file(filename: "a.pdf", path: "/w/x-a.pdf").filePath == "/w/x-a.pdf")
  }
}
