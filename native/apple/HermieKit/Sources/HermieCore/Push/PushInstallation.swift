import Foundation
import HermieStore

/**
 This installation's id: the key its push row and its `seen` stamp are written under in every
 gateway's push section. Minted once (`i` and sixteen random hex digits, the Expo app's shape),
 stored device-wide under `hermie.installation` as `{"installationId": "…"}`, and never changed:
 a device that re-minted it would leave a dead row behind on every gateway each time.

 The read and the mint are one store transaction, so two first-launch callers cannot mint two ids:
 the second reads what the first wrote. (No process-wide cache: a store's identity is not stable
 enough to key one by, and the read is one row.)
 */
public enum PushInstallation {
  private struct Stored: Codable, Sendable {
    var installationId: String
  }

  /// The stored id, or a new one written in the same transaction. Throws when the store cannot be
  /// read or written: an id that is not stored is not stable, and a row must not be keyed by one.
  public static func id(in keyValues: KeyValueStore) async throws -> String {
    let minted = mint()

    return try await keyValues.store.write { database -> String in
      // A database that cannot be read throws here; only a value that is absent or not an id is
      // replaced.
      if let text = try database.kvValue(forKey: StoreKeys.installation),
        let stored = try? JSONDecoder().decode(Stored.self, from: Data(text.utf8)), isValid(stored.installationId)
      {
        return stored.installationId
      }

      try database.kvSet(#"{"installationId":"\#(minted)"}"#, forKey: StoreKeys.installation, now: Date())
      return minted
    }
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
