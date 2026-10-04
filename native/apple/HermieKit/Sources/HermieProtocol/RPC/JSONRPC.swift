import Foundation

/// A JSON-RPC request id. The client mints `r1`, `r2`, … (`RequestIDSequence`); the type
/// accepts a number too, as `GatewayRequestId = number | string` does.
public enum JSONRPCID: Sendable, Hashable, JSONConvertible, Codable, CustomStringConvertible {
  case string(String)
  case number(Double)

  public init?(jsonValue: JSONValue) {
    switch jsonValue {
    case .string(let value): self = .string(value)
    case .number(let value): self = .number(value)
    default: return nil
    }
  }

  public var jsonValue: JSONValue {
    switch self {
    case .string(let value): .string(value)
    case .number(let value): .number(value)
    }
  }

  public init(from decoder: any Decoder) throws {
    let value = try JSONValue(from: decoder)
    guard let id = JSONRPCID(jsonValue: value) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a request id"))
    }
    self = id
  }

  public func encode(to encoder: any Encoder) throws {
    try jsonValue.encode(to: encoder)
  }

  public var description: String {
    switch self {
    case .string(let value): value
    case .number(let value): ECMAScriptNumber.string(value)
    }
  }
}

/// The client's request ids, `r1`, `r2`, … per connection, as `JsonRpcRequestChannel` mints
/// them (`${requestIdPrefix ?? 'r'}${++nextId}`).
public struct RequestIDSequence: Sendable, Hashable {
  public var prefix: String
  public private(set) var last: Int

  public init(prefix: String = "r", last: Int = 0) {
    self.prefix = prefix
    self.last = last
  }

  public mutating func next() -> JSONRPCID {
    last += 1
    return .string("\(prefix)\(last)")
  }
}

/// The protocol version member every frame carries.
public let jsonRPCVersion = "2.0"

/// A JSON-RPC `error` member: `{code?, message?, data?}`.
public struct JSONRPCError: JSONObjectBacked, Error {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(code: Int, message: String, data: JSONValue? = nil) {
    self.init()
    self.code = code
    self.message = message
    self.data = data
  }

  public var code: Int? { get { json[field: "code"] } set { json[field: "code"] = newValue } }
  public var message: String? { get { json[field: "message"] } set { json[field: "message"] = newValue } }
  public var data: JSONValue? { get { json["data"] } set { json["data"] = newValue } }

  /// `-32601`: what the client answers a server request nobody handles.
  public static let methodNotFound = -32601
  /// `-32603`: what the client answers when its server-request handler crashed.
  public static let internalError = -32603
}

/// A client→server call: `{jsonrpc, id, method, params}`.
public struct JSONRPCRequest: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The reference always sends `params`, `{}` when the call has none.
  public init(id: JSONRPCID, method: String, params: JSONValue = .object([:])) {
    self.init(json: ["jsonrpc": .string(jsonRPCVersion), "id": id.jsonValue, "method": .string(method), "params": params])
  }

  public init<M: RPCMethod>(id: JSONRPCID, _ method: M.Type, params: M.Params) {
    self.init(id: id, method: M.name, params: params.jsonValue)
  }

  public var id: JSONRPCID? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var method: String? { get { json[field: "method"] } set { json[field: "method"] = newValue } }
  public var params: JSONValue? { get { json["params"] } set { json["params"] = newValue } }
}

/// An answer to a call, in either direction: `{jsonrpc, id, result}` or `{jsonrpc, id, error}`.
public struct JSONRPCResponse: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(id: JSONRPCID, result: JSONValue) {
    self.init(json: ["jsonrpc": .string(jsonRPCVersion), "id": id.jsonValue, "result": result])
  }

  public init(id: JSONRPCID, error: JSONRPCError) {
    self.init(json: ["jsonrpc": .string(jsonRPCVersion), "id": id.jsonValue, "error": error.jsonValue])
  }

  public var id: JSONRPCID? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var result: JSONValue? { get { json["result"] } set { json["result"] = newValue } }
  public var error: JSONRPCError? { get { json[field: "error"] } set { json[field: "error"] = newValue } }

  /// The error when an `error` member is present (any shape counts, as `if (frame.error)`
  /// does for an object), else the result (`null` when absent).
  public var outcome: Result<JSONValue, JSONRPCError> {
    if let raw = json["error"], raw.isTruthy {
      return .failure(JSONRPCError(jsonValue: raw) ?? JSONRPCError())
    }
    return .success(json["result"] ?? .null)
  }

  /// The result viewed as `M.Result`, or `nil` for an error or a result of another shape.
  public func result<M: RPCMethod>(of method: M.Type) -> M.Result? {
    guard case .success(let value) = outcome else { return nil }
    return M.Result(jsonValue: value)
  }
}

/// A server→client request (`approval`, `clarify`, …): `{jsonrpc, id, method, params}`.
///
/// The same view reads an `open_requests` entry (`{id, method, params}`) that a resume or
/// an event replay hands back, so a request re-delivered after a reconnect is one type.
public struct ServerRequest: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(id: String, method: String, params: JSONObject) {
    self.init(json: ["jsonrpc": .string(jsonRPCVersion), "id": .string(id), "method": .string(method), "params": .object(params)])
  }

  public init(id: String, _ body: ServerRequestBody) {
    self.init(id: id, method: body.method, params: body.params)
  }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var method: String? { get { json[field: "method"] } set { json[field: "method"] = newValue } }
  /// `params` as an object; anything else reads as `{}`, as the reference treats it.
  public var params: JSONObject {
    get { json[field: "params"] ?? [:] }
    set { json[field: "params"] = newValue }
  }

  /// The session blocked on the answer.
  public var sessionID: String? { params[field: "session_id"] }

  public var body: ServerRequestBody { ServerRequestBody(method: method ?? "", params: params) }

  /// The success answer to send back.
  public func respond(_ result: JSONValue) -> JSONRPCResponse? {
    id.map { JSONRPCResponse(id: .string($0), result: result) }
  }

  /// The error answer to send back (the backend treats it as unanswered). `data` rides along
  /// when given (`confirm`'s 4040 carries `{reason}`).
  public func fail(code: Int, message: String, data: JSONValue? = nil) -> JSONRPCResponse? {
    id.map { JSONRPCResponse(id: .string($0), error: JSONRPCError(code: code, message: message, data: data)) }
  }
}

/// The typed reading of a server request. The client answers `approval`, `clarify`, the
/// one-string prompts (`secret`, `sudo`, `vault.*`) and, where a passkey model listens, `confirm`;
/// the interactive requests (`input.form`, `input.file`, `review.draft`, `review.diff`) are typed here and are
/// answered only by a connection that advertised them;
/// everything else is `unknown`, answered `-32601` by the connection.
public enum ServerRequestBody: Sendable, Hashable {
  case approval(ApprovalRequestParams)
  case clarify(ClarifyRequestParams)
  case secret(SecretRequestParams)
  case sudo(SudoRequestParams)
  case vaultUnlock(VaultUnlockRequestParams)
  case vaultCode(VaultCodeRequestParams)
  case vaultSaveLogin(VaultSaveLoginRequestParams)
  case confirm(ConfirmRequestParams)
  case inputForm(InputFormParams)
  case inputFile(InputFileParams)
  case reviewDraft(ReviewDraftParams)
  case reviewDiff(ReviewDiffParams)
  case deviceLocation(DeviceLocationParams)
  case deviceContact(DeviceContactParams)
  case deviceCalendar(DeviceCalendarParams)
  case unknown(method: String, params: JSONObject)

  public enum Method {
    public static let approval = "approval"
    public static let clarify = "clarify"
    public static let secret = "secret"
    public static let sudo = "sudo"
    public static let vaultUnlock = "vault.unlock_prompt"
    public static let vaultCode = "vault.code"
    public static let vaultSaveLogin = "vault.save_login"
    public static let confirm = "confirm"
    public static let inputForm = "input.form"
    public static let inputFile = "input.file"
    public static let reviewDraft = "review.draft"
    public static let reviewDiff = "review.diff"
    public static let deviceLocation = "device.location"
    public static let deviceContact = "device.contact"
    public static let deviceCalendar = "device.calendar"
    /// The interactive requests (`contract/requests/`), in the order a connection advertises them in
    /// `client.capabilities`' `requests`.
    public static let interactive = [
      inputForm, inputFile, reviewDraft, reviewDiff,
      deviceLocation, deviceContact, deviceCalendar
    ]
    /// Every server request the backend declares (`SERVER_REQUEST_METHODS`).
    public static let all = [
      "approval", "clarify", "confirm", "device.calendar", "device.contact", "device.location", "input.file",
      "input.form", "preview.act", "preview.read", "review.diff", "review.draft", "secret", "sudo", "terminal.read",
      "tour", "vault.code", "vault.save_login", "vault.unlock_prompt", "window.read"
    ]
    /// The one-string prompts, answered with `ValueResult` (`''` skips).
    public static let secureInput: Set<String> = [secret, sudo, vaultUnlock, vaultCode, vaultSaveLogin]
  }

  public init(method: String, params: JSONObject) {
    switch method {
    case Method.approval: self = .approval(ApprovalRequestParams(json: params))
    case Method.clarify: self = .clarify(ClarifyRequestParams(json: params))
    case Method.secret: self = .secret(SecretRequestParams(json: params))
    case Method.sudo: self = .sudo(SudoRequestParams(json: params))
    case Method.vaultUnlock: self = .vaultUnlock(VaultUnlockRequestParams(json: params))
    case Method.vaultCode: self = .vaultCode(VaultCodeRequestParams(json: params))
    case Method.vaultSaveLogin: self = .vaultSaveLogin(VaultSaveLoginRequestParams(json: params))
    case Method.confirm: self = .confirm(ConfirmRequestParams(json: params))
    case Method.inputForm: self = .inputForm(InputFormParams(json: params))
    case Method.inputFile: self = .inputFile(InputFileParams(json: params))
    case Method.reviewDraft: self = .reviewDraft(ReviewDraftParams(json: params))
    case Method.reviewDiff: self = .reviewDiff(ReviewDiffParams(json: params))
    case Method.deviceLocation: self = .deviceLocation(DeviceLocationParams(json: params))
    case Method.deviceContact: self = .deviceContact(DeviceContactParams(json: params))
    case Method.deviceCalendar: self = .deviceCalendar(DeviceCalendarParams(json: params))
    default: self = .unknown(method: method, params: params)
    }
  }

  public var method: String {
    switch self {
    case .approval: Method.approval
    case .clarify: Method.clarify
    case .secret: Method.secret
    case .sudo: Method.sudo
    case .vaultUnlock: Method.vaultUnlock
    case .vaultCode: Method.vaultCode
    case .vaultSaveLogin: Method.vaultSaveLogin
    case .confirm: Method.confirm
    case .inputForm: Method.inputForm
    case .inputFile: Method.inputFile
    case .reviewDraft: Method.reviewDraft
    case .reviewDiff: Method.reviewDiff
    case .deviceLocation: Method.deviceLocation
    case .deviceContact: Method.deviceContact
    case .deviceCalendar: Method.deviceCalendar
    case .unknown(let method, _): method
    }
  }

  public var params: JSONObject {
    switch self {
    case .approval(let params): params.json
    case .clarify(let params): params.json
    case .secret(let params): params.json
    case .sudo(let params): params.json
    case .vaultUnlock(let params): params.json
    case .vaultCode(let params): params.json
    case .vaultSaveLogin(let params): params.json
    case .confirm(let params): params.json
    case .inputForm(let params): params.json
    case .inputFile(let params): params.json
    case .reviewDraft(let params): params.json
    case .reviewDiff(let params): params.json
    case .deviceLocation(let params): params.json
    case .deviceContact(let params): params.json
    case .deviceCalendar(let params): params.json
    case .unknown(_, let params): params
    }
  }

  /// One of the one-string prompts the secure input sheet answers.
  public var isSecureInput: Bool {
    switch self {
    case .secret, .sudo, .vaultUnlock, .vaultCode, .vaultSaveLogin: true
    case .approval, .clarify, .confirm, .inputForm, .inputFile, .reviewDraft, .reviewDiff, .unknown: false
    case .deviceLocation, .deviceContact, .deviceCalendar: false
    }
  }

  /// One of the interactive requests of `contract/requests/`.
  public var isInteractive: Bool {
    switch self {
    case .inputForm, .inputFile, .reviewDraft, .reviewDiff: true
    case .deviceLocation, .deviceContact, .deviceCalendar: true
    case .approval, .clarify, .secret, .sudo, .vaultUnlock, .vaultCode, .vaultSaveLogin, .confirm, .unknown: false
    }
  }
}

/// One inbound text frame, classified exactly as `JsonRpcRequestChannel.handleFrame` does:
///
/// 1. a string `id` and a string `method` other than `event` is a server request;
/// 2. otherwise a non-null `id` is a response;
/// 3. otherwise `method: "event"` with a string `params.type` is an event notification;
/// 4. anything else is `other`, kept whole.
public enum InboundFrame: Sendable, Hashable, JSONConvertible {
  case serverRequest(ServerRequest)
  case response(JSONRPCResponse)
  case event(EventNotification)
  case other(JSONObject)

  /// `nil` for a value that is not an object, which the reference ignores.
  public init?(jsonValue: JSONValue) {
    guard case .object(let object) = jsonValue else { return nil }
    let id = object["id"]
    let method = object["method"]?.stringValue
    if case .string = id, let method, method != EventNotification.method {
      self = .serverRequest(ServerRequest(json: object))
    } else if let id, !id.isNull {
      self = .response(JSONRPCResponse(json: object))
    } else if method == EventNotification.method, object["params"]?["type"]?.stringValue != nil {
      self = .event(EventNotification(json: object))
    } else {
      self = .other(object)
    }
  }

  /// Parses one text frame. Throws when it is not JSON; `nil` when it is not an object.
  public init?(parsing data: Data) throws(JSONParseError) {
    self.init(jsonValue: try JSONValue(parsing: data))
  }

  public var jsonValue: JSONValue {
    switch self {
    case .serverRequest(let request): request.jsonValue
    case .response(let response): response.jsonValue
    case .event(let notification): notification.jsonValue
    case .other(let object): .object(object)
    }
  }
}

/// The `event` notification frame around a gateway event: `{jsonrpc, method: "event", params}`.
public struct EventNotification: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let method = "event"

  public init(_ event: GatewayEvent) {
    self.init(json: ["jsonrpc": .string(jsonRPCVersion), "method": .string(Self.method), "params": event.jsonValue])
  }

  public var event: GatewayEvent {
    get { json[field: "params"] ?? GatewayEvent() }
    set { json[field: "params"] = newValue }
  }
}
