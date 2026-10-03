import Foundation
import HermieProtocol
import Synchronization

extension HTTPClient {
  /// `POST /api/files/upload-stream` (`uploadFile` in `file-upload.ts`): one local file to one
  /// absolute path on the gateway. Answers the path the file landed on (the answer's `path` wins
  /// over the one asked for: a symlinked home is the ordinary case).
  ///
  /// - The multipart body is assembled on disk and streamed from there, so a 100 MiB file is never
  ///   in memory.
  /// - Progress is the bytes the session has handed to the network, 0 to 1.
  /// - No redirect is followed: the credential and the file stay with the gateway.
  /// - A 401 asks the credential provider once, as every other call does; a second one throws `auth`.
  /// - Cancelling the task cancels the request, and the gateway removes its temporary file when the
  ///   stream ends early.
  ///
  /// Errors are `GatewayError`s: a 413 is `protocol` with `status: 413`, another refusal is
  /// `protocol` with the gateway's own `detail` as `hint`, a 5xx is `server`, and an unreachable
  /// gateway is `network`.
  public func uploadFile(
    from file: URL,
    name: String,
    mimeType: String,
    to path: String,
    onProgress: (@Sendable (Double) -> Void)? = nil
  ) async throws -> String {
    let url = try GatewayAddress.apiURL(baseURL, path: RESTPath.fileUpload)
    let boundary = "hermie-\(UUID().uuidString)"
    let body = try Self.stageMultipart(file: file, name: name, mimeType: mimeType, path: path, boundary: boundary)

    defer { try? FileManager.default.removeItem(at: body.deletingLastPathComponent()) }

    var attempt = try await upload(url, body: body, boundary: boundary, auth: AuthHeaderOptions(), onProgress: onProgress)

    if attempt.status == 401 {
      if try await credentials.onRejected(rejectedToken: attempt.usedToken) == .reauth {
        throw GatewayError(.auth, "The gateway rejected the credentials for the upload. Sign in again.", status: 401)
      }

      attempt = try await upload(
        url, body: body, boundary: boundary, auth: AuthHeaderOptions(forceRefresh: false), onProgress: onProgress)
    }

    return try Self.stored(from: attempt, asked: path, url: url)
  }

  private struct UploadAttempt {
    var status: Int
    var data: Data
    var usedToken: String?
  }

  private func upload(
    _ url: String,
    body: URL,
    boundary: String,
    auth options: AuthHeaderOptions,
    onProgress: (@Sendable (Double) -> Void)?
  ) async throws -> UploadAttempt {
    guard let target = URL(string: url), URLOrigin(target) != nil else {
      throw GatewayError(.network, "Could not reach \(url): it is not a valid address.")
    }

    let auth = try await credentials.httpAuthHeaders(options)
    var request = URLRequest(url: target)

    request.httpMethod = "POST"
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = false
    // The idle window between bytes; a big file on a slow line is not a stalled one.
    request.timeoutInterval = 120
    request.setValue("application/json", forHTTPHeaderField: "accept")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")

    for (name, value) in extraHeaders.merging(auth, uniquingKeysWith: { _, auth in auth }) {
      request.setValue(value, forHTTPHeaderField: name)
    }

    let delegate = UploadDelegate(onProgress: onProgress)
    let data: Data
    let response: URLResponse

    do {
      (data, response) = try await transport.session.upload(for: request, fromFile: body, delegate: delegate)
    } catch {
      if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
        if let redirected = delegate.refusedRedirect {
          throw FetchJSON.redirectError(requestedURL: url, target: redirected, status: nil)
        }

        throw CancellationError()
      }

      throw GatewayError(.network, "Could not reach \(url): \((error as NSError).localizedDescription)")
    }

    if let redirected = delegate.refusedRedirect {
      throw FetchJSON.redirectError(
        requestedURL: url, target: redirected, status: (response as? HTTPURLResponse)?.statusCode)
    }

    return UploadAttempt(
      status: (response as? HTTPURLResponse)?.statusCode ?? 0,
      data: data,
      usedToken: GatewayCredentials.bearer(from: auth)
    )
  }

  private static func stored(from attempt: UploadAttempt, asked: String, url: String) throws -> String {
    let text = HTTPTransport.decodeText(attempt.data)

    switch attempt.status {
    case 200...299:
      guard case .object(let body)? = try? JSONValue(parsing: text), case .string(let stored)? = body["path"],
        !stored.isEmpty
      else {
        return asked
      }

      return stored
    case 401:
      throw GatewayError(.auth, "The gateway refused the upload (HTTP 401).", status: 401)
    case 413:
      throw GatewayError(
        .protocol, "The gateway refused the upload: the file is over its size limit.", status: 413,
        hint: detail(of: text))
    case 500...:
      throw GatewayError(.server, "The gateway answered HTTP \(attempt.status) on the upload.", status: attempt.status)
    default:
      throw GatewayError(
        .protocol, "The upload failed with HTTP \(attempt.status).", status: attempt.status, hint: detail(of: text))
    }
  }

  /// The three form fields `upload_managed_file_stream` declares (`path`, `overwrite`, and the part
  /// named `file`), the file copied in chunks.
  static func stageMultipart(file: URL, name: String, mimeType: String, path: String, boundary: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let destination = directory.appendingPathComponent("body.multipart")

    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    guard FileManager.default.createFile(atPath: destination.path, contents: nil),
      let output = FileHandle(forWritingAtPath: destination.path)
    else {
      throw GatewayError(.config, "The upload could not be prepared on this device.")
    }

    defer { try? output.close() }

    do {
      func write(_ text: String) throws {
        try output.write(contentsOf: Data(text.utf8))
      }

      let safeName = name.filter { $0 != "\"" && $0 != "\r" && $0 != "\n" }

      try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n\(path)\r\n")
      try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n")
      try write(
        "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n"
          + "Content-Type: \(mimeType)\r\n\r\n")

      let source = try FileHandle(forReadingFrom: file)

      defer { try? source.close() }

      while let chunk = try source.read(upToCount: 256 * 1024), !chunk.isEmpty {
        try output.write(contentsOf: chunk)
      }

      try write("\r\n--\(boundary)--\r\n")
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw GatewayError(.config, "The file could not be read for the upload: \((error as NSError).localizedDescription)")
    }

    return destination
  }
}

/// Reports what the session has sent, and refuses every redirect (remembering the first).
private final class UploadDelegate: NSObject, URLSessionTaskDelegate, Sendable {
  private let onProgress: (@Sendable (Double) -> Void)?
  private let refused = Mutex<String?>(nil)
  /// The last fraction passed on: a callback per network write would be a hop per chunk.
  private let reported = Mutex<Double>(-1)

  init(onProgress: (@Sendable (Double) -> Void)?) {
    self.onProgress = onProgress
  }

  var refusedRedirect: String? { refused.withLock { $0 } }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64,
    totalBytesExpectedToSend: Int64
  ) {
    guard totalBytesExpectedToSend > 0 else {
      return
    }

    let fraction = min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    let pass = reported.withLock { last -> Bool in
      guard fraction - last >= 0.01 || fraction >= 1 && last < 1 else { return false }
      last = fraction
      return true
    }

    if pass {
      onProgress?(fraction)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    refused.withLock { $0 = $0 ?? request.url?.absoluteString ?? "" }
    completionHandler(nil)
  }
}
