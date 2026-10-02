import Foundation

/**
 The share extension's files in the App Group container, as types.

 The formats are the ones `src/features/share/{outbox,targets}.ts` parse and the Expo share
 extension (`modules/hermie-share/share/HermieShareOutbox.swift`, `HermieShareTargets.swift`) writes
 and reads. Types only: the extension and the app's outbox handling move later.

 - `share-outbox/<id>/manifest.json`: one share (`ShareManifest`), written last and atomically, so a
   directory without a readable manifest is an entry still being written and is skipped.
 - `share-outbox/<id>/claim.json`: "handed to the gateway, answer not seen" (`ShareClaim`). An entry
   with a claim is never sent again without asking.
 - `share-targets.json`: which session each bot is, and the extension's three sentences
   (`ShareTargets`).
 */
public struct ShareManifest: Encodable, Sendable, Equatable {
  /// `SHARE_MANIFEST_VERSION`.
  public static let supportedVersion = 1
  /// `SHARE_ITEM_LIMIT`.
  public static let itemLimit = 12
  /// `SHARE_NOTE_LIMIT`, in UTF-16 code units as JavaScript counts.
  public static let noteLimit = 2_000

  public var version: Int
  /// Also the directory name and the deep link's path.
  public var id: String
  /// The handle of the chat it goes to, or nil when the app has to ask.
  public var bot: String?
  public var note: String
  /// Unix seconds.
  public var createdAt: Double
  public var items: [ShareItem]

  public init(
    version: Int = ShareManifest.supportedVersion,
    id: String,
    bot: String?,
    note: String,
    createdAt: Double,
    items: [ShareItem]
  ) {
    self.version = version
    self.id = id
    self.bot = bot
    self.note = note
    self.createdAt = createdAt
    self.items = items
  }

  /**
   Read one manifest, or nil — as tolerantly as `parseShareManifest` in `outbox.ts`.

   Three refusals, and they are the whole contract: a version this build does not understand, an id
   that is not a name, and an entry with nothing left once the items are checked. Everything else
   is repaired towards a default: an item of an unknown kind or with an unsafe file name is dropped
   on its own, a note that is not a string is empty, a missing time is zero. A note alone, with no
   items, is a message and is kept.

   There is deliberately no `Decodable` conformance: a synthesised decoder would reject the whole
   share over one item of a kind a newer extension wrote.
   */
  public static func parse(_ data: Data) -> ShareManifest? {
    guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      ShareJSON.number(raw["version"]) == Double(supportedVersion) else {
      return nil
    }

    let id = ShareJSON.string(raw["id"])

    guard Identifiers.isSafeShareId(id) else {
      return nil
    }

    let items = ((raw["items"] as? [Any]) ?? []).compactMap(ShareItem.parse).prefix(itemLimit)
    let note = String(decoding: Array(ShareJSON.string(raw["note"]).utf16.prefix(noteLimit)), as: UTF16.self)

    guard !items.isEmpty || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }

    let bot = ShareJSON.string(raw["bot"])

    return ShareManifest(
      id: id,
      bot: bot.isEmpty ? nil : bot,
      note: note,
      createdAt: ShareJSON.number(raw["createdAt"]),
      items: Array(items)
    )
  }
}

public struct ShareItem: Encodable, Sendable, Equatable {
  public enum Kind: String, Codable, Sendable {
    case image, file, url, text
  }

  public var kind: Kind
  /// The copied file's name inside the entry's directory, for `image` and `file`. One segment.
  public var path: String?
  public var filename: String?
  /// Bytes, or 0 when unknown.
  public var size: Int?
  /// A hint only.
  public var mimeType: String?
  /// The content, for `url` and `text`.
  public var text: String?

  public init(
    kind: Kind,
    path: String? = nil,
    filename: String? = nil,
    size: Int? = nil,
    mimeType: String? = nil,
    text: String? = nil
  ) {
    self.kind = kind
    self.path = path
    self.filename = filename
    self.size = size
    self.mimeType = mimeType
    self.text = text
  }

  /// One item as `parseItem` reads it, or nil to drop just this item.
  static func parse(_ value: Any) -> ShareItem? {
    guard let raw = value as? [String: Any], let kind = Kind(rawValue: ShareJSON.string(raw["kind"])) else {
      return nil
    }

    switch kind {
    case .url, .text:
      let text = ShareJSON.string(raw["text"]).trimmingCharacters(in: .whitespacesAndNewlines)

      return text.isEmpty ? nil : ShareItem(kind: kind, text: text)
    case .image, .file:
      let path = ShareJSON.string(raw["path"])

      guard isSafeFileName(path) else {
        return nil
      }

      let filename = ShareJSON.string(raw["filename"])
      let mimeType = ShareJSON.string(raw["mimeType"])

      return ShareItem(
        kind: kind,
        path: path,
        filename: isSafeFileName(filename) ? filename : path,
        size: Int(exactly: ShareJSON.number(raw["size"]).rounded(.towardZero)) ?? 0,
        mimeType: mimeType.isEmpty ? nil : mimeType
      )
    }
  }

  /// `isSafeShareFileName`: one segment of at most 200 UTF-16 units, no leading dot, no separator
  /// of either kind, no control character.
  public static func isSafeFileName(_ name: String) -> Bool {
    guard !name.isEmpty, name.utf16.count <= 200, !name.hasPrefix(".") else {
      return false
    }

    return !name.unicodeScalars.contains { $0 == "/" || $0 == "\\" || $0.value < 0x20 || $0.value == 0x7F }
  }
}

/// The two coercions `outbox.ts` reads every field through: `str` and `num`.
enum ShareJSON {
  static func string(_ value: Any?) -> String {
    value as? String ?? ""
  }

  /// A finite number, never a boolean (JSONSerialization hands both back as `NSNumber`).
  static func number(_ value: Any?) -> Double {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return 0
    }

    let double = number.doubleValue

    return double.isFinite ? double : 0
  }
}

public struct ShareClaim: Codable, Sendable, Equatable {
  /// `SHARE_CLAIM_VERSION`.
  public static let supportedVersion = 1

  public var version: Int
  public var bot: String
  /// Unix seconds, from the claiming process's clock.
  public var at: Double

  public init(version: Int = ShareClaim.supportedVersion, bot: String, at: Double) {
    self.version = version
    self.bot = bot
    self.at = at
  }

  /**
   Read a claim as `parseShareClaim` does: nil only for an empty file. A claim that cannot be read
   is STILL a claim — its existence is the load-bearing fact — so it comes back with no bot.
   */
  public static func parse(_ data: Data) -> ShareClaim? {
    let text = String(decoding: data, as: UTF8.self)

    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }

    guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return ShareClaim(bot: "", at: 0)
    }

    let version = Int(ShareJSON.number(raw["version"]))

    return ShareClaim(
      version: version == 0 ? supportedVersion : version,
      bot: ShareJSON.string(raw["bot"]),
      at: ShareJSON.number(raw["at"])
    )
  }
}


public struct ShareTargets: Codable, Sendable, Equatable {
  /// `SHARE_TARGETS_VERSION`.
  public static let supportedVersion = 1
  /// `SHARE_TARGET_BOT_PLACEHOLDER`.
  public static let botPlaceholder = "{bot}"

  public var version: Int
  /// Unix seconds (`buildShareTargets` floors the clock to seconds).
  public var generatedAt: Double
  /// The gateway these sessions belong to; compared with the credential's before sending.
  public var gatewayKey: String?
  public var copy: Copy
  public var targets: [Target]

  public struct Copy: Codable, Sendable, Equatable {
    /// Contains `{bot}`.
    public var sent: String
    public var queued: String
    public var sending: String

    public init(sent: String, queued: String, sending: String) {
      self.sent = sent
      self.queued = queued
      self.sending = sending
    }
  }

  public struct Target: Codable, Sendable, Equatable {
    public var bot: String
    /// The DURABLE session id to resume. Never a runtime id.
    public var session: String

    public init(bot: String, session: String) {
      self.bot = bot
      self.session = session
    }
  }

  public init(
    version: Int = ShareTargets.supportedVersion,
    generatedAt: Double,
    gatewayKey: String?,
    copy: Copy,
    targets: [Target]
  ) {
    self.version = version
    self.generatedAt = generatedAt
    self.gatewayKey = gatewayKey
    self.copy = copy
    self.targets = targets
  }
}

/**
 A Shortcut's request and its answer, as the files under `intents/` in the App Group container.

 `intents/pending/<id>.json` is written by the App Intent (`PendingIntent`); the app answers in
 `intents/results/<id>.json` (`IntentResult`) and then removes the request. The intent waits at most
 `budget` for the answer. Formats as `src/features/intents/queue.ts`.
 */
public struct PendingIntent: Codable, Sendable, Equatable {
  /// `INTENT_QUEUE_VERSION`.
  public static let supportedVersion = 1
  /// `INTENT_BUDGET_MS`.
  public static let budget: Duration = .milliseconds(45_000)

  public enum Kind: String, Codable, Sendable {
    case ask, send
  }

  public var version: Int
  public var id: String
  public var kind: Kind
  /// The handle, never the display label.
  public var bot: String
  public var text: String
  /// Unix milliseconds.
  public var createdAt: Double

  public init(
    version: Int = PendingIntent.supportedVersion,
    id: String,
    kind: Kind,
    bot: String,
    text: String,
    createdAt: Double
  ) {
    self.version = version
    self.id = id
    self.kind = kind
    self.bot = bot
    self.text = text
    self.createdAt = createdAt
  }
}

public struct IntentResult: Codable, Sendable, Equatable {
  public var version: Int
  public var id: String
  public var ok: Bool
  /// The bot's answer, for `ask`.
  public var reply: String?
  /// One sentence, shown by Shortcuts.
  public var error: String?

  public init(version: Int = PendingIntent.supportedVersion, id: String, ok: Bool, reply: String?, error: String?) {
    self.version = version
    self.id = id
    self.ok = ok
    self.reply = reply
    self.error = error
  }

  public static func reply(id: String, _ text: String) -> IntentResult {
    IntentResult(id: id, ok: true, reply: text, error: nil)
  }

  public static func failure(id: String, _ message: String) -> IntentResult {
    IntentResult(id: id, ok: false, reply: nil, error: message)
  }
}
