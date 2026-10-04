import Foundation
import HermieProtocol

// The files a bot shares: `attachments` on a `message.complete` and on a history row
// (`packages/transcript/src/outbox.ts`).
//
// The contract is `contract/outbox/` (a byte-identical copy of the gateway fork's): one attachment is
// `{id, name, mime, kind, size, sha256, created_at, url}`, nothing else, and the bytes are fetched from
// `url` (`GET /api/files/outbox/<id>/<name>`) with the person's own credentials. This is the strict
// reader of one: what does not satisfy the schema is dropped, never repaired, because an attachment is a
// link the person may follow and a name they will read.
//
// - A key the contract does not have (a server path, say) drops the attachment: the schema says
//   `additionalProperties: false`, and `examples.json` lists it as invalid.
// - `kind` is one of `image`, `video`, `audio`, `pdf`, `file`. A kind a newer gateway may add is shown as
//   a `file` (a download the person opens deliberately), which the contract allows a client to do. A
//   `kind` that is not a string at all is not an attachment.
// - `url` has exactly one shape: `/api/files/outbox/<id>/<name percent-encoded>`, the same id and the
//   same name. A url that points anywhere else is dropped, so what a request is built from is always a
//   place on the gateway's outbox route and never a path the sender chose.
// - `name` is text. One component of 1 to 180 characters with no control character, `/` or `\`, and not
//   `.` or `..`. Views draw it as text and never as markup.
//
// A gateway whose reply names no files sends no `attachments`; `[]` says the reply named files and none
// could be shared (the reply's text then carries the note). Both read as no attachments.

/// How a client shows a shared file: the gateway's own name for it.
public enum OutboxKind: String, Sendable, Hashable, CaseIterable {
  case image
  case video
  case audio
  case pdf
  /// A download (HTML, SVG, scripts, archives, documents, anything unknown): never opened, never
  /// rendered with the app's credentials.
  case file
}

/// One file a bot shared, as the transcript keeps it (`created_at` as `createdAt`).
public struct OutboxAttachment: TranscriptJSONCodable, Hashable, Sendable, Identifiable {
  /// The token: 32 characters of `A-Z a-z 0-9 _ -`.
  public var id: String
  /// The file's base name as the bot named it. Plain text.
  public var name: String
  /// The type the gateway recorded.
  public var mime: String
  /// How to show it. An unknown kind from the wire is `file`.
  public var kind: OutboxKind
  /// Bytes.
  public var size: Int
  /// SHA-256 of the bytes: 64 lower-case hex characters.
  public var sha256: String
  /// Unix seconds.
  public var createdAt: Double
  /// Where the bytes are, relative to the gateway's origin; the name percent-encoded.
  public var url: String

  public init(
    id: String, name: String, mime: String, kind: OutboxKind, size: Int, sha256: String, createdAt: Double, url: String
  ) {
    self.id = id
    self.name = name
    self.mime = mime
    self.kind = kind
    self.size = size
    self.sha256 = sha256
    self.createdAt = createdAt
    self.url = url
  }

  /// The state's own form (`createdAt`, as the web engine keeps it). A stored attachment is read as
  /// strictly as one off the wire: the cache is a place a hostile value could be left.
  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    guard case .object(let object) = json, let parsed = Self.read(object, createdAtKey: "createdAt") else {
      throw TranscriptDecodingError(path: path, message: "expected a shared file")
    }
    self = parsed
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("id", id)
    writer.set("name", name)
    writer.set("mime", mime)
    writer.set("kind", kind.rawValue)
    writer.set("size", size)
    writer.set("sha256", sha256)
    writer.set("createdAt", createdAt)
    writer.set("url", url)
    return writer.json
  }

  // MARK: Reading

  /// `OUTBOX_MAX_COUNT`: the most attachments one reply keeps (the gateway shares at most 20 a turn by default).
  public static let maximumCount = 100

  private static let wireKeys: Set<String> = ["id", "name", "mime", "kind", "size", "sha256", "created_at", "url"]
  private static let stateKeys: Set<String> = ["id", "name", "mime", "kind", "size", "sha256", "createdAt", "url"]
  private static let urlPrefix = "/api/files/outbox/"
  /// `Number.MAX_SAFE_INTEGER`.
  private static let maximumSafeInteger = 9_007_199_254_740_991.0

  /// One attachment as the wire carries it, or `nil` when it is not one (`parseOutboxAttachment`).
  public static func parse(_ value: JSONValue) -> OutboxAttachment? {
    guard case .object(let object) = value else { return nil }
    return read(object, createdAtKey: "created_at")
  }

  /// The `attachments` of a frame or a row: the valid ones, in order, each token once. Anything else
  /// (absent, not a list, `[]`) is no attachments (`parseOutboxAttachments`).
  public static func parseAll(_ value: JSONValue?) -> [OutboxAttachment] {
    guard case .array(let entries)? = value else { return [] }
    var seen = Set<String>()
    var kept: [OutboxAttachment] = []

    for entry in entries {
      guard let attachment = parse(entry), seen.insert(attachment.id).inserted else { continue }
      kept.append(attachment)
      if kept.count == maximumCount { break }
    }

    return kept
  }

  private static func read(_ object: JSONObject, createdAtKey: String) -> OutboxAttachment? {
    let allowed = createdAtKey == "created_at" ? wireKeys : stateKeys
    guard object.keys.allSatisfy(allowed.contains),
      case .string(let id)? = object["id"], isValidID(id),
      case .string(let name)? = object["name"], isValidName(name),
      case .string(let mime)? = object["mime"],
      case .string(let kind)? = object["kind"],
      case .number(let size)? = object["size"], size >= 0, size.rounded() == size, size <= maximumSafeInteger,
      case .string(let sha256)? = object["sha256"], isValidDigest(sha256),
      case .number(let createdAt)? = object[createdAtKey], createdAt.isFinite,
      case .string(let url)? = object["url"], routeNames(url, id, name)
    else {
      return nil
    }

    return OutboxAttachment(
      id: id, name: name, mime: mime, kind: OutboxKind(rawValue: kind) ?? .file, size: Int(size), sha256: sha256,
      createdAt: createdAt, url: url)
  }

  /// `ID_RE`: `^[A-Za-z0-9_-]{32}$`.
  static func isValidID(_ id: String) -> Bool {
    let bytes = id.utf8
    return bytes.count == 32
      && bytes.allSatisfy { byte in
        (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
          || byte == 0x5F || byte == 0x2D
      }
  }

  /// `SHA_RE`: `^[0-9a-f]{64}$`.
  static func isValidDigest(_ digest: String) -> Bool {
    let bytes = digest.utf8
    return bytes.count == 64 && bytes.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
  }

  /// `validName`: one to 180 characters (code points), no control character (C0, DEL, C1), no `/` or
  /// `\`, and not a dot segment.
  static func isValidName(_ name: String) -> Bool {
    guard name != ".", name != ".." else { return false }
    var count = 0
    for scalar in name.unicodeScalars {
      let value = scalar.value
      if value < 0x20 || (value >= 0x7F && value <= 0x9F) || value == 0x2F || value == 0x5C { return false }
      count += 1
      if count > 180 { return false }
    }
    return count >= 1
  }

  /// `urlNames`: whether `url` is the outbox route of exactly this id and name. Everything is compared by its
  /// code points, as a JavaScript string is, never as Swift's `Character`s, which go by grapheme clusters and
  /// canonical equivalence: a Kelvin sign (U+212A) is not a `K`, a `?` with a combining mark after it is still a
  /// `?`, and `é` and `é` are two names.
  static func routeNames(_ url: String, _ id: String, _ name: String) -> Bool {
    let head = "\(urlPrefix)\(id)/"
    guard url.utf8.starts(with: head.utf8) else { return false }
    // `head` is ASCII, so the cut after it is at a code point boundary.
    let segment = String(decoding: Array(url.utf8.dropFirst(head.utf8.count)), as: UTF8.self)
    // One path segment, with nothing after it: a query or a fragment is somebody else's addition.
    guard !segment.isEmpty, !segment.unicodeScalars.contains(where: { "/\\?#".unicodeScalars.contains($0) }) else {
      return false
    }
    guard let decoded = segment.removingPercentEncoding else { return false }
    return decoded.unicodeScalars.elementsEqual(name.unicodeScalars)
  }

  /// The address a name has in `url`: percent-encoded as `urllib.parse.quote` does (every byte of an
  /// unreserved character stays, everything else is `%XX`).
  public static func encodedName(_ name: String) -> String {
    var out = ""
    for byte in name.utf8 {
      if (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
        || byte == 0x2D || byte == 0x2E || byte == 0x5F || byte == 0x7E
      {
        out.append(Character(UnicodeScalar(byte)))
      } else {
        out += "%" + String(byte, radix: 16, uppercase: true).leftPadded(to: 2)
      }
    }
    return out
  }
}

extension String {
  fileprivate func leftPadded(to width: Int) -> String {
    count >= width ? self : String(repeating: "0", count: width - count) + self
  }
}

extension OutboxAttachment: JSONField {}
