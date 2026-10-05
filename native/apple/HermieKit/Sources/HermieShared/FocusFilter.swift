import Foundation

/**
 What a Focus lets Hermie notify about: which bots may, and whether only urgent requests may.

 The person sets it per Focus (Settings → Focus → Hermie), through the app's Focus filter intent. The
 intent stores it here and the app reads it whenever it decides about a local notification, so a
 binary that cannot call the system (a notification service extension, a widget) can read the same
 file and apply the same rule.

 ## The rule, in one place

 A request notifies while a filter is active only when both hold:

 - **The bot is allowed**: `scope` is `all`, or `chosen` and the bot is one of `bots`. Under `none`
   no bot is allowed.
 - **It is urgent enough**: `urgentOnly` is off, or the request is urgent (an approval, a question
   or a confirmation: the kinds a bot is stopped on until the person answers).

 `unfiltered` (every bot, urgent or not) is the state of no Focus filter at all, and is what is read
 when nothing is stored.

 Bots are identified the way a notification names them: by the gateway's key and the bot's handle
 (not its display name, which the person can change).
 */
public struct FocusFilter: Codable, Sendable, Equatable {
  /// Which bots may notify.
  public enum Scope: String, Codable, Sendable, CaseIterable {
    case all
    case chosen
    case none
  }

  /// One bot, by the gateway it belongs to and its handle.
  public struct Bot: Codable, Sendable, Hashable {
    public var gatewayKey: String
    public var handle: String

    public init(gatewayKey: String, handle: String) {
      self.gatewayKey = gatewayKey
      self.handle = handle
    }

    /// The identifier the Focus filter's bot picker gives it: `<gateway key>/<handle>`. A handle has
    /// no `/` (`Identifiers.isBotName`), so the first one is the separator.
    public var id: String {
      "\(gatewayKey)/\(handle)"
    }

    /// The bot an identifier names, or nil for one that is not `<gateway key>/<handle>`.
    public init?(id: String) {
      guard let slash = id.firstIndex(of: "/") else {
        return nil
      }

      let key = String(id[..<slash])
      let handle = String(id[id.index(after: slash)...])

      guard Identifiers.isGatewayKey(key), Identifiers.isBotName(handle) else {
        return nil
      }

      self.init(gatewayKey: key, handle: handle)
    }
  }

  /// `focus-filter.json`'s schema version. A file of another version is no filter.
  public static let supportedVersion = 1

  public var scope: Scope
  /// The bots of `.chosen`. Ignored for the other scopes (kept, so switching back restores the list).
  public var bots: [Bot]
  public var urgentOnly: Bool

  public static let unfiltered = FocusFilter(scope: .all, bots: [], urgentOnly: false)

  public init(scope: Scope = .all, bots: [Bot] = [], urgentOnly: Bool = false) {
    self.scope = scope
    self.bots = bots
    self.urgentOnly = urgentOnly
  }

  /// Whether this filter removes anything at all.
  public var isActive: Bool {
    scope != .all || urgentOnly
  }

  /// Whether a notification for this bot may be shown, `urgent` saying whether its request is one of
  /// the urgent kinds.
  public func allows(gatewayKey: String, bot: String, urgent: Bool) -> Bool {
    if urgentOnly, !urgent {
      return false
    }

    switch scope {
    case .all: return true
    case .none: return false
    case .chosen: return bots.contains(Bot(gatewayKey: gatewayKey, handle: bot))
    }
  }

  // MARK: Stored form

  private enum CodingKeys: String, CodingKey {
    case version, scope, bots, urgentOnly
  }

  /// Decoding is tolerant: a field that is missing or unreadable takes its default, so a file from
  /// another build never makes a request disappear by accident. Only the version is required.
  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let version = try container.decode(Int.self, forKey: .version)

    guard version == Self.supportedVersion else {
      throw DecodingError.dataCorruptedError(
        forKey: .version, in: container, debugDescription: "unsupported focus filter version \(version)")
    }

    scope = (try? container.decodeIfPresent(Scope.self, forKey: .scope)) ?? .all
    bots = (try? container.decodeIfPresent([Bot].self, forKey: .bots)) ?? []
    urgentOnly = (try? container.decodeIfPresent(Bool.self, forKey: .urgentOnly)) ?? false
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)

    try container.encode(Self.supportedVersion, forKey: .version)
    try container.encode(scope, forKey: .scope)
    try container.encode(bots, forKey: .bots)
    try container.encode(urgentOnly, forKey: .urgentOnly)
  }
}

/**
 `focus-filter.json` in the App Group container: where the Focus filter intent writes the filter and
 everything that decides about a notification reads it.

 A write replaces the file atomically (a reader in another process may open it at any moment).
 Writing the unfiltered state removes the file, so "no filter" and "never set" are the same thing on
 disk. Every failure to read answers "unfiltered": a filter that cannot be read must not swallow a
 request that needs the person.
 */
public struct FocusFilterStore: Sendable {
  /// A ceiling for the file, which another process may have written.
  public static let maxBytes = 64 * 1024

  public let directory: URL

  /// A store in `directory`; tests pass a temporary one.
  public init(directory: URL) {
    self.directory = directory
  }

  /// The real container, or nil when the App Group entitlement did not make it onto this binary.
  public static func system(fileManager: FileManager = .default) -> FocusFilterStore? {
    SharedContainer.url(fileManager: fileManager).map(FocusFilterStore.init(directory:))
  }

  public var fileURL: URL {
    directory.appendingPathComponent(SharedContainer.focusFilterFile)
  }

  /// The stored filter, or `unfiltered`.
  public func load() -> FocusFilter {
    guard let data = try? Data(contentsOf: fileURL), data.count <= Self.maxBytes else {
      return .unfiltered
    }

    return (try? JSONDecoder().decode(FocusFilter.self, from: data)) ?? .unfiltered
  }

  /// Store `filter`. Answers whether the file now says it.
  @discardableResult
  public func save(_ filter: FocusFilter) -> Bool {
    guard filter.isActive else {
      return clear()
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]

    guard let data = try? encoder.encode(filter) else {
      return false
    }

    do {
      try data.write(to: fileURL, options: .atomic)
      return true
    } catch {
      return false
    }
  }

  /**
   What the Focus filter intent does when the system performs it: build the filter from what the
   person picked and store it. An identifier that names no bot is dropped (a bot picked in a build
   that has since changed its ids must not make the filter unreadable); duplicates are kept once.
   Answers whether the file now says it.
   */
  @discardableResult
  public func apply(scope: FocusFilter.Scope, botIdentifiers: [String], urgentOnly: Bool) -> Bool {
    var seen = Set<FocusFilter.Bot>()
    let bots = botIdentifiers.compactMap(FocusFilter.Bot.init(id:)).filter { seen.insert($0).inserted }

    return save(FocusFilter(scope: scope, bots: bots, urgentOnly: urgentOnly))
  }

  /// Remove the filter. Answers whether none is stored now.
  @discardableResult
  public func clear() -> Bool {
    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      return true
    }

    return (try? FileManager.default.removeItem(at: fileURL)) != nil
  }
}
