import Foundation

// The interactive server→client requests of `contract/requests/README.md`: `input.form`, `input.file`
// and `review.draft`. The gateway builds and bounds every string; a client renders them as plain
// text, marks them as the agent's words and answers with a result (or with 4041 `cannot_show`).
//
// Like every wire type here these are views over the JSON they were read from (see the header of
// `JSONBacked.swift`): a key the contract adds later survives a read and a re-encode, and a key of
// the wrong type reads as `nil`. A form field whose `kind` this build does not know reads as
// `.unknown` and keeps its whole object, so a later contract addition cannot crash a client; the
// client answers such a form with 4041 `not_supported_on_device` (contract §7).

// MARK: - Envelope (contract §2)

/// `acting_user`: the person the turn acts for. Informative; the gateway decides who may answer.
public struct InteractiveActingUser: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
}

/// The keys every interactive request's params share (`InteractiveRequestParams`), next to the
/// transport's `session_id`.
public protocol InteractiveRequestParams: JSONObjectBacked {
  /// What `optional` means when the key is absent: `input.*` offer Skip unless told otherwise,
  /// `review.*` never do.
  static var optionalByDefault: Bool { get }
}

extension InteractiveRequestParams {
  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  /// The contract version; `1`. A client that does not know the version answers 4041
  /// `unsupported_version`.
  public var v: Int? { get { json[field: "v"] } set { json[field: "v"] = newValue } }
  /// One line, 1–80 characters. Plain text, never markdown.
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  /// The agent's words: what it asks and why, 1–500 characters. Plain text.
  public var summary: String? { get { json[field: "summary"] } set { json[field: "summary"] = newValue } }
  /// Extra context, at most 2,000 characters, shown monospaced.
  public var detail: String? { get { json[field: "detail"] } set { json[field: "detail"] = newValue } }
  /// When the gateway stops waiting, Unix seconds.
  public var expiresAt: Int? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
  /// The key as sent; `offersSkip` is the reading with the method's default applied.
  public var optionalFlag: Bool? { get { json[field: "optional"] } set { json[field: "optional"] = newValue } }
  public var actingUser: InteractiveActingUser? {
    get { json[field: "acting_user"] }
    set { json[field: "acting_user"] = newValue }
  }

  /// Whether Skip is offered.
  public var offersSkip: Bool { optionalFlag ?? Self.optionalByDefault }

  /// `expires_at` as a date.
  public var expiryDate: Date? { expiresAt.map { Date(timeIntervalSince1970: TimeInterval($0)) } }

  /// Whether the request has run out by `now`'s clock. A client MUST NOT present a request as still
  /// answerable once this holds, whatever the gateway has or has not yet cancelled (contract §2).
  public func hasExpired(at now: Date) -> Bool {
    guard let expiryDate else { return false }
    return expiryDate <= now
  }
}

/// The closed enum every `input.*` result starts with.
public enum InputStatus: OpenStringEnum {
  case answered, skipped
  case unknown(String)

  public static let knownCases: [InputStatus] = [.answered, .skipped]

  public var rawValue: String {
    switch self {
    case .answered: "answered"
    case .skipped: "skipped"
    case .unknown(let raw): raw
    }
  }
}

// MARK: - 4041 cannot_show (contract §3)

extension JSONRPCError {
  /// `4041`: the client cannot show the request. The answer is an ERROR, never a made-up `skipped`
  /// or `rejected`; the gateway tells the agent the request was `unavailable`.
  public static let cannotShowCode = 4041
  /// The `message` of a 4041 error.
  public static let cannotShowMessage = "cannot_show"

  /// `{code: 4041, message: "cannot_show", data: {reason}}`.
  public static func cannotShow(reason: String) -> JSONRPCError {
    JSONRPCError(code: cannotShowCode, message: cannotShowMessage, data: .object(["reason": .string(reason)]))
  }

  /// Whether this is a 4041.
  public var isCannotShow: Bool { code == Self.cannotShowCode }

  /// `data.reason`, when there is one.
  public var reason: String? { data?["reason"]?.stringValue }
}

/// The `data.reason` strings of 4041 in use. The set is open: a client may send another short
/// machine string.
public enum CannotShowReason {
  public static let noCamera = "no_camera"
  public static let notSupportedOnDevice = "not_supported_on_device"
  public static let permissionDenied = "permission_denied"
  public static let uploadFailed = "upload_failed"
  public static let unsupportedVersion = "unsupported_version"
  public static let shuttingDown = "shutting_down"
}

extension ServerRequest {
  /// The 4041 answer to this request, `nil` for a frame without an id.
  public func cannotShow(reason: String) -> JSONRPCResponse? {
    id.map { JSONRPCResponse(id: .string($0), error: .cannotShow(reason: reason)) }
  }
}

// MARK: - Capabilities (contract §1)

extension ClientCapabilitiesParams {
  /// The interactive methods this connection can SHOW on this device (second call only, at most 32;
  /// an older gateway refuses the unknown key with 4000).
  public var requests: [String]? { get { json[field: "requests"] } set { json[field: "requests"] = newValue } }
}

extension ClientCapabilitiesResult {
  /// The interactive methods the gateway accepted from this connection (`[]` when none).
  public var requests: [String]? { get { json[field: "requests"] } set { json[field: "requests"] = newValue } }
}

// MARK: - input.form (contract §4)

/// The kind of a form field. Open: a kind this build does not know reads as `.unknown`.
public enum FormFieldKind: OpenStringEnum {
  case text, number, amount, date, time, datetime, daterange, choice, toggle
  case unknown(String)

  public static let knownCases: [FormFieldKind] = [
    .text, .number, .amount, .date, .time, .datetime, .daterange, .choice, .toggle
  ]

  public var rawValue: String {
    switch self {
    case .text: "text"
    case .number: "number"
    case .amount: "amount"
    case .date: "date"
    case .time: "time"
    case .datetime: "datetime"
    case .daterange: "daterange"
    case .choice: "choice"
    case .toggle: "toggle"
    case .unknown(let raw): raw
    }
  }
}

/// The keyboard hint of a text field. A hint, not a check: the gateway validates no address, number
/// or URL.
public enum TextInputKind: OpenStringEnum {
  case plain, email, phone, url
  case unknown(String)

  public static let knownCases: [TextInputKind] = [.plain, .email, .phone, .url]

  public var rawValue: String {
    switch self {
    case .plain: "plain"
    case .email: "email"
    case .phone: "phone"
    case .url: "url"
    case .unknown(let raw): raw
    }
  }
}

/// The keys every form field shares.
public protocol FormFieldView: JSONObjectBacked {}

extension FormFieldView {
  /// `^[a-z][a-z0-9_]{0,31}$`, unique within the form.
  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  /// The discriminator, as sent.
  public var kind: FormFieldKind? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  public var label: String? { get { json[field: "label"] } set { json[field: "label"] = newValue } }
  public var hint: String? { get { json[field: "hint"] } set { json[field: "hint"] = newValue } }
  /// The key as sent; `isRequired` applies the default.
  public var required: Bool? { get { json[field: "required"] } set { json[field: "required"] = newValue } }
  public var isRequired: Bool { required ?? false }
}

/// `text`: `multiline`, `max_length` (≤ 4,000, which is also the limit when absent) and `input`.
public struct TextFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let defaultMaxLength = 4_000

  public var multiline: Bool? { get { json[field: "multiline"] } set { json[field: "multiline"] = newValue } }
  public var maxLength: Int? { get { json[field: "max_length"] } set { json[field: "max_length"] = newValue } }
  public var input: TextInputKind? { get { json[field: "input"] } set { json[field: "input"] = newValue } }
  public var `default`: String? { get { json[field: "default"] } set { json[field: "default"] = newValue } }

  public var isMultiline: Bool { multiline ?? false }
  /// The limit in code points.
  public var effectiveMaxLength: Int { maxLength ?? Self.defaultMaxLength }
}

/// `number`: a JSON number in `[min, max]`, whole when `integer`, on `min` (else 0) plus a whole
/// multiple of `step`.
public struct NumberFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var min: Double? { get { json[field: "min"] } set { json[field: "min"] = newValue } }
  public var max: Double? { get { json[field: "max"] } set { json[field: "max"] = newValue } }
  public var step: Double? { get { json[field: "step"] } set { json[field: "step"] = newValue } }
  public var integer: Bool? { get { json[field: "integer"] } set { json[field: "integer"] = newValue } }
  public var `default`: Double? { get { json[field: "default"] } set { json[field: "default"] = newValue } }

  public var isInteger: Bool { integer ?? false }
}

/// `amount`: a decimal STRING (never a JSON number) in `[min, max]`, with at most as many decimals
/// as `currency`'s ISO 4217 minor unit.
public struct AmountFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// ISO 4217, `^[A-Z]{3}$`.
  public var currency: String? { get { json[field: "currency"] } set { json[field: "currency"] = newValue } }
  /// Decimal strings.
  public var min: String? { get { json[field: "min"] } set { json[field: "min"] = newValue } }
  public var max: String? { get { json[field: "max"] } set { json[field: "max"] = newValue } }
  public var `default`: String? { get { json[field: "default"] } set { json[field: "default"] = newValue } }
}

/// `date`: `YYYY-MM-DD`. `tz` says which day "today" is.
public struct DateFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var min: String? { get { json[field: "min"] } set { json[field: "min"] = newValue } }
  public var max: String? { get { json[field: "max"] } set { json[field: "max"] = newValue } }
  /// An IANA zone name.
  public var tz: String? { get { json[field: "tz"] } set { json[field: "tz"] = newValue } }
  public var `default`: String? { get { json[field: "default"] } set { json[field: "default"] = newValue } }
}

/// `time`: `HH:MM`, 24-hour.
public struct TimeFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var min: String? { get { json[field: "min"] } set { json[field: "min"] = newValue } }
  public var max: String? { get { json[field: "max"] } set { json[field: "max"] = newValue } }
  public var tz: String? { get { json[field: "tz"] } set { json[field: "tz"] = newValue } }
  public var `default`: String? { get { json[field: "default"] } set { json[field: "default"] = newValue } }
}

/// `datetime`: `min`, `max` and `default` are instants (`YYYY-MM-DDTHH:MM[:SS]±HH:MM`, never `Z`);
/// the ANSWER is an instant plus its IANA zone in brackets (`FormDateTime`).
public struct DateTimeFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var min: String? { get { json[field: "min"] } set { json[field: "min"] = newValue } }
  public var max: String? { get { json[field: "max"] } set { json[field: "max"] = newValue } }
  /// The zone the answer is in; the device's zone when absent.
  public var tz: String? { get { json[field: "tz"] } set { json[field: "tz"] = newValue } }
  public var `default`: String? { get { json[field: "default"] } set { json[field: "default"] = newValue } }
}

/// `{start, end}`, both `YYYY-MM-DD` and inclusive.
public struct FormDateRange: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(start: String, end: String) {
    self.init()
    self.start = start
    self.end = end
  }

  public var start: String? { get { json[field: "start"] } set { json[field: "start"] = newValue } }
  public var end: String? { get { json[field: "end"] } set { json[field: "end"] = newValue } }
}

/// `daterange`.
public struct DateRangeFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var min: String? { get { json[field: "min"] } set { json[field: "min"] = newValue } }
  public var max: String? { get { json[field: "max"] } set { json[field: "max"] = newValue } }
  public var tz: String? { get { json[field: "tz"] } set { json[field: "tz"] = newValue } }
  public var `default`: FormDateRange? { get { json[field: "default"] } set { json[field: "default"] = newValue } }
}

/// One option of a choice field: the `value` is what the answer carries, the `label` is what shows.
public struct FormChoiceOption: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(value: String, label: String) {
    self.init()
    self.value = value
    self.label = label
  }

  /// At most 64 characters.
  public var value: String? { get { json[field: "value"] } set { json[field: "value"] = newValue } }
  /// At most 80 characters.
  public var label: String? { get { json[field: "label"] } set { json[field: "label"] = newValue } }
}

/// `choice`: 1–12 options; one option `value`, or with `multiple` a list of distinct ones.
public struct ChoiceFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var options: [FormChoiceOption]? { get { json[field: "options"] } set { json[field: "options"] = newValue } }
  public var multiple: Bool? { get { json[field: "multiple"] } set { json[field: "multiple"] = newValue } }
  public var minSelected: Int? { get { json[field: "min_selected"] } set { json[field: "min_selected"] = newValue } }
  public var maxSelected: Int? { get { json[field: "max_selected"] } set { json[field: "max_selected"] = newValue } }
  /// `.string` for a single choice, `.list` with `multiple`.
  public var `default`: FormValue? { get { json[field: "default"] } set { json[field: "default"] = newValue } }

  public var isMultiple: Bool { multiple ?? false }
}

/// `toggle`: a JSON boolean.
public struct ToggleFormField: FormFieldView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var `default`: Bool? { get { json[field: "default"] } set { json[field: "default"] = newValue } }
}

/// One field of an `input.form`, as the union on `kind`. A field whose kind this build does not
/// know is `.unknown`, keeping the raw object (so `id` and `label` stay readable); a form holding
/// one is answered 4041 `not_supported_on_device`.
public enum FormField: JSONConvertible, Codable, Hashable {
  case text(TextFormField)
  case number(NumberFormField)
  case amount(AmountFormField)
  case date(DateFormField)
  case time(TimeFormField)
  case datetime(DateTimeFormField)
  case daterange(DateRangeFormField)
  case choice(ChoiceFormField)
  case toggle(ToggleFormField)
  /// `kind` is the raw spelling (`""` when the field has none, or not a string).
  case unknown(kind: String, json: JSONObject)

  /// `nil` for a value that is not an object.
  public init?(jsonValue: JSONValue) {
    guard case .object(let object) = jsonValue else { return nil }
    let kind = object["kind"]?.stringValue ?? ""
    switch FormFieldKind.named(kind) {
    case .text: self = .text(TextFormField(json: object))
    case .number: self = .number(NumberFormField(json: object))
    case .amount: self = .amount(AmountFormField(json: object))
    case .date: self = .date(DateFormField(json: object))
    case .time: self = .time(TimeFormField(json: object))
    case .datetime: self = .datetime(DateTimeFormField(json: object))
    case .daterange: self = .daterange(DateRangeFormField(json: object))
    case .choice: self = .choice(ChoiceFormField(json: object))
    case .toggle: self = .toggle(ToggleFormField(json: object))
    case .unknown: self = .unknown(kind: kind, json: object)
    }
  }

  public var jsonValue: JSONValue { .object(json) }

  public init(from decoder: any Decoder) throws {
    let value = try JSONValue(from: decoder)
    guard let field = FormField(jsonValue: value) else {
      throw DecodingError.typeMismatch(
        JSONObject.self,
        DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "A form field is a JSON object")
      )
    }
    self = field
  }

  public func encode(to encoder: any Encoder) throws {
    try jsonValue.encode(to: encoder)
  }

  /// The object the field was read from, with every write through a typed view applied.
  public var json: JSONObject {
    switch self {
    case .text(let field): field.json
    case .number(let field): field.json
    case .amount(let field): field.json
    case .date(let field): field.json
    case .time(let field): field.json
    case .datetime(let field): field.json
    case .daterange(let field): field.json
    case .choice(let field): field.json
    case .toggle(let field): field.json
    case .unknown(_, let json): json
    }
  }

  public var kind: FormFieldKind {
    switch self {
    case .text: .text
    case .number: .number
    case .amount: .amount
    case .date: .date
    case .time: .time
    case .datetime: .datetime
    case .daterange: .daterange
    case .choice: .choice
    case .toggle: .toggle
    case .unknown(let kind, _): .unknown(kind)
    }
  }

  public var id: String? { json[field: "id"] }
  public var label: String? { json[field: "label"] }
  public var hint: String? { json[field: "hint"] }
  public var isRequired: Bool { json[field: "required"] ?? false }

  public var isUnknown: Bool {
    if case .unknown = self { return true }
    return false
  }
}

/// `input.form` params: the envelope plus 1–12 fields.
public struct InputFormParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = true

  /// The fields in order. An element that is not an object is dropped (the gateway sends none).
  public var fields: [FormField]? { get { json[field: "fields"] } set { json[field: "fields"] = newValue } }

  /// The first field this build cannot show, if any.
  public var firstUnknownField: FormField? { fields?.first(where: \.isUnknown) }
}

/// A value of a form field, by JSON type: the answer's `values` carry these. Build one with the
/// constructor for the field's kind so an amount is a string and never a number.
public enum FormValue: JSONConvertible, Codable, Hashable {
  /// `text`, `amount`, `date`, `time`, `datetime`, and a single `choice`.
  case string(String)
  /// `number`.
  case number(Double)
  /// `toggle`.
  case bool(Bool)
  /// `daterange`.
  case range(FormDateRange)
  /// A `choice` with `multiple`.
  case list([String])

  public static func text(_ value: String) -> FormValue { .string(value) }
  /// A decimal STRING such as `"180.00"`, never a JSON number.
  public static func amount(_ decimal: String) -> FormValue { .string(decimal) }
  public static func date(_ value: String) -> FormValue { .string(value) }
  public static func time(_ value: String) -> FormValue { .string(value) }
  /// An instant and its zone: `FormDateTime.value(instant:zone:)`.
  public static func datetime(instant: String, zone: String) -> FormValue {
    .string(FormDateTime.value(instant: instant, zone: zone))
  }
  public static func daterange(start: String, end: String) -> FormValue { .range(FormDateRange(start: start, end: end)) }
  public static func choice(_ value: String) -> FormValue { .string(value) }
  public static func choices(_ values: [String]) -> FormValue { .list(values) }
  public static func toggle(_ value: Bool) -> FormValue { .bool(value) }

  /// `nil` for `null`, an object other than `{start, end}`, and an array that is not all strings.
  public init?(jsonValue: JSONValue) {
    switch jsonValue {
    case .string(let value):
      self = .string(value)
    case .number(let value):
      self = .number(value)
    case .bool(let value):
      self = .bool(value)
    case .array(let values):
      let strings = values.compactMap(\.stringValue)
      guard strings.count == values.count else { return nil }
      self = .list(strings)
    case .object(let object):
      let range = FormDateRange(json: object)
      guard range.start != nil, range.end != nil else { return nil }
      self = .range(range)
    case .null:
      return nil
    }
  }

  public var jsonValue: JSONValue {
    switch self {
    case .string(let value): .string(value)
    case .number(let value): .number(value)
    case .bool(let value): .bool(value)
    case .range(let range): range.jsonValue
    case .list(let values): .array(values.map(JSONValue.string))
    }
  }

  public init(from decoder: any Decoder) throws {
    let value = try JSONValue(from: decoder)
    guard let formValue = FormValue(jsonValue: value) else {
      throw DecodingError.dataCorrupted(
        .init(codingPath: decoder.codingPath, debugDescription: "Not a form value"))
    }
    self = formValue
  }

  public func encode(to encoder: any Encoder) throws {
    try jsonValue.encode(to: encoder)
  }
}

/// The datetime answer format (contract §4): an instant (`YYYY-MM-DDTHH:MM[:SS]±HH:MM`, a numeric
/// offset, never `Z`) followed by its IANA zone as an RFC 9557 suffix in brackets.
/// `2026-10-03T14:30+02:00[Europe/Amsterdam]`. `Date` and `ISO8601DateFormatter` do not accept the
/// suffix: parse `split(_:)`'s instant.
public enum FormDateTime {
  public static func value(instant: String, zone: String) -> String { "\(instant)[\(zone)]" }

  /// The instant and the zone of a value, or `nil` when it has no bracketed suffix at its end.
  public static func split(_ value: String) -> (instant: String, zone: String)? {
    guard value.hasSuffix("]"), let open = value.lastIndex(of: "[") else { return nil }
    let zone = value[value.index(after: open)..<value.index(before: value.endIndex)]
    let instant = value[..<open]
    guard !zone.isEmpty, !instant.isEmpty else { return nil }
    return (String(instant), String(zone))
  }
}

/// `input.form` result: `{status: answered, values}` or `{status: skipped}`.
public struct InputFormResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// A field without a value is left out of `values` (never `null`).
  public static func answered(values: [String: FormValue]) -> InputFormResult {
    InputFormResult(json: ["status": InputStatus.answered.jsonValue, "values": values.jsonValue])
  }

  /// Only for a request whose `optional` is true; otherwise the gateway refuses it (`not_optional`).
  public static var skipped: InputFormResult {
    InputFormResult(json: ["status": InputStatus.skipped.jsonValue])
  }

  public var status: InputStatus? { json[field: "status"] }
  public var values: [String: FormValue]? { json[field: "values"] }
}

// MARK: - input.file (contract §5)

/// What `input.file` asks for.
public enum FileAccept: OpenStringEnum {
  case image, document, audio, any
  case unknown(String)

  public static let knownCases: [FileAccept] = [.image, .document, .audio, .any]

  public var rawValue: String {
    switch self {
    case .image: "image"
    case .document: "document"
    case .audio: "audio"
    case .any: "any"
    case .unknown(let raw): raw
    }
  }
}

/// A preference, never a forced camera: the person may always pick an existing file.
public enum FileCapture: OpenStringEnum {
  case photo, scan, audio
  case unknown(String)

  public static let knownCases: [FileCapture] = [.photo, .scan, .audio]

  public var rawValue: String {
    switch self {
    case .photo: "photo"
    case .scan: "scan"
    case .audio: "audio"
    case .unknown(let raw): raw
    }
  }
}

/// Where and how much the client uploads: each file goes to
/// `<dir>/<16 lowercase hex>-<safe name>` through the gateway's HTTP upload route.
public struct UploadTarget: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// An absolute directory.
  public var dir: String? { get { json[field: "dir"] } set { json[field: "dir"] = newValue } }
  /// Bounds EACH file, at most 104,857,600.
  public var maxBytes: Int? { get { json[field: "max_bytes"] } set { json[field: "max_bytes"] = newValue } }
  /// Bounds all files of the answer together: at least `maxBytes`, at most 104,857,600. A client
  /// checks both before uploading.
  public var maxTotalBytes: Int? {
    get { json[field: "max_total_bytes"] }
    set { json[field: "max_total_bytes"] = newValue }
  }
  /// At most 10.
  public var maxFiles: Int? { get { json[field: "max_files"] } set { json[field: "max_files"] = newValue } }
  /// Remove EXIF and GPS data from camera and library images before uploading; documents go as they are.
  public var stripMetadata: Bool? {
    get { json[field: "strip_metadata"] }
    set { json[field: "strip_metadata"] = newValue }
  }

  /// Whether `path` is absolute and, after resolving `.` and `..` segments lexically, starts with
  /// `dir` followed by `/`. A sibling directory sharing a prefix is not under it.
  public func contains(path: String) -> Bool {
    guard let dir, let root = Self.normalized(dir), let target = Self.normalized(path) else { return false }
    return target.count > root.count && target.starts(with: root)
  }

  /// The segments of an absolute path with `.` and `..` resolved, `nil` for a relative path or one
  /// that climbs above the root.
  private static func normalized(_ path: String) -> [Substring]? {
    guard path.hasPrefix("/") else { return nil }
    var segments: [Substring] = []
    for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
      switch segment {
      case ".": continue
      case "..":
        guard segments.popLast() != nil else { return nil }
      default: segments.append(segment)
      }
    }
    return segments
  }
}

/// `input.file` params: the envelope plus what to ask for and where to upload.
public struct InputFileParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = true

  public var accept: FileAccept? { get { json[field: "accept"] } set { json[field: "accept"] = newValue } }
  public var capture: FileCapture? { get { json[field: "capture"] } set { json[field: "capture"] = newValue } }
  public var multiple: Bool? { get { json[field: "multiple"] } set { json[field: "multiple"] = newValue } }
  public var upload: UploadTarget? { get { json[field: "upload"] } set { json[field: "upload"] = newValue } }

  public var isMultiple: Bool { multiple ?? false }
}

/// One uploaded file, by reference: files never travel inside the answer. `bytes` and `sha256`
/// describe the bytes as uploaded (after metadata stripping).
public struct UploadedFile: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(path: String, name: String, mime: String, bytes: Int, sha256: String) {
    self.init()
    self.path = path
    self.name = name
    self.mime = mime
    self.bytes = bytes
    self.sha256 = sha256
  }

  /// Absolute and under `upload.dir`.
  public var path: String? { get { json[field: "path"] } set { json[field: "path"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var mime: String? { get { json[field: "mime"] } set { json[field: "mime"] = newValue } }
  /// A JSON integer.
  public var bytes: Int? { get { json[field: "bytes"] } set { json[field: "bytes"] = newValue } }
  /// 64 lowercase hex.
  public var sha256: String? { get { json[field: "sha256"] } set { json[field: "sha256"] = newValue } }
}

/// `input.file` result: `{status: answered, files, text?}` or `{status: skipped}`.
public struct InputFileResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `text` (at most 4,000 characters) is an audio answer's transcript, when the client has one.
  public static func answered(files: [UploadedFile], text: String? = nil) -> InputFileResult {
    var result = InputFileResult(json: ["status": InputStatus.answered.jsonValue, "files": files.jsonValue])
    result.text = text
    return result
  }

  public static var skipped: InputFileResult {
    InputFileResult(json: ["status": InputStatus.skipped.jsonValue])
  }

  public var status: InputStatus? { json[field: "status"] }
  public var files: [UploadedFile]? { json[field: "files"] }
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
}

// MARK: - review.draft (contract §6)

/// What a draft is.
public enum DraftKind: OpenStringEnum {
  case mail, post, message, document
  case unknown(String)

  public static let knownCases: [DraftKind] = [.mail, .post, .message, .document]

  public var rawValue: String {
    switch self {
    case .mail: "mail"
    case .post: "post"
    case .message: "message"
    case .document: "document"
    case .unknown(let raw): raw
    }
  }
}

/// `review.draft` params: the envelope plus the draft. `optional` is false: there is no skip, the
/// person rejects.
public struct ReviewDraftParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = false

  public var kind: DraftKind? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  /// 1–20,000 characters, shown verbatim: monospaced where whitespace matters, never re-wrapped.
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  /// At most 200 characters, display only, shown apart from the body.
  public var subject: String? { get { json[field: "subject"] } set { json[field: "subject"] = newValue } }
  /// Up to 10 strings of at most 120 characters, display only.
  public var recipients: [String]? { get { json[field: "recipients"] } set { json[field: "recipients"] = newValue } }
  /// Whether the person may change the text before approving; true when absent.
  public var editable: Bool? { get { json[field: "editable"] } set { json[field: "editable"] = newValue } }

  public var isEditable: Bool { editable ?? true }
}

/// The closed enum a `review.draft` result starts with.
public enum ReviewDecision: OpenStringEnum {
  case approved, rejected
  case unknown(String)

  public static let knownCases: [ReviewDecision] = [.approved, .rejected]

  public var rawValue: String {
    switch self {
    case .approved: "approved"
    case .rejected: "rejected"
    case .unknown(let raw): raw
    }
  }
}

/// `review.draft` result: `{decision: approved, text}` or `{decision: rejected, comment?}`. Whether
/// the text was edited is the gateway's computation, not the client's.
public struct ReviewDraftResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The text as approved (1–20,000 characters), unchanged unless the draft is `editable`.
  public static func approved(text: String) -> ReviewDraftResult {
    ReviewDraftResult(json: ["decision": ReviewDecision.approved.jsonValue, "text": .string(text)])
  }

  /// `comment` is at most 1,000 characters.
  public static func rejected(comment: String? = nil) -> ReviewDraftResult {
    var result = ReviewDraftResult(json: ["decision": ReviewDecision.rejected.jsonValue])
    result.comment = comment
    return result
  }

  public var decision: ReviewDecision? { json[field: "decision"] }
  public var text: String? { get { json[field: "text"] } set { json[field: "text"] = newValue } }
  public var comment: String? { get { json[field: "comment"] } set { json[field: "comment"] = newValue } }
}
