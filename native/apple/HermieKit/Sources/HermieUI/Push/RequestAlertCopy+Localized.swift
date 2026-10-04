import Foundation
import HermieCore

extension RequestAlertCopy {
  /**
   What a local notification about a request says, in the reader's language: the contract's own
   words (`contract/push/contract.json`, `examples`), so a request reads the same whether this app
   raised it or a gateway's push did.
   */
  public static var localized: RequestAlertCopy {
    RequestAlertCopy(
      attention: String(
        localized: "native.requestAlert.attention", defaultValue: "Needs your attention", table: "Native",
        bundle: .module)
    ) { method, level in
      Self.phrase(method, level)
    }
  }

  static func phrase(_ method: PushRequestMethod, _ level: PushConfirmLevel?) -> String {
    switch method {
    case .approval:
      String(
        localized: "native.requestAlert.approval", defaultValue: "Needs your approval", table: "Native",
        bundle: .module)
    case .clarify:
      String(
        localized: "native.requestAlert.clarify", defaultValue: "Asked you a question", table: "Native",
        bundle: .module)
    case .secret:
      String(
        localized: "native.requestAlert.secret", defaultValue: "Needs a secret", table: "Native", bundle: .module)
    case .sudo:
      String(
        localized: "native.requestAlert.sudo", defaultValue: "Needs your password", table: "Native",
        bundle: .module)
    case .vaultUnlockPrompt:
      String(
        localized: "native.requestAlert.vaultUnlock", defaultValue: "Needs your master password", table: "Native",
        bundle: .module)
    case .vaultCode:
      String(
        localized: "native.requestAlert.vaultCode", defaultValue: "Needs a verification code", table: "Native",
        bundle: .module)
    case .vaultSaveLogin:
      String(
        localized: "native.requestAlert.vaultSaveLogin", defaultValue: "Wants to save a login", table: "Native",
        bundle: .module)
    case .confirm:
      level == .passkey
        ? String(
          localized: "native.requestAlert.confirmPasskey", defaultValue: "Confirm this in the app", table: "Native",
          bundle: .module)
        : String(
          localized: "native.requestAlert.confirmPlain", defaultValue: "Needs your confirmation", table: "Native",
          bundle: .module)
    case .inputForm:
      String(
        localized: "native.requestAlert.form", defaultValue: "Has a form for you", table: "Native", bundle: .module)
    case .inputFile:
      String(localized: "native.requestAlert.file", defaultValue: "Needs a file", table: "Native", bundle: .module)
    case .reviewDraft:
      String(
        localized: "native.requestAlert.draft", defaultValue: "Has a draft to review", table: "Native",
        bundle: .module)
    case .reviewDiff:
      String(
        localized: "native.requestAlert.diff", defaultValue: "Has changes to review", table: "Native",
        bundle: .module)
    case .inputSignature:
      String(
        localized: "native.requestAlert.signature", defaultValue: "Needs your signature", table: "Native",
        bundle: .module)
    case .deviceLocation:
      String(
        localized: "native.requestAlert.location", defaultValue: "Needs your location", table: "Native",
        bundle: .module)
    case .deviceContact:
      String(
        localized: "native.requestAlert.contact", defaultValue: "Needs a contact", table: "Native", bundle: .module)
    case .deviceCalendar:
      String(
        localized: "native.requestAlert.calendar", defaultValue: "Has an event for your calendar", table: "Native",
        bundle: .module)
    case .deviceScan:
      String(localized: "native.requestAlert.scan", defaultValue: "Needs a scan", table: "Native", bundle: .module)
    }
  }
}
