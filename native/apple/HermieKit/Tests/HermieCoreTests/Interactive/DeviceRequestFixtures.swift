import CryptoKit
import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// The contract's examples (`contract/requests/examples.json`) for the signature, the code scan and the voice note,
/// and the prompts the center would make of their frames.
enum DeviceExamples {
  static let contractDirectory: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("contract", isDirectory: true)
  }()

  /// `Tests/Vectors/`: data the clients check themselves against, written by scripts of the fake gateway.
  static let vectorsDirectory: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("Vectors", isDirectory: true)
  }()

  static func methodSection(_ method: String, _ key: String) throws -> [JSONValue] {
    let data = try Data(contentsOf: contractDirectory.appendingPathComponent("requests/examples.json"))
    let root = try JSONValue(parsing: data)
    return try #require(root["methods"]?[method]?[key]?.arrayValue, "\(method).\(key)")
  }

  /// The params of the contract's frame with this request id, with an `expires_at` ahead of now.
  static func params(_ method: String, id: String) throws -> JSONObject {
    let match = try #require(try methodSection(method, "frames").first { $0["id"]?.stringValue == id }, "\(id)")
    var params = try #require(match["params"]?.objectValue)
    params["expires_at"] = .number(Double(Int(Date().timeIntervalSince1970) + 300))
    return params
  }

  /// What the center makes of these params, as it reads them.
  static func reading(_ method: String, _ params: JSONObject) -> InteractiveReading {
    InteractivePrompt.read(ServerRequestBody(method: method, params: params))
  }

  static func prompt(_ method: String, id: String) throws -> InteractivePrompt {
    try prompt(method, try params(method, id: id))
  }

  static func prompt(_ method: String, _ params: JSONObject) throws -> InteractivePrompt {
    guard case .content(let content) = reading(method, params) else {
      throw ReadFailure(method: method)
    }

    return InteractivePrompt(id: "srq-1", content: content, chatKey: "bot", sessionID: "s", deadline: nil)
  }

  /// SHA-256 of `data`, 64 lowercase hex.
  static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  struct ReadFailure: Error, CustomStringConvertible {
    let method: String
    var description: String { "\(method): not shown" }
  }

  /// An uploaded file as the contract's answers write one.
  static func file(
    _ name: String, mime: String, bytes: Int = 1_000, dir: String = "/home/ada/work/uploads/hermie/2026-10-04",
    token: String = "5c1d9e0a7b3f2468"
  ) -> UploadedFile {
    UploadedFile(
      path: "\(dir)/\(token)-\(name)", name: name, mime: mime, bytes: bytes,
      sha256: String(repeating: "a", count: 64))
  }
}

/// An uploader that stores nothing and answers the path it was asked for, and remembers what it was asked.
final class RecordingUploader: Sendable {
  struct Call: Equatable, Sendable {
    var name: String
    var mime: String
    var path: String
    var data: Data
  }

  private let recorded = Mutex<[Call]>([])
  /// Fail every call with this message (a network error).
  private let failure = Mutex<String?>(nil)

  var calls: [Call] { recorded.withLock { $0 } }

  func failEvery(with message: String?) {
    failure.withLock { $0 = message }
  }

  var uploader: InteractiveUploader {
    { [self] file, name, mime, path, progress in
      if let message = failure.withLock({ $0 }) {
        throw GatewayError(.network, message)
      }

      let data = (try? Data(contentsOf: file)) ?? Data()
      recorded.withLock { $0.append(Call(name: name, mime: mime, path: path, data: data)) }
      progress?(1)
      return path
    }
  }
}
