import Foundation
import Observation

/// One field of an item's secret payload, as `vault.add` names it (`PAYMENT_FIELDS`, `ADDRESS_FIELDS`, and a
/// login's `password` and `otp_secret`).
public struct VaultSecretField: Sendable, Hashable, Identifiable {
  /// How the field is typed into.
  public enum Entry: Sendable, Hashable {
    /// The login's password: masked, and the system's password manager may fill it.
    case password
    /// Masked, with nothing the system offers (an authenticator key, card details).
    case masked
    /// Masked digits (a card number, its code, an expiry).
    case maskedNumber
    /// Shown as typed: an address, which the gateway also keeps encrypted, and which a person must be able to
    /// check (as `hermes vault add` reads it).
    case plain
  }

  /// The wire name.
  public let key: String
  public let required: Bool
  public let entry: Entry

  public var id: String { key }

  public init(_ key: String, required: Bool, entry: Entry) {
    self.key = key
    self.required = required
    self.entry = entry
  }

  /// The fields of `kind`, in the order the gateway's own wizard asks for them.
  public static func fields(for kind: VaultKind) -> [VaultSecretField] {
    switch kind {
    case .login:
      [VaultSecretField("password", required: true, entry: .password),
       VaultSecretField("otp_secret", required: false, entry: .masked)]
    case .payment:
      [VaultSecretField("card_number", required: true, entry: .maskedNumber),
       VaultSecretField("cardholder_name", required: false, entry: .masked),
       VaultSecretField("exp_month", required: true, entry: .maskedNumber),
       VaultSecretField("exp_year", required: true, entry: .maskedNumber),
       VaultSecretField("cvc", required: true, entry: .maskedNumber),
       VaultSecretField("billing_postal_code", required: false, entry: .masked)]
    case .address:
      [VaultSecretField("address_line1", required: true, entry: .plain),
       VaultSecretField("address_line2", required: false, entry: .plain),
       VaultSecretField("city", required: true, entry: .plain),
       VaultSecretField("state", required: false, entry: .plain),
       VaultSecretField("postal_code", required: true, entry: .plain),
       VaultSecretField("country", required: true, entry: .plain)]
    }
  }
}

/**
 What the Add sheet has typed, until Save sends it or the sheet goes.

 The secret fields are `SecretValue`s: nothing that describes the form shows them. Nothing here is stored,
 written to disk, put on the pasteboard or logged; the form lives as long as its sheet.

 - `take()` (Save) moves the secret out into the request and empties the secret fields at once, before
   anything is sent: a refused add asks for the secret again, it never keeps it for a retry.
 - `leftForeground()` (the app went to the background) empties the secret fields.
 - `clear()` (the sheet went, or the item was stored) empties everything.
 - Changing the kind empties the secret fields: another kind has other ones.
 */
@MainActor
@Observable
public final class VaultAddForm {
  public var kind: VaultKind = .login {
    didSet {
      if kind != oldValue {
        clearSecrets()
      }
    }
  }

  public var label = ""
  /// The site the item is for, as typed (a bare host gets `https://` when it is sent).
  public var site = ""
  public var identifierType: VaultIdentifierType = .email
  /// The login's email, username or phone: metadata the bot may see, not a secret.
  public var identifier = ""
  /// The secret fields, by wire name.
  public private(set) var secrets: [String: SecretValue] = [:]

  public init() {}

  public var fields: [VaultSecretField] { VaultSecretField.fields(for: kind) }

  public func secret(_ key: String) -> SecretValue {
    secrets[key] ?? SecretValue()
  }

  public func setSecret(_ key: String, _ text: String) {
    secrets[key] = text.isEmpty ? nil : SecretValue(text)
  }

  /// Every secret field is empty.
  public var secretsEmpty: Bool {
    secrets.values.allSatisfy(\.isEmpty)
  }

  /// Everything the kind requires is filled in: a label, the site, a login's identifier, the required secret
  /// fields.
  public var isComplete: Bool {
    guard !trimmed(label).isEmpty, !trimmed(site).isEmpty else {
      return false
    }

    if kind == .login, trimmed(identifier).isEmpty {
      return false
    }

    return fields.filter(\.required).allSatisfy { !trimmed(secret($0.key).revealed).isEmpty }
  }

  /// Save: the request to send, with the secret moved out of the form (its fields are empty when this
  /// returns). Nil when the form is not complete, and then nothing is moved.
  public func take() -> VaultAddRequest? {
    guard isComplete else {
      return nil
    }

    var payload: [String: SecretValue] = [:]

    for field in fields {
      let value = secret(field.key)

      if !trimmed(value.revealed).isEmpty {
        payload[field.key] = field.entry == .password ? value : SecretValue(trimmed(value.revealed))
      }
    }

    let request = VaultAddRequest(
      kind: kind,
      label: trimmed(label),
      origin: VaultOrigin.normalized(site),
      identifierType: kind == .login ? identifierType : nil,
      identifier: kind == .login ? trimmed(identifier) : nil,
      secret: payload
    )

    clearSecrets()
    return request
  }

  /// Save, and on success clear the whole form. The secret is out of the form before the call starts and is
  /// not put back on a refusal.
  @discardableResult
  public func submit(to model: VaultModel) async -> Bool {
    guard let request = take() else {
      return false
    }

    let stored = await model.add(request)

    if stored {
      clear()
    }

    return stored
  }

  /// The app went to the background: the secret fields are emptied (the rest stays, so the person does not
  /// type the label and the site again).
  public func leftForeground() {
    clearSecrets()
  }

  public func clearSecrets() {
    secrets.removeAll()
  }

  /// The sheet went: everything is emptied.
  public func clear() {
    clearSecrets()
    label = ""
    site = ""
    identifier = ""
    identifierType = .email
  }

  private func trimmed(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

/// What the Unlock sheet has typed: one password manager's master password, under the same rules as the Add
/// sheet's secret fields.
@MainActor
@Observable
public final class VaultUnlockForm {
  public let source: VaultSource
  public var password = SecretValue()

  public init(source: VaultSource) {
    self.source = source
  }

  /// Unlock: the password is out of the form before the call starts, whatever the answer.
  @discardableResult
  public func submit(to model: VaultModel) async -> Bool {
    guard !password.isEmpty else {
      return false
    }

    let typed = password
    password.clear()
    return await model.unlock(source.name, password: typed)
  }

  public func clear() {
    password.clear()
  }
}
