import Foundation
import HermieStore

extension PasskeyConfiguration {
  /// The Info.plist key both app shells fill from the build setting `HERMIE_PASSKEY_RP_ID`
  /// (`Config/Shared.xcconfig`), the host of the app's `webcredentials` associated domain.
  public static let rpIDInfoKey = "HermiePasskeyRPID"

  /**
   This build's configuration, read at launch from the bundle's Info.plist. A build whose setting is
   empty (and so has no associated domain) gets `rpID: nil`, which never advertises the level; so
   does a value that is not a host name (an unexpanded `$(…)`, a scheme, a path).
   */
  public static func live(bundle: Bundle = .main) -> PasskeyConfiguration {
    PasskeyConfiguration(rpID: rpID(fromInfo: bundle.infoDictionary ?? [:]))
  }

  /// The RP in an Info.plist dictionary, or `nil` when there is none that can be one.
  static func rpID(fromInfo info: [String: Any]) -> String? {
    guard let raw = info[rpIDInfoKey] as? String else {
      return nil
    }

    let host = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    return isHostName(host) ? host : nil
  }

  /// A DNS name of at least two labels: letters, digits and inner hyphens, 63 characters a label.
  static func isHostName(_ text: String) -> Bool {
    let labels = text.split(separator: ".", omittingEmptySubsequences: false)

    guard labels.count >= 2, text.utf8.count <= 253 else {
      return false
    }

    return labels.allSatisfy(isLabel)
  }

  private static func isLabel(_ label: Substring) -> Bool {
    guard (1...63).contains(label.utf8.count), label.first != "-", label.last != "-" else {
      return false
    }

    return label.utf8.allSatisfy { byte in
      (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
        || byte == UInt8(ascii: "-")
    }
  }
}

extension PasskeySetup {
  /**
   The app's passkey setup: this build's configuration, the given authenticator wrapped so the app
   lock treats its sheet like its own prompt (plan P10), and the pins in the launch's database (one
   key per stored gateway). Built once per launch, so one authenticator, and one ceremony at a
   time, serves every gateway.
   */
  @MainActor
  public static func live(
    configuration: PasskeyConfiguration,
    authenticator: any PasskeyAuthenticator,
    lock: AppLock,
    keyValues: KeyValueStore
  ) -> PasskeySetup {
    PasskeySetup(
      configuration: configuration,
      authenticator: LockGuardedPasskeyAuthenticator(authenticator, lock: lock),
      pins: KeyValuePasskeyPins(store: keyValues)
    )
  }
}
