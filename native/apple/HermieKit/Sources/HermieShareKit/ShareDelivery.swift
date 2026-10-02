import Foundation
import HermieShared

/**
 Sending a share from inside the share sheet, without the app (ADR-0026).

 There is no REST route that submits a prompt: `/api/files/upload-stream` and `/api/auth/ws-ticket`
 are HTTP, and `prompt.submit` is JSON-RPC over the WebSocket at `/api/ws`. Every leg runs on one
 ephemeral session that refuses redirects (`ShareTransport`), and the whole attempt has a deadline
 (`ShareLease.attemptDeadline`): what does not finish inside the extension's lifetime is left for
 the app.

 ## The order, and what each step costs if it fails

 1. The entry is ALREADY on disk before this runs. Nothing here can lose a share.
 2. Credential, target and gateway checks. Any miss queues.
 3. The lease: the app does not deliver this entry while the extension works on it.
 4. A ticket, for a gated gateway; `session.resume`; every file uploaded and turned into an
    `@file:` token.
 5. The claim, written immediately before the submit — and only if the entry is still there. When
    the app has taken it in the meantime, the extension does not send it too.
 6. `prompt.submit`, then the entry is removed.

 Everything before 5 fails towards "leave it exactly as it was" (and releases the lease so the app
 can deliver it at once). Steps 5 and 6 fail towards "ask the person": the claim stays, and the app
 never sends a claimed entry without asking.

 Images are not sent from here: the app sends a shared image as resized bytes over the socket
 (`image.attach_bytes`), which is what puts it in the transcript, and resizing a photograph is the
 work an extension is killed for. An entry with an image is always the app's.
 */
public enum ShareDelivery {
  public enum Outcome: Sendable, Equatable {
    case sent
    /// Left on disk for the app. The reason is for a developer screen, never the sheet.
    case queued(reason: String)
    /// The app took the entry while this was working, and is delivering it.
    case takenByApp
  }

  /// One file to upload, as the sheet has it staged.
  public struct Attachment: Sendable, Equatable {
    public let url: URL
    public let name: String
    public let mimeType: String

    public init(url: URL, name: String, mimeType: String) {
      self.url = url
      self.name = name
      self.mimeType = mimeType
    }
  }

  public struct Request: Sendable {
    /// The outbox entry's id.
    public let entry: String
    public let bot: String
    /// The gateway the entry was written for.
    public let gatewayKey: String?
    /// The note, then the URLs and shared text, one paragraph each (`PendingShare.messageText`).
    public let text: String
    public let attachments: [Attachment]

    public init(entry: String, bot: String, gatewayKey: String?, text: String, attachments: [Attachment]) {
      self.entry = entry
      self.bot = bot
      self.gatewayKey = gatewayKey
      self.text = text
      self.attachments = attachments
    }
  }

  /**
   The whole ladder, or the first reason it stopped. Never throws: every failure is a `queued`,
   and the entry is already safe on disk.
   */
  public static func deliver(
    _ request: Request,
    credential: ShareCredential?,
    targets: ShareTargets?,
    outbox: ShareOutbox,
    deadline: Duration = ShareLease.attemptDeadline
  ) async -> Outcome {
    guard let credential else {
      return .queued(reason: "no usable credential in the keychain")
    }

    if credential.record.isExpired(now: Date()) {
      return .queued(reason: "the stored credential has expired")
    }

    guard let session = targets?.session(for: request.bot) else {
      return .queued(reason: "no session recorded for this bot")
    }

    // Both sides must name the same gateway, and the entry too when it says. A missing key on
    // either side is not a match: the session id could belong to a gateway this credential is not for.
    let keys = [targets?.gatewayKey ?? "", credential.gatewayKey] + (request.gatewayKey.map { [$0] } ?? [])

    guard keys.allSatisfy({ !$0.isEmpty && $0 == credential.gatewayKey }) else {
      return .queued(reason: "the targets, the credential and the entry do not name the same gateway")
    }

    guard outbox.lease(entry: request.entry) else {
      return .takenByApp
    }

    let urlSession = ShareTransport.makeSession()

    defer { urlSession.invalidateAndCancel() }

    let outcome = await withTaskGroup(of: Outcome?.self) { group in
      group.addTask {
        await attempt(request, session: session, credential: credential, outbox: outbox, urlSession: urlSession)
      }
      group.addTask {
        try? await Task.sleep(for: deadline)

        return Task.isCancelled ? nil : .queued(reason: "the attempt ran out of time")
      }

      var first: Outcome?

      for await result in group {
        if let result, first == nil {
          first = result
          group.cancelAll()
        }
      }

      return first ?? .queued(reason: "the attempt was cancelled")
    }

    if outcome != .sent {
      outbox.releaseLease(entry: request.entry)
    }

    return outcome
  }

  private static func attempt(
    _ request: Request,
    session sessionId: String,
    credential: ShareCredential,
    outbox: ShareOutbox,
    urlSession: URLSession
  ) async -> Outcome {
    let http = ShareHTTP(credential: credential, session: urlSession)
    var ticket: String?

    if credential.needsTicket {
      do {
        ticket = try await http.mintWebSocketTicket()
      } catch {
        return .queued(reason: "the gateway would not mint a socket ticket")
      }
    }

    guard let socketURL = credential.websocketURL() else {
      return .queued(reason: "the stored address is not a URL")
    }

    let socket = ShareSocket(url: socketURL, credential: credential, ticket: ticket, session: urlSession)

    defer { socket.close() }

    // A pending `receive()` does not notice a cancelled task; closing the socket is what ends it
    // when the deadline passes.
    return await withTaskCancellationHandler {
      await converse(request, session: sessionId, socket: socket, http: http, outbox: outbox)
    } onCancel: {
      socket.close()
    }
  }

  private static func converse(
    _ request: Request,
    session sessionId: String,
    socket: ShareSocket,
    http: ShareHTTP,
    outbox: ShareOutbox
  ) async -> Outcome {
    var claimed = false

    do {
      try await socket.open()

      let resume = try await socket.request(
        "session.resume",
        params: ["session_id": sessionId, "profile": request.bot, "omit_messages": true, "source": "hermie"]
      )

      guard let runtime = resume["session_id"] as? String, !runtime.isEmpty else {
        return .queued(reason: "the gateway resumed without a session id")
      }

      var body = request.text

      if !request.attachments.isEmpty {
        let cwd = ((resume["info"] as? [String: Any])?["cwd"] as? String) ?? ""

        // A file has to land under the session's working directory, or the reference is refused.
        guard !cwd.isEmpty else {
          return .queued(reason: "the session reported no working directory")
        }

        var references: [String] = []

        for attachment in request.attachments {
          let stored = try await http.upload(attachment, to: uploadPath(cwd: cwd, name: attachment.name))

          references.append(fileReference(stored))
        }

        body = ([body] + references).filter { !$0.isEmpty }.joined(separator: "\n\n")
      }

      guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return .queued(reason: "there was nothing to send")
      }

      try Task.checkCancellation()

      // LAST before the submit, and only for an entry the app has not taken.
      guard outbox.claim(entry: request.entry, bot: request.bot) else {
        return .takenByApp
      }

      claimed = true

      _ = try await socket.request("prompt.submit", params: ["session_id": runtime, "profile": request.bot, "text": body])
    } catch {
      // A claim, if one was written, stays: from here an attempt that failed before the submit and
      // one that failed after it look the same, and the app asks.
      return .queued(reason: claimed ? "the submit was not confirmed" : "the gateway did not accept the message")
    }

    outbox.remove(entry: request.entry)

    return .sent
  }

  /// `<cwd>/uploads/hermie/<yyyy-mm-dd>/<token>-<name>`, as the app's uploader builds it.
  static func uploadPath(cwd: String, name: String, now: Date = Date()) -> String {
    var root = cwd

    while root.hasSuffix("/") {
      root.removeLast()
    }

    let formatter = DateFormatter()

    formatter.dateFormat = "yyyy-MM-dd"
    formatter.locale = Locale(identifier: "en_US_POSIX")

    let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    let token = String((0..<8).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })

    return "\(root)/uploads/hermie/\(formatter.string(from: now))/\(token)-\(ShareOutbox.safeFileName(name))"
  }

  /// The token the gateway expands into the file; backticks when the path holds whitespace.
  static func fileReference(_ path: String) -> String {
    path.rangeOfCharacter(from: .whitespaces) == nil ? "@file:\(path)" : "@file:`\(path)`"
  }
}

/// Why a leg stopped. The sheet says one thing for all of them.
enum ShareDeliveryError: Error, Sendable {
  case badAddress
  case staging
  case refused(Int)
  case rejected(String)
  case protocolBreak
}

/// The HTTP legs: the ticket and the uploads, on the redirect-refusing session.
struct ShareHTTP: Sendable {
  let credential: ShareCredential
  let session: URLSession

  /// `POST /api/auth/ws-ticket`: single use, one per dial.
  func mintWebSocketTicket() async throws -> String {
    guard let url = credential.apiURL("/api/auth/ws-ticket") else {
      throw ShareDeliveryError.badAddress
    }

    var request = URLRequest(url: url)

    request.httpMethod = "POST"
    request.httpBody = Data("{}".utf8)
    request.setValue("application/json", forHTTPHeaderField: "content-type")

    for (name, value) in credential.requestHeaders() {
      request.setValue(value, forHTTPHeaderField: name)
    }

    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0

    guard status == 200, let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let ticket = root["ticket"] as? String, !ticket.isEmpty else {
      throw ShareDeliveryError.refused(status)
    }

    return ticket
  }

  /**
   One file to one absolute path, and the path it actually landed on (`path` in the answer wins:
   a symlinked home is the ordinary case). The body is assembled on disk, never in memory.
   */
  func upload(_ attachment: ShareDelivery.Attachment, to path: String) async throws -> String {
    guard let url = credential.apiURL("/api/files/upload-stream") else {
      throw ShareDeliveryError.badAddress
    }

    let boundary = "hermie-\(UUID().uuidString)"
    let body = try stageMultipart(attachment, path: path, boundary: boundary)

    defer { try? FileManager.default.removeItem(at: body.deletingLastPathComponent()) }

    var request = URLRequest(url: url)

    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")

    for (name, value) in credential.requestHeaders() {
      request.setValue(value, forHTTPHeaderField: name)
    }

    let (data, response) = try await session.upload(for: request, fromFile: body)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0

    guard (200..<300).contains(status) else {
      throw ShareDeliveryError.refused(status)
    }

    let stored = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["path"] as? String

    return stored.flatMap { $0.isEmpty ? nil : $0 } ?? path
  }

  /// The three form fields `upload_managed_file_stream` declares, with the file appended in chunks.
  private func stageMultipart(_ attachment: ShareDelivery.Attachment, path: String, boundary: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let destination = directory.appendingPathComponent("body.multipart")

    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    guard FileManager.default.createFile(atPath: destination.path, contents: nil),
      let handle = FileHandle(forWritingAtPath: destination.path) else {
      throw ShareDeliveryError.staging
    }

    defer { try? handle.close() }

    func write(_ text: String) throws {
      try handle.write(contentsOf: Data(text.utf8))
    }

    try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n\(path)\r\n")
    try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n")
    try write(
      "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(attachment.name)\"\r\n"
        + "Content-Type: \(attachment.mimeType)\r\n\r\n")

    guard ShareOutbox.isRegularFile(attachment.url), let source = try? FileHandle(forReadingFrom: attachment.url) else {
      throw ShareDeliveryError.staging
    }

    defer { try? source.close() }

    while let chunk = try source.read(upToCount: 256 * 1024), !chunk.isEmpty {
      try handle.write(contentsOf: chunk)
    }

    try write("\r\n--\(boundary)--\r\n")

    return destination
  }
}

/**
 The WebSocket leg: open, wait for `gateway.ready`, make one call at a time.

 Sequential on purpose: it reads frames until it sees the id it is waiting for and discards
 everything else. A permission prompt arriving here has nobody to answer it, and `prompt.submit`
 answers as soon as the turn is accepted.
 */
final class ShareSocket: @unchecked Sendable {
  private let task: URLSessionWebSocketTask
  /// Only the one attempt that owns this socket touches it, one call at a time.
  private var nextId = 1

  init(url: URL, credential: ShareCredential, ticket: String?, session: URLSession) {
    var request = URLRequest(url: url)

    for (name, value) in credential.requestHeaders() {
      request.setValue(value, forHTTPHeaderField: name)
    }

    // The single-use ticket travels in the subprotocol list for a gated gateway. Set on the request
    // rather than through `webSocketTask(with:protocols:)`, which takes no headers.
    if let ticket {
      request.setValue("hermes-gateway-v1, hermes-gateway-ticket.\(ticket)", forHTTPHeaderField: "Sec-WebSocket-Protocol")
    }

    task = session.webSocketTask(with: request)
  }

  func close() {
    task.cancel(with: .normalClosure, reason: nil)
  }

  /// A deadline, as a cancellation of the socket: a pending `receive()` then throws.
  private func watchdog(_ duration: Duration) -> Task<Void, Never> {
    Task { [weak self] in
      try? await Task.sleep(for: duration)

      guard !Task.isCancelled else {
        return
      }

      self?.task.cancel(with: .goingAway, reason: nil)
    }
  }

  /// Open, and wait for `gateway.ready`: a gated gateway accepts the upgrade and then closes.
  func open() async throws {
    task.resume()

    let deadline = watchdog(.seconds(15))

    defer { deadline.cancel() }

    while true {
      let frame = try await receive()

      if (frame["method"] as? String) == "event", let params = frame["params"] as? [String: Any],
        (params["type"] as? String) == "gateway.ready" {
        return
      }
    }
  }

  /// One JSON-RPC call, and its result. A gateway error is thrown.
  func request(_ method: String, params: [String: Any]) async throws -> [String: Any] {
    let id = "share-\(nextId)"

    nextId += 1

    let frame: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method, "params": params]

    try await task.send(.data(try JSONSerialization.data(withJSONObject: frame)))

    let deadline = watchdog(.seconds(30))

    defer { deadline.cancel() }

    while true {
      let answer = try await receive()

      guard (answer["id"] as? String) == id else {
        continue
      }

      if answer["error"] != nil {
        throw ShareDeliveryError.rejected(method)
      }

      return (answer["result"] as? [String: Any]) ?? [:]
    }
  }

  private func receive() async throws -> [String: Any] {
    let data: Data

    switch try await task.receive() {
    case let .data(bytes):
      data = bytes
    case let .string(text):
      data = Data(text.utf8)
    @unknown default:
      throw ShareDeliveryError.protocolBreak
    }

    return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
  }
}
