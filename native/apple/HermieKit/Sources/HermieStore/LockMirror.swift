import Foundation

/**
 A copy of the app lock setting outside `hermie.sqlite`.

 The lock setting lives in `kv` like every other setting, and a corrupt database file can take it
 with it. A lock that quietly switches itself off after a disk problem is a security bug; a lock
 that switches itself ON for somebody who never chose one strands a person whose device cannot
 authenticate. So the setting is mirrored into its own small file next to the database, written
 after every committed change to `hermie.lock`, and read back only when the database had to be
 recreated and the rescue did not bring the setting back.

 The file is `{"v":1,"lock":<the stored text, or null when there is no lock setting>}`, written
 atomically, with the database's protection class and excluded from backup like the database.
 */
public struct LockMirror: Sendable {
  public static let fileName = "hermie.lock.json"

  public let url: URL

  public init(url: URL) {
    self.url = url
  }

  /// `<Application Support>/hermie.lock.json`, beside the database.
  public init(applicationSupport: URL) {
    self.init(url: applicationSupport.appendingPathComponent(Self.fileName))
  }

  private struct Contents: Codable, Equatable {
    var v = 1
    var lock: String?

    private enum CodingKeys: String, CodingKey {
      case v, lock
    }

    func encode(to encoder: any Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)

      try container.encode(v, forKey: .v)
      // Written as `null` rather than left out: present-and-null is "no lock", while a file that
      // does not say is no evidence of anything.
      try container.encode(lock, forKey: .lock)
    }

    init(lock: String?) {
      self.lock = lock
    }

    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)

      v = try container.decode(Int.self, forKey: .v)

      guard container.contains(.lock) else {
        throw DecodingError.keyNotFound(CodingKeys.lock, .init(codingPath: [], debugDescription: "no lock field"))
      }

      lock = try container.decodeIfPresent(String.self, forKey: .lock)
    }
  }

  /// What the mirror says, or nil when it is missing, unreadable or not this shape. `.some(nil)`
  /// means "there was no lock setting".
  public func read() -> String?? {
    guard let data = try? Data(contentsOf: url),
      let contents = try? JSONDecoder().decode(Contents.self, from: data),
      contents.v == 1 else {
      return nil
    }

    return .some(contents.lock)
  }

  /// Write the current setting. Skips the write when the file already says the same thing.
  public func write(_ lock: String?) throws {
    if case .some(let current) = read(), current == lock {
      return
    }

    var options: Data.WritingOptions = [.atomic]

    #if os(iOS)
      options.insert(.completeFileProtectionUntilFirstUserAuthentication)
    #endif

    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(Contents(lock: lock)).write(to: url, options: options)

    // An atomic write is a rename, which drops the attribute, so it is set after every write.
    var file = url
    var values = URLResourceValues()

    values.isExcludedFromBackup = true
    try? file.setResourceValues(values)
  }
}
