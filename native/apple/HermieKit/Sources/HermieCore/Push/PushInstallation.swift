import Foundation
import HermieStore

/**
 This installation's id: the key its push row and its `seen` stamp are written under in every
 gateway's push section. Minted once (`i` and sixteen random hex digits, the Expo app's shape),
 stored device-wide under `hermie.installation` as `{"installationId": "…"}`, and never changed:
 a device that re-minted it would leave a dead row behind on every gateway each time.
 */
public enum PushInstallation {
  private struct Stored: Codable, Sendable {
    var installationId: String
  }

  /// The stored id, or a new one written before it is returned. Throws when the store cannot be
  /// read or written: an id that is not stored is not stable, and a row must not be keyed by one.
  public static func id(in keyValues: KeyValueStore) async throws -> String {
    // A database that cannot be read throws here; only a value that is absent or not an id is
    // replaced.
    let text = try await keyValues.string(forKey: StoreKeys.installation)

    if let text, let stored = try? JSONDecoder().decode(Stored.self, from: Data(text.utf8)), isValid(stored.installationId) {
      return stored.installationId
    }

    let minted = mint()
    try await keyValues.set(Stored(installationId: minted), forKey: StoreKeys.installation)
    return minted
  }

  /// `i` and sixteen lowercase hex digits from the system's random source.
  static func mint() -> String {
    var generator = SystemRandomNumberGenerator()
    return "i" + (0..<8).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator)) }.joined()
  }

  /// A non-empty id of letters, digits, `-` and `_` (the Expo app's ids pass).
  static func isValid(_ id: String) -> Bool {
    (1...64).contains(id.unicodeScalars.count)
      && id.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "-" || $0 == "_" }
  }
}
