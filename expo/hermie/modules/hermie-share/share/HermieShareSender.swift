import Foundation

/**
 Sending a share from inside the share sheet, without the app.

 This is the whole of what ADR-0026 added, and the shape of it is dictated by one
 fact about the gateway rather than by anything preferred here: **there is no REST
 route that submits a prompt.** `/api/files/upload-stream` is HTTP,
 `/api/auth/ws-ticket` is HTTP, and `prompt.submit` is JSON-RPC over the
 WebSocket at `/api/ws`. So "deliver over the HTTP API" is only half available,
 and the ladder below is split accordingly:

  - **HTTP, on a background `URLSession` whose `sharedContainerIdentifier` is the
    App Group.** The ticket mint and every file upload. These genuinely survive
    this process being torn down: the system owns the transfer once it has
    started, which is the entire reason the shared container has to be named —
    without it a background session in an extension is refused at creation.
  - **A WebSocket on an ordinary session.** The resume and the submit.
    `URLSessionWebSocketTask` cannot be created on a background configuration, so
    this leg lives exactly as long as the sheet does. That is why the sheet stays
    on screen saying "Sending…" instead of dismissing optimistically, and why the
    claim below exists.

 ## The order, and what each step costs if it fails

 1. The entry is ALREADY on disk before any of this runs — `ShareViewController`
    writes it first, unconditionally. Nothing here can lose a share.
 2. Credential, target and gateway check. Any miss queues, and the sheet says so.
 3. A ticket, for a gated gateway.
 4. `session.resume` on the session id the app wrote down. Its answer carries the
    runtime id every later frame is addressed by, and the working directory the
    uploads have to land under.
 5. Every file, uploaded, and turned into an `@file:` token.
 6. **The claim.** Written immediately before the submit, so that a teardown in
    the window between the gateway accepting the message and this process
    unlinking the entry leaves something the app can ask about rather than
    something it silently re-sends.
 7. `prompt.submit`.
 8. The entry is removed, claim and all.

 Everything before step 6 fails towards "leave it exactly as it was". Step 6 and 7
 fail towards "ask the person", which is the only honest answer when the question
 is whether a message that was handed over arrived.

 ## What is deliberately not attempted

 **Images.** The app sends a shared image as bytes over the socket
 (`image.attach_bytes`), resized first, because that is what puts it in the
 transcript rather than on the gateway's disk. Resizing a photograph is exactly
 the work a share extension is killed for, and an image uploaded as a file and
 referenced with `@file:` is a binary the agent cannot read. So an entry carrying
 an image is queued for the app, which has the memory budget and the right road.

 **Refreshing anything.** An expired access token ends the attempt. See
 `HermieShareCredentials` for why an extension that could refresh would be an
 extension that can sign the app out.
 */
enum HermieShareSender {
  /** What happened, in the two shapes the sheet can draw. */
  enum Outcome {
    case sent
    /**
     Left on disk for the app.

     `reason` is never shown to anybody: the sheet has one line and the reader
     does not care which of nine things went wrong, only that it will go later.
     It is here because a value with no name reads as an empty case, and because
     the two places that will want it — a developer screen, a future log — should
     not have to reintroduce it.
     */
    case queued(reason: String)
  }

  /** One file to move, as the sheet already has it staged. */
  struct Attachment {
    let url: URL
    let name: String
    let mimeType: String
  }

  /**
   The whole ladder, or the first reason it stopped.

   Never throws: every failure is a `queued`, because every failure means the same
   thing to the person holding the phone and the entry is already safe on disk.

   `entry` is the outbox entry's id, which is what the claim and the removal are
   addressed by. `text` is the message as `shareMessageText` would build it — the
   note, then the URLs and shared text, one paragraph each — and the `@file:`
   tokens are appended here, because only this knows where the files landed.
   */
  static func deliver(
    entry: String,
    bot: String,
    text: String,
    attachments: [Attachment]
  ) async -> Outcome {
    guard let credential = HermieShareKeychain.deliveryCredential() else {
      return .queued(reason: "no credential in the keychain")
    }

    if credential.isExpired {
      return .queued(reason: "the stored credential has expired")
    }

    let targets = HermieShareTargets.load()

    guard let session = targets.session(for: bot) else {
      return .queued(reason: "no session recorded for this bot")
    }

    // A gateway the app has switched away from since it last wrote the targets.
    // The session id would name something this gateway has never heard of.
    if let key = targets.gatewayKey, !key.isEmpty, !credential.gatewayKey.isEmpty, key != credential.gatewayKey {
      return .queued(reason: "the targets belong to another gateway")
    }

    let http = HermieShareBackgroundHTTP(credential: credential)

    defer { http.finish() }

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

    let socket = HermieShareSocket(url: socketURL, credential: credential, ticket: ticket)

    defer { socket.close() }

    do {
      try await socket.open()

      let resume = try await socket.request(
        "session.resume",
        params: [
          "session_id": session,
          "profile": bot,
          // Nothing here draws a transcript, and a resume that replayed one would
          // spend the extension's whole budget decoding messages to discard.
          "omit_messages": true,
          // The same source string the app sends, so a gateway log can tell where
          // a turn came from. It is the app's name and not this target's: from the
          // gateway's side this IS the app.
          "source": "hermie"
        ]
      )

      guard let runtime = resume["session_id"] as? String, !runtime.isEmpty else {
        return .queued(reason: "the gateway resumed without a session id")
      }

      var body = text
      let info = resume["info"] as? [String: Any]
      let cwd = (info?["cwd"] as? String) ?? ""

      if !attachments.isEmpty {
        guard !cwd.isEmpty else {
          // The same refusal `file-upload.ts` makes, for the same reason: a file
          // has to be uploaded to an absolute path UNDER the session's working
          // directory or either the upload or the reference is refused, and a
          // plausible-looking wrong directory produces an upload that succeeds
          // and a reference the agent will not read.
          return .queued(reason: "the session reported no working directory")
        }

        var references: [String] = []

        for attachment in attachments {
          let path = uploadPath(cwd: cwd, name: attachment.name)

          do {
            let stored = try await http.upload(attachment, to: path)

            references.append(fileReference(stored))
          } catch {
            return .queued(reason: "an attachment could not be uploaded")
          }
        }

        body = ([body] + references).filter { !$0.isEmpty }.joined(separator: "\n\n")
      }

      guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return .queued(reason: "there was nothing to send")
      }

      // LAST thing before the submit, and the whole reason this file can be
      // interrupted safely. See the module comment.
      HermieShareOutbox.claim(entry: entry, bot: bot)

      _ = try await socket.request("prompt.submit", params: ["session_id": runtime, "profile": bot, "text": body])
    } catch {
      // The claim, if one was written, stays. An entry claimed by an attempt that
      // failed BEFORE the submit is indistinguishable from one claimed by an
      // attempt that failed after it — from here. The app asks, which is the
      // correct answer to a question this process cannot answer.
      return .queued(reason: "the gateway did not accept the message")
    }

    HermieShareOutbox.remove(entry: entry)

    return .sent
  }

  /**
   `<cwd>/uploads/hermie/<yyyy-mm-dd>/<token>-<name>`.

   The same path `uploadPathFor` builds on the app side, spelled again here for
   the reason every other duplicated rule in this module is: the two targets share
   no sources. What they share is the shape, and the shape is what the gateway
   checks — under the session's cwd so the upload resolves and the `@file:`
   reference stays inside the allowed workspace.
   */
  private static func uploadPath(cwd: String, name: String) -> String {
    var root = cwd

    while root.hasSuffix("/") {
      root.removeLast()
    }

    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.locale = Locale(identifier: "en_US_POSIX")

    let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    let token = String((0..<8).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })

    return "\(root)/uploads/hermie/\(formatter.string(from: Date()))/\(token)-\(HermieShareOutbox.safeFileName(name))"
  }

  /**
   The token the gateway expands into the file's contents.

   Backticks when the path contains whitespace, because a bare `@file:` token ends
   at the space — the same pair `agent/context_references.py` strips back off, and
   the same rule `fileReferenceFor` applies on the app side.
   */
  private static func fileReference(_ path: String) -> String {
    path.rangeOfCharacter(from: .whitespaces) == nil ? "@file:\(path)" : "@file:`\(path)`"
  }
}

/**
 The HTTP half: a background `URLSession` that outlives this process.

 Delegate-based rather than using the `async` conveniences, and that is not a
 style choice — a background session refuses completion-handler tasks outright,
 and its `async` methods are built on them. So every task's outcome arrives
 through the delegate and is handed to a continuation.

 One session per delivery attempt, with a fresh identifier. Two live session
 objects sharing an identifier is a documented crash, and an identifier reused
 across attempts would inherit whatever the previous one left behind.
 */
private final class HermieShareBackgroundHTTP: NSObject, URLSessionDataDelegate {
  private let credential: HermieShareCredential
  /*
    Assigned after `super.init`, because the delegate is `self` and a URLSession's
    delegate is read-only once it exists. This is the documented shape of
    "NSObject subclass that is its own session delegate" and the reason the
    property cannot be a `let`.
  */
  private var session: URLSession!
  private let staging: URL

  /** What each task has received so far, and who is waiting for it. */
  private var received: [Int: Data] = [:]
  private var waiting: [Int: CheckedContinuation<(Int, Data), Error>] = [:]
  private let lock = NSLock()

  init(credential: HermieShareCredential) {
    self.credential = credential

    let configuration = URLSessionConfiguration.background(
      withIdentifier: "dev.hermie.app.share.\(UUID().uuidString)"
    )
    /*
      The line this whole class exists for.

      A background session created inside an app extension MUST name a container
      the extension and its containing app both have, or the session is refused —
      the system needs somewhere to keep the transfer's state once this process is
      gone. It is the same App Group the outbox lives in, which is why it is read
      off `HermieShareOutbox` rather than spelled a fifth time.
    */
    configuration.sharedContainerIdentifier = HermieShareOutbox.appGroup
    // Not discretionary: somebody is watching a sheet. Discretionary transfers
    // are scheduled when the system feels like it, which for a share is never.
    configuration.isDiscretionary = false
    /*
      And the app is NOT relaunched for the result.

      An extension's background session would otherwise wake the containing app
      to deliver its completion events, and the app has nothing to do with them:
      the entry is still in the outbox, and the app's own delivery flow finds it
      at the next real launch. Waking a chat client in the background to hear that
      a POST finished would be a cost with no reader.
    */
    configuration.sessionSendsLaunchEvents = false
    configuration.timeoutIntervalForResource = 120

    staging = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)

    super.init()

    session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }

  /** Let the session finish whatever it started, and take the staging copies away. */
  func finish() {
    // NOT `invalidateAndCancel`: a transfer that is already moving is the one
    // thing this class was built to keep, and cancelling it here would throw away
    // the upload the system had agreed to finish.
    session.finishTasksAndInvalidate()
    try? FileManager.default.removeItem(at: staging)
  }

  /** `POST /api/auth/ws-ticket` — single use, 30 s, one per dial. */
  func mintWebSocketTicket() async throws -> String {
    guard let url = credential.apiURL("/api/auth/ws-ticket") else {
      throw HermieShareSenderError.badAddress
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")

    for (name, value) in credential.requestHeaders() {
      request.setValue(value, forHTTPHeaderField: name)
    }

    // An empty JSON object, from a file: a background session cannot take a body
    // in memory. The app posts `{}` here too.
    let body = try stage(name: "ticket.json", data: Data("{}".utf8))
    let (status, data) = try await run(request, bodyFile: body)

    guard status == 200,
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let ticket = root["ticket"] as? String, !ticket.isEmpty else {
      throw HermieShareSenderError.refused(status)
    }

    return ticket
  }

  /**
   One file, to one absolute path on the gateway, and the path it actually landed
   on.

   `display_path` may differ from what was asked for — a symlinked home is the
   ordinary case — and the reference has to name what the gateway will resolve, so
   its answer wins over the request. The same rule the app's uploader states.
   */
  func upload(_ attachment: HermieShareSender.Attachment, to path: String) async throws -> String {
    guard let url = credential.apiURL("/api/files/upload-stream") else {
      throw HermieShareSenderError.badAddress
    }

    let boundary = "hermie-\(UUID().uuidString)"
    let body = try stageMultipart(attachment, path: path, boundary: boundary)

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")

    for (name, value) in credential.requestHeaders() {
      request.setValue(value, forHTTPHeaderField: name)
    }

    let (status, data) = try await run(request, bodyFile: body)

    guard status >= 200, status < 300 else {
      throw HermieShareSenderError.refused(status)
    }

    let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]

    guard let stored = root?["path"] as? String, !stored.isEmpty else {
      return path
    }

    return stored
  }

  // MARK: - the delegate, and the continuation it answers

  private func run(_ request: URLRequest, bodyFile: URL) async throws -> (Int, Data) {
    let task = session.uploadTask(with: request, fromFile: bodyFile)

    return try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      waiting[task.taskIdentifier] = continuation
      lock.unlock()
      task.resume()
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    received[dataTask.taskIdentifier, default: Data()].append(data)
    lock.unlock()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    let continuation = waiting.removeValue(forKey: task.taskIdentifier)
    let data = received.removeValue(forKey: task.taskIdentifier) ?? Data()
    lock.unlock()

    guard let continuation else {
      return
    }

    if let error {
      continuation.resume(throwing: error)

      return
    }

    continuation.resume(returning: ((task.response as? HTTPURLResponse)?.statusCode ?? 0, data))
  }

  // MARK: - staging

  /**
   Every body a background session sends has to be a FILE, including a two-byte
   one.

   Written into a directory of this attempt's own, which `finish()` removes. The
   system's temporary directory would sweep it eventually either way, but a share
   of nine attachments is nine multipart copies and leaving them to the sweeper is
   leaving somebody's photographs in two places instead of one.
   */
  private func stage(name: String, data: Data) throws -> URL {
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)

    let destination = staging.appendingPathComponent(name)

    try data.write(to: destination, options: .atomic)

    return destination
  }

  /**
   The three form fields `upload_managed_file_stream` declares, assembled by hand.

   `FormData` does not exist here and the file's bytes must not be read into
   memory — a share extension is killed for memory before it is killed for
   anything else, and an attachment can be a video. So the envelope is written
   first, the file is appended in chunks, and the closing boundary follows it.
   */
  private func stageMultipart(
    _ attachment: HermieShareSender.Attachment,
    path: String,
    boundary: String
  ) throws -> URL {
    let destination = try stage(name: "\(UUID().uuidString).multipart", data: Data())

    guard let handle = FileHandle(forWritingAtPath: destination.path) else {
      throw HermieShareSenderError.staging
    }

    defer { try? handle.close() }

    func write(_ text: String) throws {
      try handle.write(contentsOf: Data(text.utf8))
    }

    try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n\(path)\r\n")
    try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n")
    try write(
      "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(attachment.name)\"\r\n"
        + "Content-Type: \(attachment.mimeType)\r\n\r\n"
    )

    guard let source = try? FileHandle(forReadingFrom: attachment.url) else {
      throw HermieShareSenderError.staging
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
 The WebSocket half: open, wait to be told the gateway is ready, ask two things.

 Deliberately sequential. The app's channel keeps a map of pending requests
 because it has dozens in flight; this makes one call at a time and therefore
 reads frames until it sees the id it is waiting for, discarding everything else.
 Events and server requests ARE discarded — a permission prompt arriving here has
 nobody to answer it, and `prompt.submit` answers as soon as the turn is accepted
 rather than when it finishes, so nothing is waiting on one.
 */
private final class HermieShareSocket: @unchecked Sendable {
  private let task: URLSessionWebSocketTask
  private let session: URLSession
  private var nextId = 1

  init(url: URL, credential: HermieShareCredential, ticket: String?) {
    var request = URLRequest(url: url)

    for (name, value) in credential.requestHeaders() {
      request.setValue(value, forHTTPHeaderField: name)
    }

    /*
      The credential-bearing subprotocol, for a gated gateway.

      A browser cannot set headers on an upgrade, so the gateway made a
      single-use ticket in the subprotocol list the only WS credential it accepts
      when gated. `Sec-WebSocket-Protocol` is set on the request rather than
      passed to `webSocketTask(with:protocols:)` because that overload takes no
      headers, and the front door's pair has to be on this request too.
    */
    if let ticket {
      request.setValue(
        "hermes-gateway-v1, hermes-gateway-ticket.\(ticket)",
        forHTTPHeaderField: "Sec-WebSocket-Protocol"
      )
    }

    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 20
    // NOT a background configuration: `webSocketTask` cannot be created on one.
    // This leg lives exactly as long as the sheet, which is what the claim in
    // `HermieShareSender` exists to make safe.
    session = URLSession(configuration: configuration)
    task = session.webSocketTask(with: request)
  }

  func close() {
    task.cancel(with: .normalClosure, reason: nil)
    session.invalidateAndCancel()
  }

  /**
   A deadline, expressed as a cancellation of the socket.

   A share sheet cannot sit waiting: the person is standing in another application
   with their thumb over a button, and an entry queued after four seconds beats a
   spinner that never resolves. `URLSession`'s own timeouts cover the handshake
   and nothing after it — "the socket is open and the gateway has gone quiet" is
   exactly what a gated gateway looks like when it is about to refuse, and it
   would otherwise hang in `receive()` for ever.

   Cancelling the task rather than racing the value is deliberate: a task group's
   child results have to be `Sendable`, and what these calls carry is a JSON
   dictionary that is not. A cancelled socket makes the pending `receive()` throw,
   which is the same answer one step further down.
   */
  private func watchdog(seconds: UInt64) -> Task<Void, Never> {
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)

      guard !Task.isCancelled else {
        return
      }

      self?.task.cancel(with: .goingAway, reason: nil)
    }
  }

  /**
   Open, and wait for `gateway.ready`.

   A gated gateway ACCEPTS the upgrade and then closes with 4401 or 4403, so an
   open socket proves nothing — the readiness event is the first thing that does.
   Waiting for it here is what turns a rejected ticket into a queued share rather
   than into a request that sits until the deadline.
   */
  func open() async throws {
    task.resume()

    let deadline = watchdog(seconds: 15)

    defer { deadline.cancel() }

    while true {
      let frame = try await receive()

      if (frame["method"] as? String) == "event",
        let params = frame["params"] as? [String: Any],
        (params["type"] as? String) == "gateway.ready" {
        return
      }
    }
  }

  /** One JSON-RPC call, and its result. A gateway error is thrown, not returned. */
  func request(_ method: String, params: [String: Any]) async throws -> [String: Any] {
    let id = "share-\(nextId)"
    nextId += 1

    let frame: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method, "params": params]
    let data = try JSONSerialization.data(withJSONObject: frame)

    try await task.send(.data(data))

    let deadline = watchdog(seconds: 30)

    defer { deadline.cancel() }

    while true {
      let answer = try await receive()

      guard (answer["id"] as? String) == id else {
        continue
      }

      if answer["error"] != nil {
        throw HermieShareSenderError.rejected(method)
      }

      return (answer["result"] as? [String: Any]) ?? [:]
    }
  }

  private func receive() async throws -> [String: Any] {
    let message = try await task.receive()
    let data: Data

    switch message {
    case let .data(bytes):
      data = bytes

    case let .string(text):
      data = Data(text.utf8)

    @unknown default:
      throw HermieShareSenderError.protocolBreak
    }

    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }
}

/**
 Why an attempt stopped, for the one caller that turns every one of them into the
 same sentence.

 Named cases rather than a message, because the sheet says one thing and a
 developer screen will one day want to say which: a gateway that refused is a
 different story from a keychain with nothing in it, even though the person
 holding the phone is told the same thing by both.
 */
private enum HermieShareSenderError: Error {
  case badAddress
  case staging
  case refused(Int)
  case rejected(String)
  case protocolBreak
}
