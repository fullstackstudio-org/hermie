import Foundation
import HermieGateway
import HermieProtocol

/// What a vault item is (`agent/vault_store.py::VAULT_KINDS`).
public enum VaultKind: String, Sendable, CaseIterable, Hashable {
  case login
  case payment
  case address
}

/// What a login's identifier is (`LOGIN_IDENTIFIER_TYPES`). Visible metadata, not a secret: the bot may see it
/// and type it itself.
public enum VaultIdentifierType: String, Sendable, CaseIterable, Hashable {
  case email
  case username
  case phone
}

/**
 One item of a bot's vault as `vault.list` lists it: metadata only.

 The gateway's contract is that a listing never carries a secret; this type does not rely on that. It has no
 field a secret could land in, and `parse` reads the named metadata keys and nothing else, so a gateway that
 put a password or a card number in a row by mistake would still not get it into this app's memory past the
 frame itself. `identifier` (the login's email, username or phone) is metadata by the gateway's design: the
 bot may see and type it.
 */
public struct VaultItem: Sendable, Equatable, Identifiable, Hashable {
  public var id: String
  /// The kind as the gateway names it (`login`, `payment`, `address`, or one this app does not know).
  public var kind: String
  public var label: String
  /// The site the item is filled on (`scheme://host[:port]`), when it has one.
  public var origin: String?
  public var identifier: String?
  public var identifierType: String?
  /// A TOTP seed is stored with the login (whether, never what).
  public var hasOTP: Bool
  /// Where it is kept: `local` is the bot's own vault on the gateway; another name is an unlocked password
  /// manager's.
  public var backend: String

  public init(
    id: String, kind: String, label: String, origin: String? = nil, identifier: String? = nil,
    identifierType: String? = nil, hasOTP: Bool = false, backend: String = VaultSource.localName
  ) {
    self.id = id
    self.kind = kind
    self.label = label
    self.origin = origin
    self.identifier = identifier
    self.identifierType = identifierType
    self.hasOTP = hasOTP
    self.backend = backend
  }

  public var knownKind: VaultKind? { VaultKind(rawValue: kind) }

  /// Kept in the bot's own vault, the one item `vault.remove` can take out (a manager's items are the
  /// manager's to remove).
  public var isLocal: Bool { backend == VaultSource.localName }

  /// One row of `vault.list`'s `items`; nil for one without an id. Every text is the gateway's, cleaned
  /// and bounded for display.
  public static func parse(_ value: JSONValue) -> VaultItem? {
    guard let id = value["id"]?.stringValue, !id.isEmpty else {
      return nil
    }

    let origin = value["origin"]?.stringValue.map { CapabilityText.line($0) }.flatMap { $0.isEmpty ? nil : $0 }
    let identifier = value["identifier"]?.stringValue.map { CapabilityText.line($0) }.flatMap {
      $0.isEmpty ? nil : $0
    }

    return VaultItem(
      id: id,
      kind: CapabilityText.line(value["kind"]?.stringValue ?? "", limit: 40),
      label: CapabilityText.line(value["label"]?.stringValue ?? ""),
      origin: origin,
      identifier: identifier,
      identifierType: value["identifier_type"]?.stringValue.map { CapabilityText.line($0, limit: 40) },
      hasOTP: value["has_otp"]?.boolValue ?? false,
      backend: CapabilityText.line(value["backend"]?.stringValue ?? VaultSource.localName, limit: 60)
    )
  }

  /// `vault.list`'s answer: its items, the ones without an id left out.
  public static func parseList(_ result: JSONValue) -> [VaultItem] {
    (result["items"]?.arrayValue ?? []).compactMap(parse)
  }
}

/// One place logins come from (`vault.sources`): the bot's own vault, or a password manager on the gateway's
/// host.
public struct VaultSource: Sendable, Equatable, Identifiable, Hashable {
  /// The bot's own vault on the gateway.
  public static let localName = "local"

  public var name: String
  public var displayName: String
  public var enabled: Bool
  /// A password manager, which is locked until its master password is given.
  public var needsUnlock: Bool
  public var unlocked: Bool
  /// Its program is on the gateway's host.
  public var installed: Bool

  public var id: String { name }
  public var isLocal: Bool { name == Self.localName }

  public init(
    name: String, displayName: String, enabled: Bool, needsUnlock: Bool, unlocked: Bool, installed: Bool
  ) {
    self.name = name
    self.displayName = displayName
    self.enabled = enabled
    self.needsUnlock = needsUnlock
    self.unlocked = unlocked
    self.installed = installed
  }

  public static func parse(_ value: JSONValue) -> VaultSource? {
    guard let name = value["name"]?.stringValue, !name.isEmpty else {
      return nil
    }

    let display = CapabilityText.line(value["display_name"]?.stringValue ?? "", limit: 60)

    return VaultSource(
      name: name,
      displayName: display.isEmpty ? CapabilityText.line(name, limit: 60) : display,
      enabled: value["enabled"]?.boolValue ?? false,
      needsUnlock: value["needs_unlock"]?.boolValue ?? false,
      unlocked: value["unlocked"]?.boolValue ?? false,
      installed: value["installed"]?.boolValue ?? false
    )
  }

  public static func parseList(_ result: JSONValue) -> [VaultSource] {
    (result["sources"]?.arrayValue ?? []).compactMap(parse)
  }
}

/**
 What `vault.add` stores: the item's metadata and its secret payload.

 The payload's values are `SecretValue`s, which describe themselves as redacted; this type does the same, so
 nothing that prints, dumps or interpolates a request shows a secret. It lives from the moment Save takes the
 form's fields (`VaultAddForm.take()`, which empties them) until the call that sends it returns.
 */
public struct VaultAddRequest: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
  CustomReflectable
{
  public var kind: VaultKind
  public var label: String
  public var origin: String?
  /// The login's identifier, which the gateway moves into the item's metadata (`identifier_type`,
  /// `identifier` travel inside `secret`, as `vault.add` reads them).
  public var identifierType: VaultIdentifierType?
  public var identifier: String?
  /// The secret fields by their wire name (`password`, `otp_secret`, `card_number`, …). Empty ones are left out.
  public var secret: [String: SecretValue]

  public init(
    kind: VaultKind, label: String, origin: String?, identifierType: VaultIdentifierType? = nil,
    identifier: String? = nil, secret: [String: SecretValue]
  ) {
    self.kind = kind
    self.label = label
    self.origin = origin
    self.identifierType = identifierType
    self.identifier = identifier
    self.secret = secret
  }

  /// The secret's text values, for scrubbing a refusal's words: only these could be echoed back.
  var secretTexts: [String] {
    secret.values.map(\.revealed).filter { !$0.isEmpty }
  }

  public var description: String {
    "VaultAddRequest(kind: \(kind.rawValue), label: \(label), origin: \(origin ?? "nil"), "
      + "secret: \(secret.keys.sorted()) <redacted>)"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

/// Why a vault call did not go through, sorted by what the page should do about it.
public enum VaultFailure: Error, Sendable, Equatable {
  /// The gateway has no such method (an older one).
  case unsupported
  /// No connection to ask over, or none in time.
  case offline
  /// The gateway does not let this connection do that (an agent's connection: 4033).
  case refused
  /// The gateway said no, in its own words (untrusted text, already cleaned of what was sent).
  case failed(String)

  public var detail: String? {
    if case .failed(let message) = self, !message.isEmpty { message } else { nil }
  }

  /// Sort anything a vault call can throw. `scrubbing` holds the secret texts that went with the call: any of
  /// them found in the gateway's words is taken out before the words are kept (the gateway scrubs its own
  /// refusals too; this does not rely on it).
  public static func classify(_ error: any Error, scrubbing secrets: [String] = []) -> VaultFailure {
    if let failure = error as? VaultFailure {
      return failure
    }

    if let rpc = error as? GatewayRPCError {
      switch rpc.kind {
      case .notConnected, .closed, .timeout: return .offline
      case .rejected:
        if rpc.code == -32601 {
          return .unsupported
        }

        if rpc.code == 4033 {
          return .refused
        }

        return .failed(CapabilityText.line(scrub(rpc.message, secrets)))
      case .unencodable, .unexpectedResult: return .failed(CapabilityText.line(scrub(rpc.message, secrets)))
      }
    }

    if error is CancellationError {
      return .offline
    }

    return .failed(CapabilityText.line(scrub(ChatResolver.describe(error), secrets)))
  }

  /// `text` with every secret in it replaced (`scrub_secret_from_text`: three characters and up, exact).
  static func scrub(_ text: String, _ secrets: [String]) -> String {
    var scrubbed = text

    for secret in secrets where secret.count >= 3 {
      scrubbed = scrubbed.replacingOccurrences(of: secret, with: "[REDACTED]")
    }

    return scrubbed
  }
}

/// A site as the gateway takes it: `normalize_origin` needs a scheme, so a bare host gets `https://`.
public enum VaultOrigin {
  public static func normalized(_ typed: String) -> String {
    let site = typed.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !site.isEmpty else {
      return ""
    }

    return site.contains("://") ? site : "https://" + site
  }
}
