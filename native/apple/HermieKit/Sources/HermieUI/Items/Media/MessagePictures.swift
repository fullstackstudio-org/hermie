import HermieMarkdown
import HermieTranscript

extension MessageImages {
  /// What a message shows under its words: the pictures (thumbnails) and the references that stay chips.
  struct Pictures: Equatable {
    var images: [MessageImage]
    var chips: [String]
  }

  /// Splits what a message holds into thumbnails and chips.
  ///
  /// - `inline`: pictures the transcript lifted out of the text (a `data:` blob), drawn from the bytes
  ///   the message already has;
  /// - `attachments`: `@file:` / `@image:` references, among them the handle the gateway wrote for an
  ///   image a person attached (`[Image attached at: <path>]`), which is fetched through the gateway;
  /// - `named`: the pictures the Markdown names.
  ///
  /// Without a store (a view outside a chat screen) nothing can be loaded, so every picture is a chip.
  static func pictures(
    itemID: String, inline: [InlineImage], attachments: [String], named: [MessageImage], hasStore: Bool
  ) -> Pictures {
    guard hasStore else {
      return Pictures(images: [], chips: attachments + inline.map { "@image:\($0.name)" })
    }

    let split = split(attachments: attachments)
    let held = inline.enumerated().map { index, picture in
      MessageImage.inline(item: itemID, index: index, name: picture.name, base64: picture.data)
    }
    return Pictures(images: unique(held + split.images + named), chips: split.others)
  }
}
