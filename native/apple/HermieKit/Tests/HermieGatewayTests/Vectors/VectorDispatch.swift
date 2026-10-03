import Foundation
import HermieGateway
import HermieProtocol

/// What running one vector through the port produced.
enum VectorOutcome {
  /// A value; Swift's `nil` (TypeScript's `undefined`) is `.null`, as the contract compares it.
  case value(VectorValue)
  case threw(GatewayError)
  /// The port has no function for this vector, or the vector could not be decoded.
  case unsupported(String)
}

/// A plain `Error`, for the probe-hints vectors that hand the function something
/// that is not a `GatewayError`.
private struct PlainError: Error {
  var message: String
}

/// Routes each vector to the Swift function it stands for.
enum VectorDispatch {
  static func run(_ vector: Vector) -> VectorOutcome {
    do throws(GatewayError) {
      if let value = try value(for: vector) {
        return .value(value)
      }

      return .unsupported("no Swift function for \(vector.file).\(vector.fn)")
    } catch {
      return .threw(error)
    }
  }

  private static func hexBytes(_ value: VectorValue) -> [UInt8] {
    let scalars = Array((value.string ?? "").utf8)
    return stride(from: 0, to: scalars.count - 1, by: 2).map { index in
      UInt8(String(decoding: scalars[index...(index + 1)], as: UTF8.self), radix: 16)!
    }
  }

  private static func frontDoor(_ value: VectorValue) -> FrontDoor {
    guard value["kind"]?.string == "cloudflare_access" else {
      return .none
    }

    return .cloudflareAccess(
      .init(
        clientID: value["clientId"]?.string ?? "",
        clientSecret: value["clientSecret"]?.string ?? "",
        origin: value["origin"]?.string ?? ""
      )
    )
  }

  private static func desktopInfo(_ value: VectorValue) -> DesktopContract.Info? {
    guard let object = value.object else {
      return nil
    }

    let contract: DesktopContract.Value? =
      switch object["desktop_contract"] {
      case nil: nil
      case .number(let number)?: .number(number)
      case .string(let text)?: .string(text)
      default: .other
      }

    return DesktopContract.Info(desktopContract: contract, lazy: object["lazy"] == .bool(true))
  }

  private static func probeError(_ value: VectorValue) -> (any Error)? {
    guard let object = value.object, let errorClass = object["class"]?.string else {
      // A bare JSON value passed through unchanged: `null` is no error, anything else is not a GatewayError.
      return value == .null ? nil : PlainError(message: value.description)
    }

    guard errorClass == "GatewayError", let kind = object["kind"]?.string.flatMap(GatewayErrorKind.init(rawValue:))
    else {
      return PlainError(message: object["message"]?.string ?? "")
    }

    return GatewayError(
      kind,
      object["message"]?.string ?? "",
      status: object["status"]?.number.map { Int($0) },
      closeCode: object["closeCode"]?.number.map { Int($0) },
      redirectedTo: object["redirectedTo"]?.string,
      redirectedOrigin: object["redirectedOrigin"]?.string,
      hint: object["hint"]?.string,
      sawLandingPage: object["sawLandingPage"]?.bool
    )
  }

  private static func vectorValue(_ value: JSONValue) -> VectorValue {
    switch value {
    case .null: .null
    case .bool(let flag): .bool(flag)
    case .number(let number): .number(number)
    case .string(let text): .string(text)
    case .array(let values): .array(values.map(vectorValue))
    case .object(let object): .object(object.mapValues(vectorValue))
    }
  }

  private static func jsonValue(_ value: VectorValue) -> JSONValue {
    switch value {
    case .null: .null
    case .bool(let flag): .bool(flag)
    case .number(let number): .number(number)
    case .string(let text): .string(text)
    case .array(let values): .array(values.map(jsonValue))
    case .object(let object): .object(object.mapValues(jsonValue))
    }
  }

  private static func viaValue(_ via: AuthorStamp.Via?) -> VectorValue {
    guard let via else { return .null }
    return .object(["kind": .string(via.kind), "client": .string(via.client)])
  }

  private static func verdictValue(_ verdict: ProbeVerdict) -> VectorValue {
    .object([
      "hint": .string(verdict.hint.rawValue),
      "landingPage": .bool(verdict.landingPage),
      "actions": .array(
        verdict.actions.map { action in
          switch action {
          case .useHost(let host, let origin):
            .object(
              ["kind": .string("use_host"), "host": .string(host)].merging(
                origin.map { ["origin": VectorValue.string($0)] } ?? [:],
                uniquingKeysWith: { first, _ in first }
              )
            )
          case .frontDoor: .object(["kind": .string("front_door")])
          }
        }
      )
    ])
  }

  private static func value(for vector: Vector) throws(GatewayError) -> VectorValue? {
    let arg = vector.arg
    let random = vector.random

    switch (vector.file, vector.fn) {
    // url.json
    case ("url", "hasExplicitScheme"):
      return VectorValue(GatewayAddress.hasExplicitScheme(arg(0).string!))
    case ("url", "normalizeBaseUrl"):
      return VectorValue(try GatewayAddress.normalizeBaseURL(arg(0).string!))
    case ("url", "wsUrlFor"):
      return VectorValue(try GatewayAddress.webSocketURL(for: arg(0).string!))
    case ("url", "apiUrl"):
      return VectorValue(try GatewayAddress.apiURL(arg(0).string!, path: arg(1).string!))
    case ("url", "authPicturePath"):
      return VectorValue(GatewayAddress.authPicturePath(id: arg(0).string!))
    case ("url", "isBlockedHeaderName"):
      return VectorValue(GatewayAddress.isBlockedHeaderName(arg(0).string!))
    case ("url", "normalizeHeader"):
      let header = try GatewayAddress.normalizeHeader(name: arg(0).string!, value: arg(1).string!)
      return .array([.string(header.name), .string(header.value)])
    case ("url", "normalizeHeaders"):
      return VectorValue(try GatewayAddress.normalizeHeaders(arg(0).stringMap))
    case ("url", "BLOCKED_HEADER_NAMES"):
      return .array(GatewayAddress.blockedHeaderNames.sorted().map(VectorValue.string))
    case ("url", "GATEWAY_WS_PATH"):
      return VectorValue(GatewayAddress.webSocketPath)
    case ("url", "AUTH_PICTURE_PATH"):
      return VectorValue(GatewayAddress.authPicturePathPrefix)

    // host-privacy.json
    case ("host-privacy", "hostOfAddress"):
      return VectorValue(HostClassification.host(ofAddress: arg(0).string!))
    case ("host-privacy", "classifyHost"):
      let classification = HostClassification.of(arg(0).string!)
      return .object([
        "host": .string(classification.host),
        "privacy": .string(classification.privacy.rawValue),
        "isPrivate": .bool(classification.isPrivate)
      ])
    case ("host-privacy", "isExposedCleartext"):
      return VectorValue(HostClassification.isExposedCleartext(arg(0).string!))

    // gateway-key.json
    case ("gateway-key", "gatewayKeyOf"):
      return VectorValue(GatewayKey.of(arg(0).string!))
    case ("gateway-key", "isGatewayKey"):
      // The reference takes `unknown`; a non-string is the type system's job here.
      return VectorValue(GatewayKey.isValid(arg(0).string))

    // front-door.json
    case ("front-door", "originOf"):
      return VectorValue(GatewayAddress.origin(of: arg(0).string!))
    case ("front-door", "isFrontDoorComplete"):
      return VectorValue(frontDoor(arg(0)).isComplete)
    case ("front-door", "frontDoorHeaders"):
      return VectorValue(frontDoor(arg(0)).headers(for: arg(1).string!))
    case ("front-door", "frontDoorWithheld"):
      return VectorValue(frontDoor(arg(0)).isWithheld(for: arg(1).string!))
    case ("front-door", "describeFrontDoor"):
      return VectorValue(FrontDoor.describe(arg(0).stringMap!))
    case ("front-door", "redactHeaders"):
      return VectorValue(FrontDoor.redact(arg(0).stringMap!))
    case ("front-door", "accessUserScript"):
      return VectorValue(frontDoor(arg(0)).accessUserScript(for: arg(1).string!))
    case ("front-door", "CF_ACCESS_CLIENT_ID"):
      return VectorValue(FrontDoor.clientIDHeader)
    case ("front-door", "CF_ACCESS_CLIENT_SECRET"):
      return VectorValue(FrontDoor.clientSecretHeader)
    case ("front-door", "CF_ACCESS_PRESENT"):
      return VectorValue(FrontDoor.presentDescription)
    case ("front-door", "CF_ACCESS_INCOMPLETE"):
      return VectorValue(FrontDoor.incompleteDescription)
    case ("front-door", "REDACTED"):
      return VectorValue(FrontDoor.redacted)
    case ("front-door", "NO_FRONT_DOOR"):
      return .object(["kind": .string("none")])

    // backoff.json
    case ("backoff", "READY_TIMEOUT_MS"):
      return VectorValue(GatewayTimeouts.readyMs)
    case ("backoff", "DEFAULT_RPC_TIMEOUT_MS"):
      return VectorValue(GatewayTimeouts.defaultRPCMs)
    case ("backoff", "PROMPT_SUBMIT_TIMEOUT_MS"):
      return VectorValue(GatewayTimeouts.promptSubmitMs)
    case ("backoff", "FIRST_SESSION_TIMEOUT_MS"):
      return VectorValue(GatewayTimeouts.firstSessionMs)
    case ("backoff", "RECONNECT_CAP_MS"):
      return VectorValue(ReconnectBackoff.capMs)
    case ("backoff", "PROTOCOL_LADDER_FLOOR"):
      return VectorValue(ReconnectBackoff.protocolLadderFloor)
    case ("backoff", "OFFLINE_GRACE_MS"):
      return VectorValue(GatewayTimeouts.offlineGraceMs)
    case ("backoff", "DIAL_FAILURE_RECENT_MS"):
      return VectorValue(GatewayTimeouts.dialFailureRecentMs)
    case ("backoff", "MIN_DESKTOP_CONTRACT"):
      return VectorValue(DesktopContract.minimum)
    case ("backoff", "rpcTimeoutMs"):
      return VectorValue(GatewayTimeouts.rpcTimeoutMs(method: arg(0).string!, firstSessionCallDone: arg(1).bool!))
    case ("backoff", "defaultBackoffDelayMs"):
      guard let random else { return nil }
      return VectorValue(ReconnectBackoff.defaultDelayMs(attempt: arg(0).number!) { random })
    case ("backoff", "reconnectBackoffDelayMs"):
      let options = arg(1)
      let jitter = options["jitter"] != .bool(false)

      if jitter, random == nil {
        return nil
      }

      return VectorValue(
        ReconnectBackoff.delayMs(
          attempt: arg(0).number!,
          baseDelayMs: options["baseDelayMs"]?.number ?? ReconnectBackoff.baseDelayMs,
          capMs: options["capMs"]?.number ?? ReconnectBackoff.capMs,
          jitter: jitter
        ) { random ?? .nan }
      )
    case ("backoff", "assertDesktopContract"):
      return VectorValue(try DesktopContract.check(desktopInfo(arg(0)), known: arg(1).number))

    // pkce.json
    case ("pkce", "base64url"):
      return VectorValue(Base64.encodeURL(hexBytes(arg(0))))
    case ("pkce", "createPkce"):
      var queue = [hexBytes(arg(0)["verifierBytesHex"]!), hexBytes(arg(0)["stateBytesHex"]!)]
      var asked: [Int] = []
      let pkce = PKCE.create { length in
        asked.append(length)
        return queue.isEmpty ? [] : queue.removeFirst()
      }

      guard asked == [32, 24] else { return nil }
      return .object([
        "verifier": .string(pkce.verifier), "challenge": .string(pkce.challenge), "state": .string(pkce.state)
      ])
    case ("pkce", "REDIRECT_URI"):
      return VectorValue(PKCE.redirectURI)
    case ("pkce", "buildAuthorizeUrl"):
      let params = arg(1)
      return VectorValue(
        try PKCE.authorizeURL(
          baseURL: arg(0).string!,
          params: AuthorizeParams(
            provider: params["provider"]?.string,
            challenge: params["challenge"]!.string!,
            state: params["state"]!.string!,
            redirectURI: params["redirectUri"]?.string
          )
        )
      )
    case ("pkce", "isLoopbackRedirect"):
      return VectorValue(PKCE.isLoopbackRedirect(arg(0).string!))
    case ("pkce", "isLoopbackUrl"):
      return VectorValue(PKCE.isLoopbackURL(arg(0).string!))
    case ("pkce", "parseLoopbackRedirect"):
      switch try PKCE.parseLoopbackRedirect(arg(0).string!) {
      case .code(let code, let state):
        return .object(["code": .string(code), "state": .string(state)])
      case .error(let error, let description):
        return .object(["error": .string(error), "description": .string(description)])
      }

    // probe-hints.json
    case ("probe-hints", "classifyProbeFailure"):
      let options = arg(1)
      let network = options["network"]?.string.flatMap(NetworkKind.init(rawValue:)) ?? .unknown
      return verdictValue(
        ProbeVerdict.classify(probeError(arg(0)), address: options["address"]!.string!, network: network)
      )

    // author-id.json
    case ("author-id", "authorIdOf"):
      return VectorValue(OwnAuthor.authorID(provider: arg(0)["provider"]?.string, userID: arg(0)["userId"]?.string))
    case ("author-id", "ownAuthorOf"):
      let identity = arg(0)
      guard
        let author = OwnAuthor.of(
          provider: identity["provider"]?.string,
          userID: identity["userId"]?.string,
          displayName: identity["displayName"]?.string
        )
      else {
        return .null
      }

      var object: [String: VectorValue] = ["id": .string(author.id)]
      object["name"] = author.name.map(VectorValue.string)
      return .object(object)

    case ("author-id", "authorViaOf"):
      return viaValue(AuthorStamp.via(of: jsonValue(arg(0))))
    case ("author-id", "authorStampOf"):
      guard let stamp = AuthorStamp.of(jsonValue(arg(0))) else { return .null }
      var object: [String: VectorValue] = ["id": .string(stamp.id)]
      object["name"] = stamp.name.map(VectorValue.string)
      object["via"] = stamp.via.map { viaValue($0) }
      return .object(object)

    // base64.json
    case ("base64", "bytesToBase64"):
      return VectorValue(Base64.encode(hexBytes(arg(0))))

    // fetch-json.json
    case ("fetch-json", "DEFAULT_HTTP_TIMEOUT_MS"):
      return VectorValue(FetchJSON.defaultTimeoutMs)
    case ("fetch-json", "looksLikeTlsFailure"):
      return VectorValue(FetchJSON.looksLikeTLSFailure(arg(0).string!))
    case ("fetch-json", "looksLikeCertificateFailure"):
      return VectorValue(FetchJSON.looksLikeCertificateFailure(arg(0).string!))
    case ("fetch-json", "parseJsonBody"):
      guard let kind = arg(2).string.flatMap(GatewayErrorKind.init(rawValue:)) else { return nil }
      return vectorValue(try FetchJSON.parseJSONBody(arg(0).string!, url: arg(1).string!, kind: kind))
    case ("fetch-json", "REFUSED_LOCATION_HEADER"):
      return VectorValue(FetchJSON.refusedLocationHeader)
    case ("fetch-json", "redirectSeen"):
      let response = arg(0)
      let shape = FetchJSON.ResponseShape(
        status: Int(response["status"]?.number ?? 0),
        type: response["type"]?.string,
        url: response["url"]?.string,
        headers: response["headers"]?.stringMap
      )
      return FetchJSON.redirectSeen(shape, requestedURL: arg(1).string!).map { .object(["target": .string($0)]) } ?? .null
    case ("fetch-json", "redirectError"):
      let error = FetchJSON.redirectError(
        requestedURL: arg(0).string!,
        target: arg(1).string!,
        status: arg(2).number.map { Int($0) }
      )
      var fields: [String: VectorValue] = ["kind": .string(error.kind.rawValue), "message": .string(error.message)]
      fields["status"] = error.status.map { .number(Double($0)) }
      fields["redirectedTo"] = error.redirectedTo.map(VectorValue.string)
      fields["redirectedOrigin"] = error.redirectedOrigin.map(VectorValue.string)
      return .object(fields)
    case ("fetch-json", "parseJsonObject"):
      guard let kind = arg(2).string.flatMap(GatewayErrorKind.init(rawValue:)) else { return nil }
      return vectorValue(.object(try FetchJSON.parseJSONObject(arg(0).string!, url: arg(1).string!, kind: kind)))

    default:
      return nil
    }
  }
}
