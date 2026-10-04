import CryptoKit
import Foundation
import HermieProtocol

/// An `input.signature` request read strictly: the statement and the upload target are known to be what the sheet
/// and the answer need (`contract/requests/README.md` §8). A frame that is not wholly in the contract is not shown
/// (`InteractivePrompt.read`): a statement this app cannot show exactly as it is would make the hash a lie about
/// what the person saw.
public struct SignatureRequest: Sendable, Equatable {
  public let params: InputSignatureParams
  /// 1–500 characters, exactly as the frame carried it: never cleaned, trimmed or re-wrapped.
  public let statement: String
  /// The name shown with the statement, cleaned to one line; nil when the request names none.
  public let signerName: String?
  public let upload: UploadTarget

  /// The longest statement, in code points.
  public static let statementLimit = 500
  /// The longest signer name, in code points.
  public static let signerNameLimit = 80

  /// SHA-256 of the UTF-8 bytes of `statement`, lowercase hex: what the answer's `statement_sha256` carries. The
  /// request holds the statement it shows, and this is computed from that same string, so the hash can only be of
  /// what the person saw.
  public var statementSHA256: String { Self.sha256(of: statement) }

  /// 64 lowercase hex over the UTF-8 bytes of `text`, with no normalisation, trimming or line-ending change.
  public static func sha256(of text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// `nil` when the frame is not one this build can show: no statement, an empty or over-long one, one that holds a
  /// character that does not show as itself, an upload target without an absolute directory or without room for the
  /// two files.
  static func read(_ params: InputSignatureParams) -> SignatureRequest? {
    guard let statement = params.statement, !statement.isEmpty else {
      return nil
    }

    // Counted in code points, as the gateway counts. Nothing the person could not see exactly as it is.
    guard statement.unicodeScalars.count <= statementLimit, !statement.unicodeScalars.contains(where: DraftText.isRevealed)
    else {
      return nil
    }

    guard let upload = params.upload, let dir = upload.dir, dir.hasPrefix("/"), (upload.maxFiles ?? 0) >= 2 else {
      return nil
    }

    if let each = upload.maxBytes, let total = upload.maxTotalBytes, total < each {
      return nil
    }

    let name = params.signerName.map { InteractivePrompt.line($0, limit: signerNameLimit) }.flatMap { $0.isEmpty ? nil : $0 }

    return SignatureRequest(params: params, statement: statement, signerName: name, upload: upload)
  }

  /// `signed_at` is at most 2^53, as `at` of `device.location` is.
  static let signedAtLimit = 9_007_199_254_740_992

  /// The answer for the two uploaded files and the client's time, or nil when they could never be one the gateway
  /// takes: not exactly one PNG and one SVG by their declared type, a name that does not end `.png` or `.svg` to
  /// match, a file outside the upload directory or over its bounds, a time that is not Unix seconds. The hash is the
  /// statement's own (`statementSHA256`).
  func answer(files: [UploadedFile], signedAt: Int) -> InputSignatureResult? {
    guard files.count == 2, (0...Self.signedAtLimit).contains(signedAt),
      files.filter({ $0.mime == "image/png" }).count == 1, files.filter({ $0.mime == "image/svg+xml" }).count == 1
    else {
      return nil
    }

    var total = 0

    for file in files {
      guard let path = file.path, upload.contains(path: path), let bytes = file.bytes, bytes >= 0,
        let sha = file.sha256, sha.count == 64
      else {
        return nil
      }

      let suffix = file.mime == "image/png" ? ".png" : ".svg"

      guard path.lowercased().hasSuffix(suffix), bytes <= (upload.maxBytes ?? .max) else {
        return nil
      }

      total += bytes
    }

    guard total <= (upload.maxTotalBytes ?? .max) else {
      return nil
    }

    return InputSignatureResult.answered(files: files, signedAt: signedAt, statementSHA256: statementSHA256)
  }
}

/// A `device.scan` request read strictly: the symbologies asked for are known and distinct.
public struct ScanRequest: Sendable, Equatable {
  public let params: DeviceScanParams
  /// The symbologies asked for; empty for every symbology the device reads.
  public let formats: [ScanSymbology]

  /// Whether a code of `symbology` is one the request asks for.
  public func accepts(_ symbology: ScanSymbology) -> Bool {
    symbology.isKnown && (formats.isEmpty || formats.contains(symbology))
  }

  /// `nil` when `formats` is present but is not 1 to 7 distinct names of the contract.
  static func read(_ params: DeviceScanParams) -> ScanRequest? {
    guard let raw = params.json["formats"], raw != .null else {
      return ScanRequest(params: params, formats: [])
    }

    guard case .array(let items) = raw, (1...ScanSymbology.knownCases.count).contains(items.count) else {
      return nil
    }

    var formats: [ScanSymbology] = []

    for item in items {
      guard let name = item.stringValue, case let symbology = ScanSymbology.named(name), symbology.isKnown,
        !formats.contains(symbology)
      else {
        return nil
      }

      formats.append(symbology)
    }

    return ScanRequest(params: params, formats: formats)
  }
}
