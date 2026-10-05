import Foundation
import HermieCore

/// The Vault page's own sentences, from `Resources/Native.xcstrings`.
extension NativeStrings {
  enum Vault {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Vault
    static var title: String { string("native.vault.title") }
    /// Stored on the gateway, encrypted, in {bot}'s own vault…
    static func about(_ bot: String) -> String {
      String(
        localized: "native.vault.about",
        defaultValue:
          "Stored on the gateway, encrypted, in \(bot)'s own vault. \(bot) can use them to sign in and fill in forms. Hermie never shows what they hold.",
        table: "Native", bundle: .module)
    }
    /// Items
    static var items: String { string("native.vault.items") }
    /// Nothing in this vault yet.
    static var empty: String { string("native.vault.empty") }
    /// Reading the vault…
    static var loading: String { string("native.vault.loading") }
    /// This gateway has no vault.
    static var unsupported: String { string("native.vault.unsupported") }
    /// The vault cannot be reached without a connection.
    static var offline: String { string("native.vault.offline") }
    /// The gateway does not allow this from here.
    static var refused: String { string("native.vault.refused") }
    /// The vault did not answer in time.
    static var loadTimedOut: String { string("native.vault.loadTimedOut") }
    /// No answer in time. It may have gone through: check the list.
    static var timedOut: String { string("native.vault.timedOut") }
    /// The vault could not be read: {reason}
    static func failed(_ reason: String) -> String {
      String(
        localized: "native.vault.failed", defaultValue: "The vault could not be read: \(reason)", table: "Native",
        bundle: .module)
    }
    /// That did not work: {reason}
    static func actionFailed(_ reason: String) -> String {
      String(localized: "native.vault.actionFailed", defaultValue: "That did not work: \(reason)", table: "Native", bundle: .module)
    }
    /// That did not work.
    static var actionFailedNoReason: String { string("native.vault.actionFailedNoReason") }
    /// Kind
    static var kind: String { string("native.vault.kind") }
    /// Login / Card / Address
    static func kindName(_ kind: VaultKind) -> String {
      switch kind {
      case .login: string("native.vault.kind.login")
      case .payment: string("native.vault.kind.payment")
      case .address: string("native.vault.kind.address")
      }
    }
    /// From {manager}
    static func inManager(_ name: String) -> String {
      String(localized: "native.vault.inManager", defaultValue: "From \(name)", table: "Native", bundle: .module)
    }
    /// With authenticator
    static var withOTP: String { string("native.vault.withOTP") }
    /// Add
    static var add: String { string("native.vault.add") }
    /// Add to {bot}'s vault
    static func addTitle(_ bot: String) -> String {
      String(localized: "native.vault.addTitle", defaultValue: "Add to \(bot)'s vault", table: "Native", bundle: .module)
    }
    /// Label
    static var label: String { string("native.vault.label") }
    /// For example: GitHub work account
    static var labelPrompt: String { string("native.vault.labelPrompt") }
    /// Site
    static var site: String { string("native.vault.site") }
    /// Sign in with
    static var identifierType: String { string("native.vault.identifierType") }
    /// Email / Username / Phone number
    static func identifierName(_ type: VaultIdentifierType) -> String {
      switch type {
      case .email: string("native.vault.identifier.email")
      case .username: string("native.vault.identifier.username")
      case .phone: string("native.vault.identifier.phone")
      }
    }
    /// The label of one secret field.
    static func fieldName(_ key: String) -> String {
      switch key {
      case "password": string("native.vault.field.password")
      case "otp_secret": string("native.vault.field.otp")
      case "card_number": string("native.vault.field.cardNumber")
      case "cardholder_name": string("native.vault.field.cardholder")
      case "exp_month": string("native.vault.field.expMonth")
      case "exp_year": string("native.vault.field.expYear")
      case "cvc": string("native.vault.field.cvc")
      case "billing_postal_code": string("native.vault.field.billingPostal")
      case "address_line1": string("native.vault.field.line1")
      case "address_line2": string("native.vault.field.line2")
      case "city": string("native.vault.field.city")
      case "state": string("native.vault.field.state")
      case "postal_code": string("native.vault.field.postalCode")
      case "country": string("native.vault.field.country")
      default: key
      }
    }
    /// Hermie sends this once to the gateway, which keeps it encrypted in {bot}'s own vault…
    static func receiver(_ bot: String) -> String {
      String(
        localized: "native.vault.receiver",
        defaultValue:
          "Hermie sends this once to the gateway, which keeps it encrypted in \(bot)'s own vault. Hermie does not keep it.",
        table: "Native", bundle: .module)
    }
    /// Save
    static var save: String { string("native.vault.save") }
    /// Saving…
    static var saving: String { string("native.vault.saving") }
    /// Not saved: {reason}. Enter the secret again.
    static func addFailed(_ reason: String) -> String {
      String(
        localized: "native.vault.addFailed", defaultValue: "Not saved: \(reason). Enter the secret again.", table: "Native",
        bundle: .module)
    }
    /// Not saved. Enter the secret again.
    static var addFailedNoReason: String { string("native.vault.addFailedNoReason") }
    /// Remove
    static var remove: String { string("native.vault.remove") }
    /// Remove {label} from the vault?
    static func removeTitle(_ label: String) -> String {
      String(localized: "native.vault.removeTitle", defaultValue: "Remove \(label) from the vault?", table: "Native", bundle: .module)
    }
    /// {bot} can no longer use it. This cannot be undone.
    static func removeMessage(_ bot: String) -> String {
      String(
        localized: "native.vault.removeMessage", defaultValue: "\(bot) can no longer use it. This cannot be undone.",
        table: "Native", bundle: .module)
    }
    /// Password managers
    static var sources: String { string("native.vault.sources") }
    /// Password managers on the gateway's computer…
    static func sourcesNote(_ bot: String) -> String {
      String(
        localized: "native.vault.sourcesNote",
        defaultValue:
          "Password managers on the gateway's computer. While one is unlocked, \(bot) can use its logins too.",
        table: "Native", bundle: .module)
    }
    /// Locked
    static var locked: String { string("native.vault.locked") }
    /// Unlocked
    static var unlocked: String { string("native.vault.unlocked") }
    /// Not installed
    static var notInstalled: String { string("native.vault.notInstalled") }
    /// Lock
    static var lock: String { string("native.vault.lock") }
    /// Unlock
    static var unlock: String { string("native.vault.unlock") }
    /// Use {manager}
    static func use(_ name: String) -> String {
      String(localized: "native.vault.use", defaultValue: "Use \(name)", table: "Native", bundle: .module)
    }
    /// Unlock {manager}
    static func unlockTitle(_ name: String) -> String {
      String(localized: "native.vault.unlockTitle", defaultValue: "Unlock \(name)", table: "Native", bundle: .module)
    }
    /// Master password
    static var masterPassword: String { string("native.vault.masterPassword") }
    /// Hermie sends this once to the gateway, which hands it to {manager} there…
    static func unlockReceiver(_ name: String) -> String {
      String(
        localized: "native.vault.unlockReceiver",
        defaultValue:
          "Hermie sends this once to the gateway, which hands it to \(name) there and does not keep it. Hermie does not keep it either.",
        table: "Native", bundle: .module)
    }
    /// Not unlocked: {reason}
    static func unlockFailed(_ reason: String) -> String {
      String(localized: "native.vault.unlockFailed", defaultValue: "Not unlocked: \(reason)", table: "Native", bundle: .module)
    }
    /// Not unlocked.
    static var unlockFailedNoReason: String { string("native.vault.unlockFailedNoReason") }
    /// Unlocking…
    static var unlocking: String { string("native.vault.unlocking") }
  }
}

/// How the Vault page words a failure: its own sentence for each kind, the gateway's words where it had some.
enum VaultWords {
  static func load(_ failure: VaultFailure) -> String {
    switch failure {
    case .unsupported: NativeStrings.Vault.unsupported
    case .offline: NativeStrings.Vault.offline
    case .timedOut: NativeStrings.Vault.loadTimedOut
    case .refused: NativeStrings.Vault.refused
    case .failed(let reason): reason.isEmpty ? NativeStrings.Vault.unsupported : NativeStrings.Vault.failed(reason)
    }
  }

  static func action(_ failure: VaultFailure) -> String {
    switch failure {
    case .unsupported: NativeStrings.Vault.unsupported
    case .offline: NativeStrings.Vault.offline
    case .timedOut: NativeStrings.Vault.timedOut
    case .refused: NativeStrings.Vault.refused
    case .failed(let reason):
      reason.isEmpty ? NativeStrings.Vault.actionFailedNoReason : NativeStrings.Vault.actionFailed(reason)
    }
  }

  static func add(_ failure: VaultFailure) -> String {
    switch failure {
    case .failed(let reason) where !reason.isEmpty: NativeStrings.Vault.addFailed(reason)
    case .failed: NativeStrings.Vault.addFailedNoReason
    default: action(failure)
    }
  }

  static func unlock(_ failure: VaultFailure) -> String {
    switch failure {
    case .failed(let reason) where !reason.isEmpty: NativeStrings.Vault.unlockFailed(reason)
    case .failed: NativeStrings.Vault.unlockFailedNoReason
    default: action(failure)
    }
  }

  /// What an item is, in a word: the kind's name, or the gateway's word for a kind this app does not know.
  static func kind(_ item: VaultItem) -> String {
    item.knownKind.map(NativeStrings.Vault.kindName) ?? item.kind
  }

  static func symbol(_ item: VaultItem) -> String {
    switch item.knownKind {
    case .login: "person.badge.key"
    case .payment: "creditcard"
    case .address: "house"
    case nil: "key"
    }
  }
}
