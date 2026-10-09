import Foundation
import HermieCore
import UniformTypeIdentifiers

/// What a dropped item really is, once its bytes are in hand.
///
/// A sender that has no file URL to give (a promised file, a browser, Mail, an app's own drag) says
/// what it holds with whatever type identifier it likes, and often with a generic one
/// (`public.data`, `public.image`) and no name. Asking for that type gives the right bytes, but
/// the type says nothing of them: a PDF came out as "Image 2026-10-05 at 13.25.50", no extension,
/// no MIME type. So the file's own evidence is read, in this order:
///
/// 1. its first bytes, for the formats whose signature is certain (PDF, PNG, JPEG, GIF, WebP);
/// 2. the extension of the name it came with;
/// 3. the type the sender declared, when that one is specific (not a catch-all);
/// 4. text, when the bytes are UTF-8 with no NUL in them;
/// 5. nothing: an unknown file keeps its name and goes as a plain file.
enum DroppedFileType {
  /// How many bytes at the start of a file are looked at.
  nonisolated static let headLength = 512

  /// The types that name no format: asked for, they say nothing about what came back.
  nonisolated static let catchAll: [UTType] = [.item, .data, .content, .image, .compositeContent]

  nonisolated static func isCatchAll(_ type: UTType) -> Bool {
    catchAll.contains(type)
  }

  // MARK: Reading the evidence

  /// The format `head` (the first bytes of a file) proves, nil when none of the certain signatures fits.
  nonisolated static func sniff(_ head: Data) -> UTType? {
    let bytes = [UInt8](head.prefix(16))

    func starts(_ signature: [UInt8], at offset: Int = 0) -> Bool {
      bytes.count >= offset + signature.count && Array(bytes[offset..<offset + signature.count]) == signature
    }

    if starts(Array("%PDF-".utf8)) {
      return .pdf
    }
    if starts([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
      return .png
    }
    if starts([0xFF, 0xD8, 0xFF]) {
      return .jpeg
    }
    if starts(Array("GIF87a".utf8)) || starts(Array("GIF89a".utf8)) {
      return .gif
    }
    if starts(Array("RIFF".utf8)) && starts(Array("WEBP".utf8), at: 8) {
      return .webP
    }

    return nil
  }

  /// Whether `head` reads as text: UTF-8, nothing in it that is not.
  nonisolated static func looksLikeText(_ head: Data) -> Bool {
    guard !head.isEmpty, !head.contains(0) else {
      return false
    }

    // A read that stops inside a multi-byte character is not binary: the cut-off tail is dropped.
    for cut in 0...min(3, head.count - 1) {
      if String(data: head.dropLast(cut), encoding: .utf8) != nil {
        return true
      }
    }

    return false
  }

  /// The specific type an extension names, nil for none, or one the system makes up on the spot.
  nonisolated static func type(forExtension ext: String) -> UTType? {
    guard !ext.isEmpty, let type = UTType(filenameExtension: ext), !type.isDynamic else {
      return nil
    }

    return type
  }

  // MARK: Deciding

  /// What the item is. `names` are the file names it came with, the sender's own first.
  nonisolated static func resolve(declared: UTType?, names: [String?], head: Data) -> UTType? {
    if let proven = sniff(head) {
      return proven
    }

    for name in names {
      if let name, let named = type(forExtension: (name as NSString).pathExtension.lowercased()) {
        return named
      }
    }

    if let declared, !isCatchAll(declared), !declared.isDynamic {
      return declared
    }

    return looksLikeText(head) ? .plainText : nil
  }

  /// The name the attachment goes under: the sender's name, else the copy's own, else a plain
  /// "Attachment" (or a dated "Image …" only for a picture), with the extension `type` gives it
  /// when the name has none, or has one that belongs to another format.
  nonisolated static func name(suggested: String?, fileName: String?, resolved type: UTType?, now: Date = Date()) -> String {
    let base: String

    if let suggested, !suggested.isEmpty {
      base = suggested
    } else if let fileName, !fileName.isEmpty {
      base = fileName
    } else if type?.conforms(to: .image) == true {
      base = AttachmentIntake.defaultImageName(now: now)
    } else {
      base = NativeStrings.Composer.Attach.item
    }

    guard let type, let ext = type.preferredFilenameExtension else {
      return base
    }

    let current = (base as NSString).pathExtension

    if current.isEmpty {
      return "\(base).\(ext)"
    }

    guard let named = Self.type(forExtension: current.lowercased()) else {
      // Not an extension the system knows ("Report v1.2"): the format's own is added after it.
      return "\(base).\(ext)"
    }

    if named.conforms(to: type) || type.conforms(to: named) {
      return base
    }

    // The name says one format and the bytes are another: the bytes are right.
    return "\((base as NSString).deletingPathExtension).\(ext)"
  }
}
