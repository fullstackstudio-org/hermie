import HermieProtocol

/// The fields every transcript item carries (`ItemBase` in `types.ts`).
public struct ItemBase: Sendable, Hashable {
  /// Stable across re-hydration — see `reconcile.ts`.
  public var id: String
  /// Sort key within `order`; history rows get `index * 1000` so live items fit between.
  public var seq: Int
  /// Unix seconds, when the wire carried one.
  public var ts: Double?
  /// Durable `messages.id` once the row is persisted.
  public var rowID: Int?
  public var origin: ItemOrigin
  /// Bumped on every mutation; lets a UI memoize per item and per state cheaply.
  public var version: Int
  public var reactions: [ItemReaction]?

  public init(
    id: String,
    seq: Int,
    ts: Double? = nil,
    rowID: Int? = nil,
    origin: ItemOrigin,
    version: Int,
    reactions: [ItemReaction]? = nil
  ) {
    self.id = id
    self.seq = seq
    self.ts = ts
    self.rowID = rowID
    self.origin = origin
    self.version = version
    self.reactions = reactions
  }

  init(reading reader: inout ObjectReader) throws(TranscriptDecodingError) {
    id = try reader.required("id")
    seq = try reader.required("seq")
    ts = reader.optional("ts")
    rowID = reader.optional("rowId")
    origin = try reader.required("origin")
    version = try reader.required("version")
    reactions = reader.optional("reactions")
  }

  func write(into writer: inout ObjectWriter) {
    writer.set("id", id)
    writer.set("seq", seq)
    writer.set("ts", ts)
    writer.set("rowId", rowID)
    writer.set("origin", origin)
    writer.set("version", version)
    writer.set("reactions", reactions)
  }
}

/// One emoji reaction on a persisted row (`ItemReaction`: `emoji` plus whatever
/// else the gateway sent, kept in `extra`).
public struct ItemReaction: TranscriptJSONCodable, Hashable {
  public var emoji: String
  public var extra: JSONObject

  public init(emoji: String, extra: JSONObject = [:]) {
    self.emoji = emoji
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ItemReaction")
    emoji = try reader.required("emoji")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("emoji", emoji)
    return writer.json
  }
}

extension ItemReaction: JSONField {}

/// What every item kind's struct has: its kind, the shared fields, and the keys it
/// did not recognise. The shared fields read straight off the item (`item.id`,
/// `item.version += 1`).
public protocol TranscriptItemProtocol: TranscriptJSONCodable, Hashable {
  static var kind: TranscriptItemKind { get }
  var base: ItemBase { get set }
  /// Keys this build does not know, kept so the item re-encodes unchanged.
  var extra: JSONObject { get set }
}

extension TranscriptItemProtocol {
  public var id: String {
    get { base.id }
    set { base.id = newValue }
  }

  public var seq: Int {
    get { base.seq }
    set { base.seq = newValue }
  }

  public var ts: Double? {
    get { base.ts }
    set { base.ts = newValue }
  }

  public var rowID: Int? {
    get { base.rowID }
    set { base.rowID = newValue }
  }

  public var origin: ItemOrigin {
    get { base.origin }
    set { base.origin = newValue }
  }

  public var version: Int {
    get { base.version }
    set { base.version = newValue }
  }

  public var reactions: [ItemReaction]? {
    get { base.reactions }
    set { base.reactions = newValue }
  }

  public var kind: TranscriptItemKind { Self.kind }
}

extension ObjectReader {
  /// Takes `kind` and checks it is `expected`.
  mutating func expectKind(_ expected: TranscriptItemKind) throws(TranscriptDecodingError) {
    let kind: String = try required("kind")
    guard JS.same(kind, expected.rawValue) else {
      throw TranscriptDecodingError(
        path: JSONPath.member(path, "kind"),
        message: "expected \"\(expected.rawValue)\", found \"\(kind)\""
      )
    }
  }
}

extension ObjectWriter {
  /// The opening of every item: its extra keys, `kind`, then the shared fields.
  static func item(_ kind: TranscriptItemKind, _ base: ItemBase, extra: JSONObject) -> ObjectWriter {
    var writer = ObjectWriter(extra: extra)
    writer.set("kind", kind.rawValue)
    base.write(into: &writer)
    return writer
  }
}
