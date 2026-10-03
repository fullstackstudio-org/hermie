import Foundation
import HermieStore

/// A bot's avatar as `profiles.get_asset` ships it: a data URL (`data:image/png;base64,…`, what the
/// gateway and the fake send), or bare base64 (what an older build cached).
///
/// Reading the data URL as base64 whole was why no avatar was ever drawn: the decoder skipped the
/// punctuation of the `data:image/png;base64,` prefix but kept its letters, and the bytes after it
/// were no image any more.
public enum AvatarData {
  public static func bytes(_ text: String) -> Data? {
    var payload = Substring(text.trimmingCharacters(in: .whitespacesAndNewlines))

    if payload.hasPrefix("data:") {
      guard let comma = payload.firstIndex(of: ","), payload[..<comma].hasSuffix(";base64") else {
        return nil
      }

      payload = payload[payload.index(after: comma)...]
    }

    guard !payload.isEmpty else {
      return nil
    }

    return Data(base64Encoded: String(payload), options: .ignoreUnknownCharacters)
  }
}

/**
 The avatars on disk, per gateway: what the list paints on launch before the roster has asked the
 gateway again. Kept in the key-value store under the gateway's namespace, so a sign-out or a removal
 that purges the namespace takes them with it.

 Stale-while-revalidate: a cached avatar is shown at once, and the roster still fetches each one
 once per launch (and once per `ui_meta` revision), replacing the stored copy when it changed and
 removing it when the bot no longer has one.
 */
struct AvatarDiskCache: Sendable {
  static let prefix = "hermie.avatar."

  let store: KeyValueStore
  let namespace: GatewayNamespace

  func read(_ name: String) async -> String? {
    try? await store.string(forKey: namespace.key(Self.prefix + name))
  }

  func write(_ name: String, _ data: String?) async {
    let key = namespace.key(Self.prefix + name)

    if let data {
      try? await store.setString(data, forKey: key)
    } else {
      try? await store.removeValue(forKey: key)
    }
  }
}
