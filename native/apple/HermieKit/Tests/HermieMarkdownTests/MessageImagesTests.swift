import Testing

@testable import HermieMarkdown

/// Which pictures a message holds: what is read from its text, what from its attachments, and what
/// is never a picture because this device must not fetch it.
@Suite struct MessageImagesTests {
  func refs(_ text: String) -> [String] {
    MessageImages.extract(from: text).map(\.reference)
  }

  @Test func aMarkdownImageOnTheGatewayIsAPicture() {
    let images = MessageImages.extract(from: "Look: ![a bar chart](/api/files/charts/weekly%20runs.png)")
    #expect(images.count == 1)
    #expect(images[0].reference == "/api/files/charts/weekly%20runs.png")
    #expect(images[0].name == "weekly runs.png")
    #expect(images[0].alt == "a bar chart")
    #expect(images[0].label == "a bar chart")
  }

  @Test func withoutAltTextTheNameIsTheLabel() {
    let image = MessageImages.extract(from: "![](/api/files/x.png)")[0]
    #expect(image.alt == nil)
    #expect(image.label == "x.png")
  }

  @Test func aMediaDeliveryOfAPictureIsAPicture() {
    #expect(refs("Done.\nMEDIA:/srv/out/chart.png") == ["/srv/out/chart.png"])
    #expect(refs("MEDIA:`/srv/out/shot 1.jpg`") == ["/srv/out/shot 1.jpg"])
  }

  @Test func aMediaDeliveryOfAFileIsNot() {
    #expect(refs("MEDIA:/srv/out/report.pdf").isEmpty)
  }

  @Test func aLinkToAPictureOnTheGatewayIsAPicture() {
    #expect(refs("See [the chart](/api/files/c.webp).") == ["/api/files/c.webp"])
    #expect(refs("See [the page](/api/files/c.html).").isEmpty)
  }

  @Test func aMarkdownImageServedWithoutAnExtensionIsStillOne() {
    #expect(refs("![x](/api/files/abc123)") == ["/api/files/abc123"])
    // Outside the gateway's files an extension is what says it is a picture.
    #expect(refs("![x](/srv/out/abc123)").isEmpty)
    #expect(refs("![x](/srv/out/abc123.PNG)") == ["/srv/out/abc123.PNG"])
  }

  @Test func theWebIsNeverFetched() {
    #expect(refs("![x](https://example.com/a.png)").isEmpty)
    #expect(refs("![x](http://example.com/a.png)").isEmpty)
    #expect(refs("![x](data:image/png;base64,AAAA)").isEmpty)
    #expect(refs("![x](file:///etc/passwd.png)").isEmpty)
    #expect(refs("![x](//example.com/a.png)").isEmpty)
    #expect(refs("![x](C:\\Users\\a.png)").isEmpty)
    #expect(refs("![x](javascript:alert(1))").isEmpty)
  }

  @Test func codeIsNotAMessageAboutAPicture() {
    #expect(refs("Write `![x](/api/files/a.png)` to embed it.").isEmpty)
    #expect(refs("```md\n![x](/api/files/a.png)\n```").isEmpty)
    #expect(refs("~~~\n![x](/api/files/a.png)\n~~~\n\n![y](/api/files/b.png)") == ["/api/files/b.png"])
  }

  @Test func titlesAndAngleBracketsAreNotPartOfThePath() {
    #expect(refs("![x](/api/files/a.png \"A title\")") == ["/api/files/a.png"])
    #expect(refs("![x](</api/files/my pic.png>)") == ["/api/files/my pic.png"])
  }

  @Test func repeatsAreOnePicture() {
    #expect(refs("![a](/api/files/a.png) and again ![a](/api/files/a.png)") == ["/api/files/a.png"])
  }

  @Test func severalKeepTheirOrder() {
    #expect(refs("![1](/api/files/1.png)\n\n![2](/api/files/2.png)\nMEDIA:/srv/3.gif") == ["/api/files/1.png", "/api/files/2.png", "/srv/3.gif"])
  }

  @Test func aTraversalIsCarriedAsWrittenForTheOpenerToRefuse() {
    // This only names the picture; whether it can be opened is `AttachmentOpening`'s decision, which
    // refuses a path that leaves the gateway's files.
    #expect(refs("![x](/api/files/../../etc/a.png)") == ["/api/files/../../etc/a.png"])
  }

  @Test func plainTextHasNone() {
    #expect(MessageImages.extract(from: "").isEmpty)
    #expect(MessageImages.extract(from: "Just words, and a [link](/api/files/a.pdf).").isEmpty)
    #expect(MessageImages.extract(from: "![unterminated](/api/files/a.png").isEmpty)
  }

  @Test func theDocumentKnowsItsPictures() {
    var document = MarkdownDocument("Here: ![x](/api/files/a.png")
    #expect(document.images.isEmpty, "not closed yet")
    document.append(")")
    #expect(document.images.map(\.reference) == ["/api/files/a.png"])
    document.update(text: "Gone.")
    #expect(document.images.isEmpty)
  }

  // MARK: Attachments

  @Test func attachmentsSplitIntoPicturesAndTheRest() {
    let split = MessageImages.split(attachments: [
      "@image:/api/files/a.png", "@file:/api/files/report.pdf", "@file:/api/files/b.JPG", "@image:\"/api/files/c d.heic\""
    ])
    #expect(split.images.map(\.name) == ["a.png", "b.JPG", "c d.heic"])
    #expect(split.images.map(\.reference) == ["@image:/api/files/a.png", "@file:/api/files/b.JPG", "@image:\"/api/files/c d.heic\""])
    #expect(split.others == ["@file:/api/files/report.pdf"])
  }

  @Test func aPictureSentJustNowIsAChipUntilItHasAPath() {
    // The reference of a turn the owner has just sent holds the file's name only.
    let split = MessageImages.split(attachments: ["@image:shot.png"])
    #expect(split.images.isEmpty)
    #expect(split.others == ["@image:shot.png"])
  }

  @Test func aPictureOnTheDevicesOwnDiskIsOne() {
    let split = MessageImages.split(attachments: ["@image:/Users/me/Desktop/shot.png"])
    #expect(split.images.map(\.name) == ["shot.png"])
  }

  @Test func twoNamesForOneFileAreOnePicture() {
    let attached = MessageImages.split(attachments: ["@image:/api/files/a.png"]).images
    let named = MessageImages.extract(from: "![a](/api/files/a.png)")
    #expect(MessageImages.unique(attached + named).count == 1)
    #expect(MessageImages.unique(attached + named).first?.reference == "@image:/api/files/a.png")
  }

  @Test func extensionsAreRecognisedWithAQueryAndInAnyCase() {
    #expect(MessageImages.isImagePath("/api/files/a.PNG"))
    #expect(MessageImages.isImagePath("/api/files/a.jpeg?size=large"))
    #expect(!MessageImages.isImagePath("/api/files/a.svg"))
    #expect(!MessageImages.isImagePath("/api/files/png"))
    #expect(!MessageImages.isImagePath("/api/files/a."))
  }
}
