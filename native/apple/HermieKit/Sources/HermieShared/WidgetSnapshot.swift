import Foundation

/**
 `widget-snapshot.json`: everything a widget knows, schema version 1.

 Moved from `expo/hermie/modules/hermie-widgets/widget/HermieWidgetSnapshot.swift`, which decodes
 what `src/features/widgets/snapshot.ts` writes; the app now writes it from Swift, so this type also
 encodes, field for field as `JSON.stringify` did. A widget wakes, reads this one file from the App
 Group container, draws and is killed — there is no logic here beyond decoding, defaulting and the
 two links a tap can follow.

 ## The version is the point of the version field

 A snapshot whose `version` this binary does not understand is no snapshot (`isUsable` is false),
 and the widget draws its empty state. Adding an optional field needs no bump; changing what one
 means does.

 ## Decoding is tolerant, encoding is complete

 Every field but `version` has a default when absent, so a snapshot from an older or newer writer
 still draws. Encoding writes every field the old extension's decoder requires, so a widget binary
 that has not been updated yet keeps reading what the native app writes.
 */
public struct WidgetSnapshot: Codable, Sendable, Equatable {
  /// `WIDGET_SNAPSHOT_VERSION`.
  public static let supportedVersion = 1

  public var version: Int
  /// Unix milliseconds.
  public var generatedAt: Double
  /// Which gateway the rows came from, as `gatewayKeyOf` its origin: sixteen lowercase hex digits.
  public var gatewayKey: String?
  /// Most recently active first, archived bots excluded.
  public var bots: [Bot]
  /// The owner's folders in list order; nil from a writer that predates folders.
  public var folders: [Folder]?

  public init(
    version: Int = WidgetSnapshot.supportedVersion,
    generatedAt: Double,
    gatewayKey: String? = nil,
    bots: [Bot],
    folders: [Folder]? = []
  ) {
    self.version = version
    self.generatedAt = generatedAt
    self.gatewayKey = gatewayKey
    self.bots = bots
    self.folders = folders
  }

  public static let empty = WidgetSnapshot(generatedAt: 0, bots: [], folders: [])

  public var isUsable: Bool {
    version == Self.supportedVersion
  }

  /// How many bots are waiting on a person: the whole content of the accessory widgets.
  public var needsInputCount: Int {
    bots.filter(\.needsInput).count
  }

  public func folder(id: String) -> Folder? {
    (folders ?? []).first { $0.id == id }
  }

  /// The rows of one folder, in the snapshot's own recency order.
  public func bots(in folder: Folder) -> [Bot] {
    folder.bots.compactMap { name in bots.first { $0.name == name } }
  }

  /// The same snapshot with each row told its gateway, so a row's tap can name it. A key that is
  /// not sixteen lowercase hex digits is dropped rather than passed on.
  public func stampingGatewayKey() -> WidgetSnapshot {
    guard let key = gatewayKey, Identifiers.isGatewayKey(key) else {
      return self
    }

    var copy = self

    copy.bots = bots.map { bot in
      var row = bot

      row.gatewayKey = key

      return row
    }

    return copy
  }

  /// Decode a file's bytes; nil for anything unreadable or of another version.
  public static func decodeUsable(_ data: Data) -> WidgetSnapshot? {
    guard let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data), snapshot.isUsable else {
      return nil
    }

    return snapshot.stampingGatewayKey()
  }

  /// The file's bytes, exactly as `JSON.stringify` wrote them for the same snapshot.
  public func encoded() throws -> Data {
    jsonText.data
  }

  private enum CodingKeys: String, CodingKey {
    case version, generatedAt, gatewayKey, bots, folders
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)

    version = try container.decode(Int.self, forKey: .version)
    generatedAt = try container.decodeIfPresent(Double.self, forKey: .generatedAt) ?? 0
    gatewayKey = try container.decodeIfPresent(String.self, forKey: .gatewayKey)
    bots = try container.decodeIfPresent([Bot].self, forKey: .bots) ?? []
    folders = try container.decodeIfPresent([Folder].self, forKey: .folders)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)

    try container.encode(version, forKey: .version)
    try container.encode(generatedAt, forKey: .generatedAt)
    try container.encodeIfPresent(gatewayKey, forKey: .gatewayKey)
    try container.encode(bots, forKey: .bots)
    try container.encode(folders ?? [], forKey: .folders)
  }

  // MARK: Rows

  public struct Bot: Codable, Sendable, Hashable, Identifiable {
    /// The profile name, which is also what `hermie://chat/<bot>` carries.
    public var name: String
    public var displayName: String
    /// Relative to the container, when the app wrote the file.
    public var avatarPath: String?
    public var initials: String
    /// Hex from the app's accent table.
    public var colour: String
    public var presence: String
    public var lastLine: String
    /// Unix seconds, as the gateway reports `last_active`.
    public var lastAt: Double
    public var unread: Int
    public var needsInput: Bool
    /// Which gateway this row came from. Never in the file: stamped from the snapshot.
    public var gatewayKey: String?

    public var id: String { name }

    public init(
      name: String,
      displayName: String,
      avatarPath: String? = nil,
      initials: String,
      colour: String,
      presence: String,
      lastLine: String,
      lastAt: Double,
      unread: Int,
      needsInput: Bool
    ) {
      self.name = name
      self.displayName = displayName
      self.avatarPath = avatarPath
      self.initials = initials
      self.colour = colour
      self.presence = presence
      self.lastLine = lastLine
      self.lastAt = lastAt
      self.unread = unread
      self.needsInput = needsInput
    }

    /// Where a tap goes: `hermie://chat/<bot>`, with `?gateway=` when the row was stamped.
    public var chatURL: URL? {
      DeepLink.chat(bot: name, gatewayKey: gatewayKey ?? "").url
    }

    private enum CodingKeys: String, CodingKey {
      case name, displayName, avatarPath, initials, colour, presence, lastLine, lastAt, unread, needsInput
    }

    public init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)

      name = try container.decode(String.self, forKey: .name)
      displayName = try container.decodeIfPresent(String.self, forKey: .displayName) ?? name
      avatarPath = try container.decodeIfPresent(String.self, forKey: .avatarPath)
      initials = try container.decodeIfPresent(String.self, forKey: .initials) ?? ""
      colour = try container.decodeIfPresent(String.self, forKey: .colour) ?? ""
      presence = try container.decodeIfPresent(String.self, forKey: .presence) ?? ""
      lastLine = try container.decodeIfPresent(String.self, forKey: .lastLine) ?? ""
      lastAt = try container.decodeIfPresent(Double.self, forKey: .lastAt) ?? 0
      unread = try container.decodeIfPresent(Int.self, forKey: .unread) ?? 0
      needsInput = try container.decodeIfPresent(Bool.self, forKey: .needsInput) ?? false
      gatewayKey = nil
    }

    public func encode(to encoder: any Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)

      try container.encode(name, forKey: .name)
      try container.encode(displayName, forKey: .displayName)
      try container.encodeIfPresent(avatarPath, forKey: .avatarPath)
      try container.encode(initials, forKey: .initials)
      try container.encode(colour, forKey: .colour)
      try container.encode(presence, forKey: .presence)
      try container.encode(lastLine, forKey: .lastLine)
      try container.encode(lastAt, forKey: .lastAt)
      try container.encode(unread, forKey: .unread)
      try container.encode(needsInput, forKey: .needsInput)
    }
  }

  public struct Folder: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// Hex from the accent table, or nil for the default tint.
    public var colour: String?
    /// The bots inside, most recently active first; every one is also in `bots`.
    public var bots: [String]
    /// Unread across the folder, muted chats included.
    public var unread: Int
    /// How many inside wait on a person, muted chats excluded.
    public var needsInput: Int
    /// How many are inside in total.
    public var size: Int

    public init(
      id: String,
      name: String,
      colour: String? = nil,
      bots: [String],
      unread: Int,
      needsInput: Int,
      size: Int
    ) {
      self.id = id
      self.name = name
      self.colour = colour
      self.bots = bots
      self.unread = unread
      self.needsInput = needsInput
      self.size = size
    }

    /// Where a tap on the header goes: `hermie://folder/<id>`.
    public var listURL: URL? {
      DeepLink.folder(id: id).url
    }

    private enum CodingKeys: String, CodingKey {
      case id, name, colour, bots, unread, needsInput, size
    }

    public init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)

      id = try container.decode(String.self, forKey: .id)
      name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
      colour = try container.decodeIfPresent(String.self, forKey: .colour)
      bots = try container.decodeIfPresent([String].self, forKey: .bots) ?? []
      unread = try container.decodeIfPresent(Int.self, forKey: .unread) ?? 0
      needsInput = try container.decodeIfPresent(Int.self, forKey: .needsInput) ?? 0
      size = try container.decodeIfPresent(Int.self, forKey: .size) ?? bots.count
    }
  }
}
