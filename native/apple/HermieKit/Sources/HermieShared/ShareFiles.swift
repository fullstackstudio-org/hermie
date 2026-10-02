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
public struct ShareManifest: Codable, Sendable, Equatable {
  /// `SHARE_MANIFEST_VERSION`.
  public static let supportedVersion = 1
  /// `SHARE_ITEM_LIMIT`.
  public static let itemLimit = 12
  /// `SHARE_NOTE_LIMIT`.
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
}

public struct ShareItem: Codable, Sendable, Equatable {
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
}

public struct ShareTargets: Codable, Sendable, Equatable {
  /// `SHARE_TARGETS_VERSION`.
  public static let supportedVersion = 1
  /// `SHARE_TARGET_BOT_PLACEHOLDER`.
  public static let botPlaceholder = "{bot}"

  public var version: Int
  /// Unix milliseconds.
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
