import Foundation
import Synchronization

/// Where credentials live: bearer tokens, refresh tokens, session tokens, the
/// front door's header pair and the share extension's delivery record.
///
/// The production implementation is `KeychainStore`; `InMemorySecretStore` is
/// the fake for tests and previews. Every key must satisfy
/// `SecretKeys.isValidKey(_:)`, the same rule `expo-secure-store` enforces, so a
/// key the native app writes is a key the Expo build could have written and the
/// reverse.
///
/// Calls are synchronous: a keychain call is a short IPC round trip, and callers
/// that must not block (the main actor) hop to a background task themselves.
public protocol SecretStore: Sendable {
  func get(_ key: String) throws -> String?
  func set(_ key: String, _ value: String) throws
  func delete(_ key: String) throws
}

/// Why a secret store call failed.
///
/// No case carries a secret, a key or a value, and the descriptions are written
/// by hand, so neither `String(describing:)`, `String(reflecting:)`,
/// `localizedDescription` nor a log line can leak one. The key is left out on
/// purpose too: `set(_:_:)` takes two strings, and a call with its arguments
/// swapped would otherwise put a token into an "invalid key" message.
public enum SecretStoreError: Error, Equatable, Sendable {
  /// The key is empty or has a character outside `[A-Za-z0-9_.-]`.
  case invalidKey
  /// A `removeAll(prefix:)` prefix that does not start inside Hermie's own
  /// namespace (`hermie.`), does not end in a dot, or is not a valid key
  /// fragment.
  case invalidPrefix
  /// A gateway id that cannot be a key suffix: empty, or a character outside
  /// `[A-Za-z0-9_]`.
  case invalidGatewayId
  /// The keychain refused the process for lack of a keychain access group.
  /// Not every release says so: on macOS 27 a read from a process without the
  /// entitlement answers "not found" instead, so `get` returns `nil`. A `nil`
  /// token is therefore never permission to clean up other state.
  case missingEntitlement
  /// The item exists but cannot be read yet, typically before the first unlock
  /// after a restart.
  case interactionNotAllowed
  /// The stored bytes are not UTF-8 text.
  case undecodableValue
  /// Any other keychain status.
  case keychain(operation: KeychainOperation, status: Int32)
}

/// The keychain call a `SecretStoreError.keychain` came from.
public enum KeychainOperation: String, Sendable {
  case read
  case add
  case update
  case delete
  case list
}

extension SecretStoreError: CustomStringConvertible, CustomDebugStringConvertible, LocalizedError {
  public var description: String {
    switch self {
    case .invalidKey:
      "Invalid secret key: keys are non-empty and use only letters, digits, '_', '.' and '-'."
    case .invalidPrefix:
      "Invalid secret key prefix: it must start with 'hermie.' and be a valid key fragment."
    case .invalidGatewayId:
      "Invalid gateway id for a secret key: it must be non-empty and use only letters, digits and '_'."
    case .missingEntitlement:
      "The keychain is not available to this process: it is missing its keychain access group entitlement."
    case .interactionNotAllowed:
      "The keychain item cannot be read until the device has been unlocked."
    case .undecodableValue:
      "The keychain item does not hold UTF-8 text."
    case let .keychain(operation, status):
      "Keychain \(operation.rawValue) failed with status \(status)."
    }
  }

  public var debugDescription: String { "SecretStoreError: \(description)" }

  public var errorDescription: String? { description }
}

/// The names of every secret Hermie stores, so no caller concatenates a key.
///
/// They are the names the Expo build uses (`expo/hermie/src/gateway/config.ts`
/// `SECRET_KEYS`, `namespace.ts` `SECRET_NAMESPACE_SEPARATOR`,
/// `features/share/delivery-credential.ts` `SHARE_DELIVERY_KEY`), and with the
/// keychain item shape of `KeychainStore` they are what keeps both builds
/// reading the same items. Renaming one signs people out.
public enum SecretKeys {
  /// The share extension's delivery record. Not per gateway: there is one.
  public static let shareDelivery = "hermie.share.delivery"

  /// The namespace every Hermie secret lives in, and the floor for
  /// `removeAll(prefix:)`.
  public static let ownedPrefix = "hermie."

  /// The separator between a base key and its gateway id. `-` because a base
  /// key is dotted with underscores and a gateway id is `g` and hex, so the
  /// split stays unambiguous.
  public static let gatewaySeparator = "-"

  /// The secrets of one gateway.
  public struct Gateway: Hashable, Sendable {
    public let id: String

    public var accessToken: String { key("hermie.auth.access_token") }
    public var refreshToken: String { key("hermie.auth.refresh_token") }
    public var tokenMeta: String { key("hermie.auth.token_meta") }
    public var sessionToken: String { key("hermie.auth.session_token") }
    public var extraHeaders: String { key("hermie.auth.extra_headers") }
    public var frontDoor: String { key("hermie.auth.front_door") }
    /// The push relay's management secret for this gateway's registration.
    public var pushManage: String { key("hermie.push.manage") }

    /// The six sign-in secrets, the set the Expo build clears on sign-out
    /// (`clearCredentials` in `config.ts`).
    public var credentials: [String] {
      [accessToken, refreshToken, tokenMeta, sessionToken, extraHeaders, frontDoor]
    }

    /// Everything stored for this gateway: what removing it deletes, key by key.
    public var all: [String] { credentials + [pushManage] }

    private func key(_ base: String) -> String { base + SecretKeys.gatewaySeparator + id }
  }

  /// The keys of one gateway. Throws for an id that would make an invalid key
  /// or an ambiguous split (one containing `-` or `.`).
  public static func gateway(_ id: String) throws(SecretStoreError) -> Gateway {
    guard !id.isEmpty, id.unicodeScalars.allSatisfy(isWordScalar) else {
      throw .invalidGatewayId
    }
    return Gateway(id: id)
  }

  /// The rule `expo-secure-store` enforces before it touches the keychain
  /// (`isValidKey` in its `SecureStore.ts`): `^[\w.-]+$`, where `\w` is the
  /// ASCII class `[A-Za-z0-9_]` because the expression has no `u` flag.
  public static func isValidKey(_ key: String) -> Bool {
    !key.isEmpty && key.unicodeScalars.allSatisfy { isWordScalar($0) || $0 == "." || $0 == "-" }
  }

  /// A prefix `removeAll(prefix:)` accepts: a valid key fragment that starts
  /// with `hermie.`, names something inside it, and ends in a dot, so it
  /// selects whole dotted segments (`hermie.s` cannot reach
  /// `hermie.share.delivery`).
  static func isValidOwnedPrefix(_ prefix: String) -> Bool {
    prefix.count > ownedPrefix.count + 1 && prefix.hasPrefix(ownedPrefix) && prefix.hasSuffix(".")
      && isValidKey(prefix)
  }

  /// The one predicate `removeAll(prefix:)` deletes by, in both stores. A key
  /// that is not itself valid never matches, whatever the keychain returns.
  static func key(_ key: String, matchesOwnedPrefix prefix: String) -> Bool {
    isValidOwnedPrefix(prefix) && isValidKey(key) && key.hasPrefix(prefix)
  }

  private static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar {
    case "a"..."z", "A"..."Z", "0"..."9", "_": true
    default: false
    }
  }
}

/// A `SecretStore` in memory, for tests and previews. Thread-safe; enforces the
/// same key rule as `KeychainStore`. Its descriptions show a count, never a key
/// or a value.
public final class InMemorySecretStore: SecretStore {
  private let items: Mutex<[String: String]>

  public init(_ items: [String: String] = [:]) {
    self.items = Mutex(items)
  }

  public func get(_ key: String) throws -> String? {
    try Self.validate(key)
    return items.withLock { $0[key] }
  }

  public func set(_ key: String, _ value: String) throws {
    try Self.validate(key)
    items.withLock { $0[key] = value }
  }

  public func delete(_ key: String) throws {
    try Self.validate(key)
    _ = items.withLock { $0.removeValue(forKey: key) }
  }

  /// Deletes every key that starts with `prefix`, with `KeychainStore`'s rule
  /// for which prefixes are allowed. Returns how many it deleted.
  @discardableResult
  public func removeAll(prefix: String) throws -> Int {
    guard SecretKeys.isValidOwnedPrefix(prefix) else { throw SecretStoreError.invalidPrefix }
    return items.withLock { items in
      let matching = items.keys.filter { SecretKeys.key($0, matchesOwnedPrefix: prefix) }
      for key in matching { items.removeValue(forKey: key) }
      return matching.count
    }
  }

  /// The number of items held.
  public var count: Int { items.withLock { $0.count } }

  private static func validate(_ key: String) throws {
    guard SecretKeys.isValidKey(key) else { throw SecretStoreError.invalidKey }
  }
}

extension InMemorySecretStore: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "InMemorySecretStore(\(count) items)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["count": count]) }
}
