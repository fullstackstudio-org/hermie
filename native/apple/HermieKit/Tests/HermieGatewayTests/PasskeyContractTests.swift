import CryptoKit
import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// `contract/confirm-passkey/vectors.json`, byte for byte: base URLs (§3), text digests (§4),
/// challenges with their preimages (§5), user handles (§6), enrolment codes (§7), and the client's
/// half of every positive assertion vector (the challenge it would sign, the message the signature
/// covers).
@Suite struct PasskeyContractTests {
  static let vectors: JSONValue = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    let file = url.appendingPathComponent("contract/confirm-passkey/vectors.json")
    return (try? JSONValue(parsing: Data(contentsOf: file))) ?? .null
  }()

  static func list(_ key: String) -> [JSONValue] {
    vectors[key]?.arrayValue ?? []
  }

  static func bytes(_ value: JSONValue?) throws -> [UInt8] {
    try #require(value?.stringValue.flatMap(Base64URL.decode), "not base64url: \(String(describing: value))")
  }

  static func hex(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
  }

  @Test("the vectors file is there and speaks version 1")
  func version() {
    #expect(Self.vectors["version"]?.doubleValue == 1)
    #expect(Self.list("challenge_vectors").count >= 11)
  }

  // MARK: §2

  @Test("base64url refuses padding, foreign characters and non-canonical trailing bits")
  func base64url() {
    #expect(Base64URL.decode("AQID") == [1, 2, 3])
    #expect(Base64URL.decode("AQ") == [1])
    #expect(Base64URL.decode("") == [])
    #expect(Base64URL.decode("AQ==") == nil)
    #expect(Base64URL.decode("AR") == nil, "trailing bits set")
    #expect(Base64URL.decode("A+") == nil)
    #expect(Base64URL.decode("A/") == nil)
    #expect(Base64URL.decode("A") == nil)
    #expect(Base64URL.decode("AQ ") == nil)
    #expect(Base64URL.encode([0xFB, 0xFF]) == "-_8")
    #expect(Base64URL.decode("-_8") == [0xFB, 0xFF])
  }

  // MARK: §3

  @Test("base URL vectors")
  func baseURLs() throws {
    let vectors = Self.list("base_url_vectors")
    #expect(vectors.count >= 31)

    for vector in vectors {
      let input = try #require(vector["input"]?.stringValue)
      let name = vector["name"]?.stringValue ?? input

      if vector["error"] != nil {
        #expect(throws: PasskeyBaseURL.Invalid.self, "\(name)") { try PasskeyBaseURL.serialise(input) }
        continue
      }

      let serialised = try PasskeyBaseURL.serialise(input)
      #expect(serialised == vector["base_url"]?.stringValue, "\(name)")
      #expect(PasskeyBaseURL.origin(of: serialised) == vector["origin"]?.stringValue, "\(name)")
    }
  }

  @Test("a stored gateway address gives the base URL the fake gateway hashes")
  func storedAddress() throws {
    let stored = try GatewayAddress.normalizeBaseURL("127.0.0.1:9119")
    #expect(try GatewayAddress.passkeyBaseURL(of: "http://127.0.0.1:9119") == "http://127.0.0.1:9119")
    #expect(try GatewayAddress.passkeyBaseURL(of: stored) == "https://127.0.0.1:9119")
    #expect(try GatewayAddress.passkeyBaseURL(of: "https://Shared.Example/alice/") == "https://shared.example/alice")
  }

  // MARK: §4

  @Test("text digest vectors")
  func textDigests() throws {
    for vector in Self.list("text_digest_vectors") {
      let digest = PasskeyChallenge.textDigest(
        title: try #require(vector["title"]?.stringValue),
        summary: try #require(vector["summary"]?.stringValue),
        detail: vector["detail"]?.stringValue
      )
      #expect(Base64URL.encode(digest) == vector["text_digest"]?.stringValue, "\(vector["name"]?.stringValue ?? "")")
    }
  }

  // MARK: §4.1

  /// The fields of a vector, in its order.
  static func fields(_ raw: JSONValue?) throws -> [ConfirmField] {
    try (raw?.arrayValue ?? []).map { field in
      ConfirmField(
        id: try #require(field["id"]?.stringValue),
        kind: try #require(field["kind"]?.stringValue.flatMap(ConfirmFieldKind.init(rawValue:))),
        label: try #require(field["label"]?.stringValue),
        value: try #require(field["value"]?.stringValue),
        currency: field["currency"]?.stringValue
      )
    }
  }

  @Test("text digest v2 vectors: preimage and digest, and never the version-1 digest of the same text")
  func textDigestsV2() throws {
    let vectors = Self.list("text_digest_v2_vectors")
    #expect(vectors.count >= 7)

    for vector in vectors {
      let name = vector["name"]?.stringValue ?? ""
      let title = try #require(vector["title"]?.stringValue)
      let summary = try #require(vector["summary"]?.stringValue)
      let detail = vector["detail"]?.stringValue
      let fields = try Self.fields(vector["fields"])

      let preimage = PasskeyChallenge.textDigestV2Preimage(title: title, summary: summary, detail: detail, fields: fields)
      #expect(Self.hex(preimage) == vector["preimage_hex"]?.stringValue, "\(name)")

      let digest = PasskeyChallenge.textDigestV2(title: title, summary: summary, detail: detail, fields: fields)
      #expect(Base64URL.encode(digest) == vector["text_digest"]?.stringValue, "\(name)")

      // The version-1 digest of the same text is the vector's, and never equal.
      let v1 = PasskeyChallenge.textDigest(title: title, summary: summary, detail: detail)
      #expect(Base64URL.encode(v1) == vector["text_digest_v1"]?.stringValue, "\(name)")
      #expect(digest != v1, "\(name)")

      // A display picks the version from its fields.
      let display = ConfirmDisplay(title: title, summary: summary, detail: detail, baseURL: "https://gw.example.com", fields: fields)
      #expect(display.textVersion == 2 && display.textDigest == digest, "\(name)")
      let bare = ConfirmDisplay(title: title, summary: summary, detail: detail, baseURL: "https://gw.example.com")
      #expect(bare.textVersion == 1 && bare.textDigest == v1, "\(name)")
    }
  }

  /// The challenge a client computes for a version-2 vector's request, from what it would show.
  static func challengeV2(_ vector: JSONValue, baseURL: String) throws -> [UInt8] {
    let context = try #require(Self.vectors["contexts"]?[vector["context"]?.stringValue ?? ""])
    let request = try #require(vector["request"])
    let display = ConfirmDisplay(
      title: try #require(request["title"]?.stringValue),
      summary: try #require(request["summary"]?.stringValue),
      detail: request["detail"]?.stringValue,
      baseURL: baseURL,
      fields: try Self.fields(request["fields"])
    )
    let binding = PasskeyChallengeBinding(
      purpose: .confirm,
      gatewayID: try Self.bytes(context["gateway_id"]),
      userID: try #require(request["user_id"]?.stringValue),
      sessionID: try #require(request["session_id"]?.stringValue),
      requestID: try #require(request["request_id"]?.stringValue),
      nonce: try Self.bytes(request["nonce"])
    )
    return PasskeyChallenge.challenge(display, binding)
  }

  @Test("assertion vectors v2: the challenge over the displayed fields is the signed one, and no other text is")
  func assertionVectorsV2() throws {
    let keys = try #require(Self.vectors["keys"]?.objectValue)
    let vectors = Self.list("assertion_vectors_v2")
    #expect(vectors.count == 6)

    for vector in vectors {
      let name = vector["name"]?.stringValue ?? ""
      let passkey = try #require(vector["answer"]?["passkey"])
      let clientData = try Self.bytes(passkey["client_data_json"])
      let signed = try #require(try JSONValue(parsing: Data(clientData))["challenge"]?.stringValue)
      let ours = Base64URL.encode(try Self.challengeV2(vector, baseURL: try #require(passkey["base_url"]?.stringValue)))
      let reason = vector["expect"]?["reason"]?.stringValue

      switch reason {
      case nil:
        // The accepted one: the challenge a client computes from the frame is what was signed, and the
        // signature covers it.
        #expect(ours == signed, "\(name)")

        let key = try #require(keys[vector["signed_by"]?.stringValue ?? ""])
        let publicKey = try P256.Signing.PublicKey(rawRepresentation: Self.bytes(key["x"]) + Self.bytes(key["y"]))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: Self.bytes(passkey["signature"]))
        let message = try Self.bytes(passkey["authenticator_data"]) + Array(SHA256.hash(data: clientData))
        #expect(publicKey.isValidSignature(Self.lowS(signature), for: message), "\(name)")
        #expect(passkey["v"]?.doubleValue == 2, "\(name): the answer repeats v 2")
      case "challenge_mismatch":
        // Signed over the text without the fields, in another order or with another value: not the
        // challenge of what the sheet shows.
        #expect(ours != signed, "\(name)")
      case "bad_shape":
        // The challenge is right; the answer's `v` is not the request's. A client sends the version of
        // the text it hashed (`ConfirmDisplay.textVersion`), which is what the vector tests against.
        #expect(ours == signed, "\(name)")
        let request = try #require(vector["request"])
        let version = (try Self.fields(request["fields"])).isEmpty ? 1 : 2
        #expect(passkey["v"]?.doubleValue != Double(version), "\(name)")
      default:
        Issue.record("\(name): reason \(reason ?? "") not known to this test")
      }
    }
  }

  // MARK: §5

  @Test("challenge vectors, preimage and challenge, every purpose")
  func challenges() throws {
    for vector in Self.list("challenge_vectors") {
      let name = vector["name"]?.stringValue ?? ""
      let purpose = try #require(vector["purpose"]?.stringValue.flatMap(PasskeyPurpose.init(rawValue:)))
      let display = ConfirmDisplay(
        title: vector["title"]?.stringValue ?? "",
        summary: vector["summary"]?.stringValue ?? "",
        detail: vector["detail"]?.stringValue,
        baseURL: try #require(vector["base_url"]?.stringValue)
      )
      let binding = PasskeyChallengeBinding(
        purpose: purpose,
        gatewayID: try Self.bytes(vector["gateway_id"]),
        userID: try #require(vector["user_id"]?.stringValue),
        sessionID: vector["session_id"]?.stringValue ?? "",
        requestID: try #require(vector["request_id"]?.stringValue),
        nonce: try Self.bytes(vector["nonce"])
      )

      #expect(Base64URL.encode(display.textDigest) == vector["text_digest"]?.stringValue, "\(name)")
      #expect(Self.hex(PasskeyChallenge.preimage(display, binding)) == vector["preimage_hex"]?.stringValue, "\(name)")
      #expect(Base64URL.encode(PasskeyChallenge.challenge(display, binding)) == vector["challenge"]?.stringValue, "\(name)")
    }
  }

  // MARK: §6, §7

  @Test("user handle vectors")
  func userHandles() throws {
    for vector in Self.list("user_handle_vectors") {
      let handle = PasskeyChallenge.userHandle(
        handleKey: try Self.bytes(vector["handle_key"]),
        userID: try #require(vector["user_id"]?.stringValue)
      )
      #expect(Base64URL.encode(handle) == vector["user_handle"]?.stringValue)
    }
  }

  @Test("enrolment code vectors")
  func enrolmentCodes() throws {
    for vector in Self.list("enrolment_code_vectors") {
      let input = try #require(vector["input"]?.stringValue)
      let canonical = EnrolmentCode.canonical(input)
      #expect(canonical == vector["canonical"]?.stringValue, "\(vector["name"]?.stringValue ?? input)")

      if let canonical {
        let hash = Array(SHA256.hash(data: Array(canonical.utf8)))
        #expect(Base64URL.encode(hash) == vector["code_hash"]?.stringValue)
      }
    }
  }

  // MARK: §9, the client's half

  /// For every positive assertion vector: the challenge a client computes from the request and the
  /// base URL it names is the one in the vector's `clientDataJSON`, and the stored signature
  /// verifies over `authenticator_data ‖ SHA-256(client_data_json)` with the signer's key.
  @Test("positive assertion vectors: the challenge a client computes, and what the signature covers")
  func positiveAssertions() throws {
    let contexts = try #require(Self.vectors["contexts"]?.objectValue)
    let keys = try #require(Self.vectors["keys"]?.objectValue)
    let positives = Self.list("assertion_vectors").filter { $0["expect"]?["ok"]?.boolValue == true }
    #expect(positives.count >= 8)

    for vector in positives {
      let name = vector["name"]?.stringValue ?? ""
      let request = try #require(vector["request"])
      let passkey = try #require(vector["answer"]?["passkey"])
      let context = try #require(contexts[vector["context"]?.stringValue ?? ""])
      let display = ConfirmDisplay(
        title: try #require(request["title"]?.stringValue),
        summary: try #require(request["summary"]?.stringValue),
        detail: request["detail"]?.stringValue,
        baseURL: try #require(passkey["base_url"]?.stringValue)
      )
      let binding = PasskeyChallengeBinding(
        purpose: .confirm,
        gatewayID: try Self.bytes(context["gateway_id"]),
        userID: try #require(request["user_id"]?.stringValue),
        sessionID: try #require(request["session_id"]?.stringValue),
        requestID: try #require(request["request_id"]?.stringValue),
        nonce: try Self.bytes(request["nonce"])
      )
      let clientData = try Self.bytes(passkey["client_data_json"])
      let clientJSON = try JSONValue(parsing: Data(clientData))

      #expect(
        clientJSON["challenge"]?.stringValue == Base64URL.encode(PasskeyChallenge.challenge(display, binding)),
        "\(name)"
      )

      let key = try #require(keys[vector["signed_by"]?.stringValue ?? ""])
      let raw = try Self.bytes(key["x"]) + Self.bytes(key["y"])
      let publicKey = try P256.Signing.PublicKey(rawRepresentation: raw)
      let signature = try P256.Signing.ECDSASignature(derRepresentation: Self.bytes(passkey["signature"]))
      let message = try Self.bytes(passkey["authenticator_data"]) + Array(SHA256.hash(data: clientData))

      // CryptoKit accepts only low-S; the contract keeps high-S valid, so normalise for the check.
      #expect(publicKey.isValidSignature(Self.lowS(signature), for: message), "\(name)")
    }
  }

  /// The low-S twin of an ECDSA signature (`s` → `n - s` when `s > n/2`).
  static func lowS(_ signature: P256.Signing.ECDSASignature) -> P256.Signing.ECDSASignature {
    let raw = Array(signature.rawRepresentation)
    let order: [UInt8] = [
      0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84, 0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51
    ]
    let half: [UInt8] = [
      0x7F, 0xFF, 0xFF, 0xFF, 0x80, 0x00, 0x00, 0x00, 0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      0xDE, 0x73, 0x7D, 0x56, 0xD3, 0x8B, 0xCF, 0x42, 0x79, 0xDC, 0xE5, 0x61, 0x7E, 0x31, 0x92, 0xA8
    ]
    let s = Array(raw[32...])

    guard s.lexicographicallyPrecedes(half) == false, s != half else {
      return signature
    }

    var difference = [UInt8](repeating: 0, count: 32)
    var borrow = 0

    for index in stride(from: 31, through: 0, by: -1) {
      var value = Int(order[index]) - Int(s[index]) - borrow
      borrow = value < 0 ? 1 : 0
      value += borrow * 256
      difference[index] = UInt8(value)
    }

    return (try? P256.Signing.ECDSASignature(rawRepresentation: Array(raw[..<32]) + difference)) ?? signature
  }
}
