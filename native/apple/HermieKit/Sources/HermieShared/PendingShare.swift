import Foundation

/**
 One share the extension left in the outbox, as the app reads it: the manifest checked, every file
 resolved to a URL inside the entry, and the claim reported beside it.

 `parseShareEntry` and its helpers in `src/features/share/outbox.ts`, rule for rule:

 - the manifest must parse (`ShareManifest.parse`) and name the directory it is in;
 - a file item whose file is not in the directory is dropped on its own;
 - an entry with nothing left (no item, no note) is no entry;
 - a claim that exists is reported even when it cannot be read: its existence is the fact.
 */
public struct PendingShare: Sendable, Equatable, Identifiable {
  public var id: String
  /// The handle of the chat it goes to, or nil when the app has to ask.
  public var bot: String?
  public var note: String
  /// Unix seconds.
  public var createdAt: Double
  public var items: [Item]
  /// "Handed to the gateway, answer not seen": never sent again without asking.
  public var claim: ShareClaim?

  public enum Item: Sendable, Equatable {
    /// An image or a file, at a URL inside the entry's directory.
    case file(kind: ShareItem.Kind, url: URL, filename: String, size: Int, mimeType: String)
    /// A URL or a piece of text, already trimmed.
    case words(kind: ShareItem.Kind, text: String)
  }

  /// `FALLBACK_MIME_TYPE`.
  public static let fallbackMimeType = "application/octet-stream"

  public init(id: String, bot: String?, note: String, createdAt: Double, items: [Item], claim: ShareClaim?) {
    self.id = id
    self.bot = bot
    self.note = note
    self.createdAt = createdAt
    self.items = items
    self.claim = claim
  }

  /**
   Read one entry, or nil.

   - `id`: the directory's name, which the manifest must repeat.
   - `files`: the names in the directory (manifest and claim excluded) and their URLs.
   - `claim`: the claim file's bytes when one exists, empty when it exists and cannot be read.
   */
  public static func parse(id: String, manifest: Data, claim: Data?, files: [String: URL]) -> PendingShare? {
    guard let manifest = ShareManifest.parse(manifest), manifest.id == id else {
      return nil
    }

    var items: [Item] = []

    for item in manifest.items {
      switch item.kind {
      case .url, .text:
        items.append(.words(kind: item.kind, text: item.text ?? ""))
      case .image, .file:
        guard let path = item.path, let url = files[path] else {
          continue
        }

        let filename = item.filename.flatMap { $0.isEmpty ? nil : $0 } ?? path
        let mimeType = item.mimeType.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackMimeType

        items.append(.file(kind: item.kind, url: url, filename: filename, size: item.size ?? 0, mimeType: mimeType))
      }
    }

    guard !items.isEmpty || !manifest.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }

    return PendingShare(
      id: manifest.id,
      bot: manifest.bot,
      note: manifest.note,
      createdAt: manifest.createdAt,
      items: items,
      // An empty or unreadable claim file is still a claim. `parseShareEntry` turns an empty one
      // into no claim at all, which is the opposite of what its own comment asks for; this side
      // fails towards asking.
      claim: claim.map { ShareClaim.parse($0) ?? ShareClaim(bot: "", at: 0) }
    )
  }

  /**
   `shareMessageText`: the note, then every URL and piece of text, one paragraph each.

   The message the app sends; the share extension builds the same text for the same entry.
   */
  public var messageText: String {
    let words = items.compactMap { item -> String? in
      guard case let .words(_, text) = item else {
        return nil
      }

      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

      return trimmed.isEmpty ? nil : trimmed
    }

    return ([note.trimmingCharacters(in: .whitespacesAndNewlines)] + words).filter { !$0.isEmpty }
      .joined(separator: "\n\n")
  }

  /// `shareFiles`: the images and files, in order.
  public var files: [Item] {
    items.filter {
      if case .file = $0 {
        return true
      }

      return false
    }
  }

  /// `sortShares`: oldest first, then by id.
  public static func sorted(_ shares: [PendingShare]) -> [PendingShare] {
    shares.sorted { left, right in
      left.createdAt != right.createdAt ? left.createdAt < right.createdAt : left.id < right.id
    }
  }
}
