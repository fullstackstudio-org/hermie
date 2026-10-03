import CryptoKit
import Foundation
import HermieCore
import Synchronization

// The passkey lab's phone: the software authenticator of `HermiePasskeyTesting`, compiled into this
// debug-only host (and into no shipped app, no extension and no library product) so the UI tests can
// drive the confirm sheet and the Passkeys page against a fake gateway with no system sheet.
//
// `-HermiePasskeyPhone <seed>` makes the phone's key and credential id a function of the seed, so a
// later launch is the same passkey: the fake gateway limits how many a person may enrol per ten
// minutes, so a test enrols once and the others launch the phone it enrolled.
// `-HermiePasskeyTamper once|always` flips a bit of the signature of the first (or of every)
// assertion, for the gateway to refuse.

enum LabPasskeyPhone {
  static func make() -> any PasskeyAuthenticator {
    let defaults = UserDefaults.standard
    let seed = defaults.string(forKey: "HermiePasskeyPhone") ?? UUID().uuidString
    let key = P256.Signing.PrivateKey.derived(from: seed)
    let id = Array(SHA256.hash(data: Data("id:\(seed)".utf8)).prefix(16))
    let phone = SoftPasskeyAuthenticator(credentialID: id, privateKey: key)
    var tampering = SoftPasskeyAuthenticator.Tampering()
    tampering.flipSignatureBit = true

    switch defaults.string(forKey: "HermiePasskeyTamper") {
    case "always":
      phone.setTampering(tampering)
      return phone
    case "once":
      return TamperingOnce(phone: phone, tampering: tampering)
    default:
      return phone
    }
  }
}

extension P256.Signing.PrivateKey {
  /// A key that is a function of `seed`: the same text, the same key.
  fileprivate static func derived(from seed: String) -> P256.Signing.PrivateKey {
    let bytes = Data(SHA256.hash(data: Data("key:\(seed)".utf8)))
    return (try? P256.Signing.PrivateKey(rawRepresentation: bytes)) ?? P256.Signing.PrivateKey()
  }
}

/// Wrong on the first assertion, honest after it: the person's retry then goes through.
private final class TamperingOnce: PasskeyAuthenticator {
  let phone: SoftPasskeyAuthenticator
  let tampering: SoftPasskeyAuthenticator.Tampering
  private let spent = Mutex(false)

  init(phone: SoftPasskeyAuthenticator, tampering: SoftPasskeyAuthenticator.Tampering) {
    self.phone = phone
    self.tampering = tampering
  }

  func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    try await phone.register(request)
  }

  func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    let first = spent.withLock { spent -> Bool in
      defer { spent = true }
      return !spent
    }

    phone.setTampering(first ? tampering : SoftPasskeyAuthenticator.Tampering())
    return try await phone.assert(request)
  }

  func cancel() async {
    await phone.cancel()
  }
}
