import Foundation

@testable import HermieStore

/// A fresh directory under the system temporary directory, removed by `cleanUp()`.
struct TemporaryDirectory {
  let url: URL

  init() throws {
    url = FileManager.default.temporaryDirectory
      .appendingPathComponent("hermie-store-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  }

  func cleanUp() {
    try? FileManager.default.removeItem(at: url)
  }
}

enum Fixtures {
  /// `Tests/HermieStoreTests/Fixtures`, read from the source tree.
  static let root = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("Fixtures", isDirectory: true)

  /// The recorded AsyncStorage directory: `<Application Support>` of a synthetic Expo install.
  static let expoApplicationSupport = root.appendingPathComponent("ExpoAsyncStorage", isDirectory: true)

  static let expoStorage = ExpoImport.storageDirectory(
    applicationSupport: expoApplicationSupport,
    bundleIdentifier: "dev.hermie.app"
  )

  static let gatewayOne = "g0123456789abcdef"
  static let gatewayTwo = "gfedcba9876543210"
}

/// Builds an AsyncStorage directory the way `RNCAsyncStorage.mm` lays one out.
struct AsyncStorageWriter {
  let directory: URL
  private(set) var manifest: [String: Any] = [:]

  init(directory: URL) throws {
    self.directory = directory
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  /// Inline up to 1024 UTF-16 code units, otherwise a file named by the key's MD5.
  mutating func set(_ key: String, _ value: String) throws {
    if value.utf16.count <= 1024 {
      manifest[key] = value
    } else {
      manifest[key] = NSNull()
      try Data(value.utf8).write(to: directory.appendingPathComponent(ExpoImport.overflowFileName(forKey: key)))
    }
  }

  /// A manifest entry pointing at an overflow file that does not exist.
  mutating func setDangling(_ key: String) {
    manifest[key] = NSNull()
  }

  func writeManifest() throws {
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])

    try data.write(to: directory.appendingPathComponent(ExpoImport.manifestFileName))
  }
}

/// Every file under a directory with its bytes, for proving a directory was left untouched.
func snapshotTree(_ root: URL) throws -> [String: Data] {
  var result: [String: Data] = [:]
  let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])

  while let url = enumerator?.nextObject() as? URL {
    guard (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else {
      continue
    }

    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    let modified = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0

    result["\(url.path)@\(modified)"] = try Data(contentsOf: url)
  }

  return result
}

func memoryDatabase() throws -> SQLiteDatabase {
  try SQLiteDatabase.open(.inMemory).database
}
