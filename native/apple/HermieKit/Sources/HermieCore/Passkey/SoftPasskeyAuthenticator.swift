import CryptoKit
import Foundation
import HermieGateway
import Synchronization

/**
 A software passkey authenticator for tests (ES256, attestation `none`): what a platform
 authenticator and its client return for a registration and an assertion, so the model, the fake
 gateway and the contract's verifier can be driven end to end without a device. The port of
 `packages/fake-gateway/src/testing/soft-authenticator.ts`.

 A test double: one credential per instance, its private key generated in memory. A synced passkey
 sets BE and BS and keeps its counter at 0; a device-bound one counts up with every assertion. The
 user handle is the one the registration was made with (the gateway's `user.handle`), as a platform
 authenticator stores it.
 */
public final class SoftPasskeyAuthenticator: PasskeyAuthenticator {
  /// The native RP of the official build and the client origin its ceremonies report.
  public static let nativeRPID = "confirm.hermie.dev"
  public static let nativeClientOrigin = "https://confirm.hermie.dev"

  /// What to get wrong, for a test of what a verifier refuses. Applies to every ceremony until reset.
  public struct Tampering: Sendable {
    /// Replace the authenticator data flags byte.
    public var flags: UInt8?
    /// Replace the signCount written into the authenticator data.
    public var signCount: UInt32?
    /// Replace the `origin` the client reports in `clientDataJSON`.
    public var clientOrigin: String?
    /// Replace the `type` the client reports in `clientDataJSON`.
    public var clientType: String?
    /// Hash this RP id into the authenticator data instead of the real one.
    public var rpIDHashOf: String?
    /// Sign over another challenge than the one asked for (one bit flipped).
    public var flipChallengeBit = false
    /// Flip one bit of the DER signature.
    public var flipSignatureBit = false
    /// Sign with another key.
    public var signWith: P256.Signing.PrivateKey?
    /// Leave the user handle out.
    public var omitUserHandle = false

    public init() {}
  }

  private struct State {
    var signCount: UInt32
    var userHandle: [UInt8]?
    var tampering = Tampering()
    var running = false
    var ceremonies = 0
  }

  public let rpID: String
  public let clientOrigin: String
  public let synced: Bool
  public let credentialID: [UInt8]
  public let privateKey: P256.Signing.PrivateKey
  public let aaguid: [UInt8]
  public let transports: [String]
  private let state: Mutex<State>

  public init(
    rpID: String = SoftPasskeyAuthenticator.nativeRPID,
    clientOrigin: String = SoftPasskeyAuthenticator.nativeClientOrigin,
    synced: Bool = true,
    signCount: UInt32 = 0,
    credentialID: [UInt8]? = nil,
    privateKey: P256.Signing.PrivateKey = P256.Signing.PrivateKey(),
    userHandle: [UInt8]? = nil,
    aaguid: [UInt8] = Array(repeating: 0, count: 16),
    transports: [String] = ["internal"]
  ) {
    self.rpID = rpID
    self.clientOrigin = clientOrigin
    self.synced = synced
    self.credentialID = credentialID ?? (0..<32).map { _ in UInt8.random(in: 0...255) }
    self.privateKey = privateKey
    self.aaguid = aaguid
    self.transports = transports
    self.state = Mutex(State(signCount: signCount, userHandle: userHandle))
  }

  /// The credential id as the wire spells it.
  public var id: String { Base64URL.encode(credentialID) }

  /// The counter the next device-bound assertion counts up from.
  public var signCount: UInt32 { state.withLock { $0.signCount } }

  /// How many ceremonies ran (registrations and assertions).
  public var ceremonies: Int { state.withLock { $0.ceremonies } }

  /// The flags of an honest ceremony: UP and UV, plus BE and BS for a synced passkey.
  public var flags: UInt8 { 0x01 | 0x04 | (synced ? 0x08 | 0x10 : 0) }

  public func setTampering(_ tampering: Tampering) {
    state.withLock { $0.tampering = tampering }
  }

  /// The same passkey again (same key, same id), for "this passkey is already enrolled".
  public func clone() -> SoftPasskeyAuthenticator {
    let held = state.withLock { $0 }
    return SoftPasskeyAuthenticator(
      rpID: rpID,
      clientOrigin: clientOrigin,
      synced: synced,
      signCount: held.signCount,
      credentialID: credentialID,
      privateKey: privateKey,
      userHandle: held.userHandle,
      aaguid: aaguid,
      transports: transports
    )
  }

  // MARK: - PasskeyAuthenticator

  public func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    let tampering = try begin(rpID: request.rpID)
    defer { end() }

    guard !request.excludeCredentialIDs.contains(credentialID) else {
      throw .failed("This passkey is already registered here.")
    }

    state.withLock { $0.userHandle = request.userHandle }

    let clientData = Self.clientData(
      type: tampering.clientType ?? "webauthn.create",
      challenge: Self.applied(tampering, to: request.challenge),
      origin: tampering.clientOrigin ?? clientOrigin
    )
    let authData = authenticatorData(tampering, counter: tampering.signCount ?? signCount, attested: true)
    let attestation = SoftCBOR.map([
      (SoftCBOR.text("fmt"), SoftCBOR.text("none")),
      (SoftCBOR.text("attStmt"), SoftCBOR.map([])),
      (SoftCBOR.text("authData"), SoftCBOR.bytes(authData))
    ])

    return PasskeyRegistration(
      credentialID: credentialID,
      clientDataJSON: clientData,
      attestationObject: attestation,
      transports: transports
    )
  }

  public func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    let tampering = try begin(rpID: request.rpID)
    defer { end() }

    guard request.allowCredentialIDs.contains(credentialID) else {
      throw .noCredential
    }

    let counter = state.withLock { held -> UInt32 in
      if !synced {
        held.signCount &+= 1
      }
      return held.signCount
    }
    let clientData = Self.clientData(
      type: tampering.clientType ?? "webauthn.get",
      challenge: Self.applied(tampering, to: request.challenge),
      origin: tampering.clientOrigin ?? clientOrigin
    )
    let authData = authenticatorData(tampering, counter: tampering.signCount ?? counter, attested: false)
    let signer = tampering.signWith ?? privateKey
    let message = authData + Array(SHA256.hash(data: clientData))

    guard var signature = try? Array(signer.signature(for: message).derRepresentation) else {
      throw .failed("The test key could not sign.")
    }

    if tampering.flipSignatureBit {
      signature[signature.count - 1] ^= 0x01
    }

    let handle = state.withLock { $0.userHandle }

    return PasskeyAssertionResponse(
      credentialID: credentialID,
      authenticatorData: authData,
      clientDataJSON: clientData,
      signature: signature,
      userHandle: tampering.omitUserHandle ? nil : handle
    )
  }

  public func cancel() async {}

  // MARK: - Building

  private func begin(rpID requested: String) throws(PasskeyCeremonyError) -> Tampering {
    let outcome = state.withLock { held -> Result<Tampering, PasskeyCeremonyError> in
      guard !held.running else {
        return .failure(.busy)
      }

      held.running = true
      held.ceremonies += 1
      return .success(held.tampering)
    }

    let tampering = try outcome.get()

    guard requested == rpID else {
      end()
      throw .unavailable(reason: "rp_not_supported")
    }

    return tampering
  }

  private func end() {
    state.withLock { $0.running = false }
  }

  private func authenticatorData(_ tampering: Tampering, counter: UInt32, attested: Bool) -> [UInt8] {
    var data = Array(SHA256.hash(data: Array((tampering.rpIDHashOf ?? rpID).utf8)))
    data.append(tampering.flags ?? (flags | (attested ? 0x40 : 0)))
    data += [UInt8(counter >> 24 & 0xFF), UInt8(counter >> 16 & 0xFF), UInt8(counter >> 8 & 0xFF), UInt8(counter & 0xFF)]

    guard attested else {
      return data
    }

    let raw = privateKey.publicKey.rawRepresentation
    let cose = SoftCBOR.map([
      (SoftCBOR.int(1), SoftCBOR.int(2)),
      (SoftCBOR.int(3), SoftCBOR.int(-7)),
      (SoftCBOR.int(-1), SoftCBOR.int(1)),
      (SoftCBOR.int(-2), SoftCBOR.bytes(Array(raw.prefix(32)))),
      (SoftCBOR.int(-3), SoftCBOR.bytes(Array(raw.suffix(32))))
    ])

    data += aaguid
    data += [UInt8(credentialID.count >> 8 & 0xFF), UInt8(credentialID.count & 0xFF)]
    data += credentialID
    data += cose
    return data
  }

  private static func applied(_ tampering: Tampering, to challenge: [UInt8]) -> [UInt8] {
    guard tampering.flipChallengeBit, !challenge.isEmpty else {
      return challenge
    }

    var flipped = challenge
    flipped[0] ^= 0x01
    return flipped
  }

  /// `{"type":…,"challenge":…,"origin":…,"crossOrigin":false}`, as a browser writes it.
  static func clientData(type: String, challenge: [UInt8], origin: String) -> [UInt8] {
    let object: JSONObjectText = [
      ("type", .string(type)),
      ("challenge", .string(Base64URL.encode(challenge))),
      ("origin", .string(origin)),
      ("crossOrigin", .bool(false))
    ]
    return Array(object.text.utf8)
  }
}

/// A JSON object written in the order given (`JSON.stringify` keeps insertion order).
struct JSONObjectText: ExpressibleByArrayLiteral {
  enum Value {
    case string(String)
    case bool(Bool)
  }

  var members: [(String, Value)]

  init(arrayLiteral elements: (String, Value)...) {
    members = elements
  }

  var text: String {
    let body = members.map { key, value -> String in
      switch value {
      case .string(let string): "\(Self.quoted(key)):\(Self.quoted(string))"
      case .bool(let bool): "\(Self.quoted(key)):\(bool)"
      }
    }
    return "{" + body.joined(separator: ",") + "}"
  }

  static func quoted(_ string: String) -> String {
    var out = "\""
    for scalar in string.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
      default: out.unicodeScalars.append(scalar)
      }
    }
    return out + "\""
  }
}

/// Definite-length CBOR for exactly what an attestation object and a COSE key hold.
enum SoftCBOR {
  static func head(_ major: UInt8, _ value: UInt64) -> [UInt8] {
    switch value {
    case 0..<24: [major << 5 | UInt8(value)]
    case 24..<0x100: [major << 5 | 24, UInt8(value)]
    case 0x100..<0x10000: [major << 5 | 25, UInt8(value >> 8), UInt8(value & 0xFF)]
    default: [major << 5 | 26] + (0..<4).reversed().map { UInt8(value >> ($0 * 8) & 0xFF) }
    }
  }

  static func int(_ value: Int) -> [UInt8] {
    value >= 0 ? head(0, UInt64(value)) : head(1, UInt64(-1 - value))
  }

  static func text(_ value: String) -> [UInt8] {
    let bytes = Array(value.utf8)
    return head(3, UInt64(bytes.count)) + bytes
  }

  static func bytes(_ value: [UInt8]) -> [UInt8] {
    head(2, UInt64(value.count)) + value
  }

  static func map(_ entries: [([UInt8], [UInt8])]) -> [UInt8] {
    entries.reduce(head(5, UInt64(entries.count))) { $0 + $1.0 + $1.1 }
  }
}
