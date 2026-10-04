import Foundation

// `input.signature` (contract/requests/README.md §8) and `device.scan` (§12), and the cross-field
// reading of a voice note (`input.file` with `accept: audio`, §5.1).
//
// Wire views, read as tolerantly as every wire type here. The strict reading, the one that decides
// whether this app can show a request at all, is `InteractivePrompt.read` in HermieCore.

// MARK: - device.scan (contract §12)

/// What a code is: the seven symbologies the contract names. Open: a name this build does not know
/// reads as `.unknown`, and a request that lists one is not shown.
public enum ScanSymbology: OpenStringEnum {
  case qr, ean13, ean8, code128, pdf417, datamatrix, aztec
  case unknown(String)

  public static let knownCases: [ScanSymbology] = [.qr, .ean13, .ean8, .code128, .pdf417, .datamatrix, .aztec]

  public var rawValue: String {
    switch self {
    case .qr: "qr"
    case .ean13: "ean13"
    case .ean8: "ean8"
    case .code128: "code128"
    case .pdf417: "pdf417"
    case .datamatrix: "datamatrix"
    case .aztec: "aztec"
    case .unknown(let raw): raw
    }
  }
}

/// `device.scan` params: the envelope plus `formats`, 1–7 distinct symbologies, or absent for every
/// symbology the device reads. `optional` is true unless the agent says otherwise.
public struct DeviceScanParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = true

  /// The symbologies asked for, in the order sent. An element this build does not know reads as
  /// `.unknown`; `InteractivePrompt.read` refuses the request instead of dropping it.
  public var formats: [ScanSymbology]? { get { json[field: "formats"] } set { json[field: "formats"] = newValue } }
}

/// `device.scan` result: `{status: answered, value, symbology}` or `{status: skipped}`.
public struct DeviceScanResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `value` is the decoded text, 1–4,096 characters, untrusted; `symbology` is what was read (one of
  /// the request's `formats` when it had them).
  public static func answered(value: String, symbology: ScanSymbology) -> DeviceScanResult {
    DeviceScanResult(json: [
      "status": InputStatus.answered.jsonValue, "value": .string(value), "symbology": symbology.jsonValue
    ])
  }

  /// Only for a request whose `optional` is true; otherwise the gateway refuses it (`not_optional`).
  public static var skipped: DeviceScanResult {
    DeviceScanResult(json: ["status": InputStatus.skipped.jsonValue])
  }

  public var status: InputStatus? { json[field: "status"] }
  public var value: String? { json[field: "value"] }
  public var symbology: ScanSymbology? { json[field: "symbology"] }
}

// MARK: - input.signature (contract §8)

/// `input.signature` params: the envelope plus the statement the person signs, a name to show with it
/// and where the two files of the signature go.
public struct InputSignatureParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = true

  /// 1–500 characters, shown in FULL and verbatim above the pad. The answer's hash is of these exact
  /// bytes, so it is never cleaned, trimmed or re-wrapped.
  public var statement: String? { get { json[field: "statement"] } set { json[field: "statement"] = newValue } }
  /// 1–80 characters, one line, display only.
  public var signerName: String? { get { json[field: "signer_name"] } set { json[field: "signer_name"] = newValue } }
  /// As for `input.file`, with room for at least two files.
  public var upload: UploadTarget? { get { json[field: "upload"] } set { json[field: "upload"] = newValue } }
}

/// `input.signature` result: `{status: answered, files, signed_at, statement_sha256}` or
/// `{status: skipped}`.
public struct InputSignatureResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `files` are the PNG and the SVG, in either order; `signedAt` is the client's clock in Unix
  /// seconds; `statementSHA256` is 64 lowercase hex over the UTF-8 bytes of the request's statement.
  public static func answered(files: [UploadedFile], signedAt: Int, statementSHA256: String) -> InputSignatureResult {
    InputSignatureResult(json: [
      "status": InputStatus.answered.jsonValue, "files": files.jsonValue, "signed_at": signedAt.jsonValue,
      "statement_sha256": .string(statementSHA256)
    ])
  }

  public static var skipped: InputSignatureResult {
    InputSignatureResult(json: ["status": InputStatus.skipped.jsonValue])
  }

  public var status: InputStatus? { json[field: "status"] }
  public var files: [UploadedFile]? { json[field: "files"] }
  public var signedAt: Int? { json[field: "signed_at"] }
  public var statementSHA256: String? { json[field: "statement_sha256"] }
}

// MARK: - input.file: a voice note (contract §5.1)

extension InputFileParams {
  /// A request for a recording made on the device: `accept: audio` and `capture: audio`.
  public var asksForRecording: Bool { accept == .audio && capture == .audio }

  /// The cross-field rule of §5.1 that a frame must keep: `capture: audio` goes with `accept: audio`
  /// and only with it, and `accept: audio` takes `capture: audio` or none. The gateway never builds a
  /// frame that breaks it.
  public var capturePairsWithAccept: Bool {
    guard let capture else { return true }
    return (capture == .audio) == (accept == .audio)
  }
}
