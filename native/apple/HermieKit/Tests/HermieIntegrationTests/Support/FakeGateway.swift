#if os(macOS)
import Darwin
import Foundation
import Synchronization

/// `packages/fake-gateway` running as a real server in a child process, started
/// through its CLI exactly as a developer starts it by hand.
///
/// - **The port is the kernel's.** The CLI is started with `--port 0` and the
///   bound address is read back from its listening line, so two gateways can
///   never race for one port.
/// - **Nothing waits on a timer.** A start waits for the listening line (or the
///   child's exit) with a deadline; a stop waits for the exit itself.
/// - **The child never outlives its test.** `with(_:_:)` stops it whatever the
///   body did: returned, threw, or was cancelled. Stopping is SIGTERM to the
///   child's own PID, then SIGKILL to the same PID if it has not exited within
///   the grace period. And should this test process die without running any of
///   that, the child's stdin (a pipe only this process holds open) reaches end
///   of file, and a watchdog loaded before the CLI exits on it.
/// - **Everything it printed is kept**, stdout and stderr, for failure messages.
final class FakeGateway: Sendable, CustomStringConvertible {
  enum Auth: String, Sendable {
    case none, token, native, cookie
  }

  /// The CLI's flags. Unset means the CLI's own default.
  struct Options: Sendable, Hashable {
    var auth: Auth = .none
    /// `--token`, for `--auth token`.
    var token: String?
    /// `--no-plugin` when false: no `hermie-plugin` advert and no plugin routes.
    var plugin = true
    /// `--no-native-revoke` when false: no `native_revoke` flow and no revoke route.
    var nativeRevoke = true
    var closeCode: Int?
    var publicHost: String?
    var streamDelayMs: Int?
    /// Anything else, passed as given after the flags above.
    var extraArguments: [String] = []

    init(
      auth: Auth = .none,
      token: String? = nil,
      plugin: Bool = true,
      nativeRevoke: Bool = true,
      closeCode: Int? = nil,
      publicHost: String? = nil,
      streamDelayMs: Int? = nil,
      extraArguments: [String] = []
    ) {
      self.auth = auth
      self.token = token
      self.plugin = plugin
      self.nativeRevoke = nativeRevoke
      self.closeCode = closeCode
      self.publicHost = publicHost
      self.streamDelayMs = streamDelayMs
      self.extraArguments = extraArguments
    }

    var arguments: [String] {
      var arguments = ["--auth", auth.rawValue]
      if let token { arguments += ["--token", token] }
      if !plugin { arguments.append("--no-plugin") }
      if !nativeRevoke { arguments.append("--no-native-revoke") }
      if let closeCode { arguments += ["--close-code", String(closeCode)] }
      if let publicHost { arguments += ["--public-host", publicHost] }
      if let streamDelayMs { arguments += ["--stream-delay", String(streamDelayMs)] }
      return arguments + extraArguments
    }
  }

  let options: Options
  /// `http://127.0.0.1:<port>`, as the CLI printed it.
  let baseURL: String
  let port: Int
  /// The child's PID: the only process this harness ever signals.
  let pid: pid_t
  /// How long `start` waits for the listening line by default.
  static let startTimeout: Duration = .seconds(20)
  /// How long `stop` waits after SIGTERM before it sends SIGKILL.
  static let stopGrace: Duration = .seconds(5)

  private let child: Child

  /// The WebSocket address of this gateway.
  var wsURL: String { "ws://127.0.0.1:\(port)/api/ws" }

  /// Everything the child printed so far, stdout then stderr.
  var output: String { child.log.text }

  /// The child has exited (stopped, killed or crashed).
  var hasExited: Bool { child.exit.status != nil }

  var description: String { "FakeGateway(\(baseURL), pid \(pid), \(options.arguments.joined(separator: " ")))" }

  private init(options: Options, baseURL: String, port: Int, child: Child) {
    self.options = options
    self.baseURL = baseURL
    self.port = port
    self.pid = child.pid
    self.child = child
  }

  deinit {
    // The last line of defence, for a gateway somebody started and never
    // stopped. `stop()` is the way out; this only makes sure there is one.
    child.killNow()
  }

  // MARK: - Lifecycle

  /// Start a gateway, run `body` with it, and stop it again whatever happens.
  static func with<T>(
    _ options: Options = Options(),
    _ body: (FakeGateway) async throws -> T
  ) async throws -> T {
    let gateway = try await start(options)

    do {
      let result = try await body(gateway)
      await gateway.stop()
      return result
    } catch {
      await gateway.stop()
      gateway.reportOutput(because: error)
      throw error
    }
  }

  /// Start a gateway and wait until it listens. The caller owns `stop()`;
  /// prefer `with(_:_:)`, which cannot forget it.
  static func start(_ options: Options = Options(), timeout: Duration = startTimeout) async throws -> FakeGateway {
    let environment = try FakeGatewayEnvironment.resolve()
    let child = try Child.launch(
      node: environment.node,
      repositoryRoot: environment.repositoryRoot,
      arguments: ["--import", "tsx", "--import", FakeGatewayEnvironment.watchdogModule, environment.cliPath, "--port", "0"]
        + options.arguments
    )

    do {
      let baseURL = try await child.log.waitForListening(timeout: timeout)

      guard let port = URLComponents(string: baseURL)?.port else {
        throw FakeGatewayError.unreadableListeningLine(baseURL, output: child.log.text)
      }

      return FakeGateway(options: options, baseURL: baseURL, port: port, child: child)
    } catch {
      await child.terminate(grace: stopGrace)

      switch error {
      case let error as FakeGatewayError:
        throw error
      case is CancellationError:
        throw error
      default:
        throw FakeGatewayError.notListening(error, output: child.log.text)
      }
    }
  }

  /// SIGTERM, then SIGKILL after `grace`; returns once the child has exited.
  /// Safe to call more than once.
  func stop(grace: Duration = FakeGateway.stopGrace) async {
    await child.terminate(grace: grace)
  }

  /// Close the child's stdin, as the kernel does when this test process dies,
  /// and wait for the watchdog to take the child down. For the harness's own tests.
  func closeStandardInputAndWaitForExit() async -> Int32 {
    child.closeStandardInput()
    return await child.exit.wait()
  }

  /// Print what the child said, so a failing test shows the gateway's side.
  func reportOutput(because error: any Error) {
    let text = output.isEmpty ? "(nothing)" : output
    FileHandle.standardError.write(Data("\(self) stopped after \(error); it printed:\n\(text)\n".utf8))
  }
}

enum FakeGatewayError: Error, CustomStringConvertible {
  case nodeNotFound
  case repositoryNotFound(String)
  case workspaceNotInstalled(String)
  case exitedBeforeListening(status: Int32, output: String)
  case timedOut(Duration, output: String)
  case unreadableListeningLine(String, output: String)
  case notListening(any Error, output: String)
  case control(path: String, status: Int, body: String)

  var description: String {
    switch self {
    case .nodeNotFound:
      "node is not on PATH. Install Node (see .nvmrc) or leave HERMIE_INTEGRATION unset."
    case .repositoryNotFound(let from):
      "No packages/fake-gateway/src/cli.ts above \(from)."
    case .workspaceNotInstalled(let root):
      "\(root)/node_modules/tsx is missing: run npm ci in \(root)."
    case .exitedBeforeListening(let status, let output):
      "The fake gateway exited with status \(status) before it listened. It printed:\n\(output)"
    case .timedOut(let timeout, let output):
      "The fake gateway did not listen within \(timeout). It printed:\n\(output)"
    case .unreadableListeningLine(let line, let output):
      "Could not read a port from \(line). The gateway printed:\n\(output)"
    case .notListening(let error, let output):
      "The fake gateway did not start (\(error)). It printed:\n\(output)"
    case .control(let path, let status, let body):
      "\(path) answered HTTP \(status): \(body)"
    }
  }
}

// MARK: - Where things are

/// Node, the repository and the CLI, found once.
struct FakeGatewayEnvironment: Sendable {
  var node: URL
  var repositoryRoot: URL
  var cliPath: String

  static let cliRelativePath = "packages/fake-gateway/src/cli.ts"

  /// A test run's own tag, so a leak check can find exactly this run's
  /// children (`test.sh` sets `HERMIE_INTEGRATION_RUN` per run).
  static var runTag: String {
    let run = ProcessInfo.processInfo.environment["HERMIE_INTEGRATION_RUN"] ?? "local"
    return "hermie-integration-\(run.filter { $0.isLetter || $0.isNumber || $0 == "-" })"
  }

  /// Loaded before the CLI: exit when stdin ends, which it does when the
  /// process holding its other end (this one) is gone, however it went. The
  /// trailing comment is the run tag, visible to `pgrep -f`.
  static var watchdogModule: String {
    "data:text/javascript,process.stdin.on('end',()=>process.exit(0)).on('error',()=>process.exit(0)).resume();//"
      + runTag
  }

  static func resolve() throws -> FakeGatewayEnvironment {
    let root = try repositoryRoot()

    guard FileManager.default.fileExists(atPath: root.appending(path: "node_modules/tsx/package.json").path) else {
      throw FakeGatewayError.workspaceNotInstalled(root.path)
    }

    return FakeGatewayEnvironment(
      node: try node(),
      repositoryRoot: root,
      cliPath: root.appending(path: cliRelativePath).path
    )
  }

  /// The first executable `node` on PATH.
  static func node() throws -> URL {
    let path = ProcessInfo.processInfo.environment["PATH"] ?? ""

    for directory in path.split(separator: ":") where !directory.isEmpty {
      let candidate = URL(filePath: String(directory)).appending(path: "node")

      if FileManager.default.isExecutableFile(atPath: candidate.path) {
        return candidate
      }
    }

    throw FakeGatewayError.nodeNotFound
  }

  /// The checkout this file lives in: the first directory above it that has the CLI.
  static func repositoryRoot(from file: String = #filePath) throws -> URL {
    var directory = URL(filePath: file).deletingLastPathComponent()

    while directory.path != "/" {
      if FileManager.default.fileExists(atPath: directory.appending(path: cliRelativePath).path) {
        return directory
      }

      directory = directory.deletingLastPathComponent()
    }

    throw FakeGatewayError.repositoryNotFound(file)
  }
}

// MARK: - The child process

/// The `Process`, its pipes, and what came out of them.
private final class Child: Sendable {
  let pid: pid_t
  let log: OutputLog
  let exit: ExitSignal
  /// Our end of the child's stdin. Held open for the child's whole life: its
  /// closing is the watchdog's cue.
  private let stdin: FileHandle
  private let stdinOpen = Mutex(true)
  /// Kept alive with the child.
  private let process: Process

  private init(process: Process, stdin: FileHandle, log: OutputLog, exit: ExitSignal) {
    self.process = process
    self.pid = process.processIdentifier
    self.stdin = stdin
    self.log = log
    self.exit = exit
  }

  static func launch(node: URL, repositoryRoot: URL, arguments: [String]) throws -> Child {
    let process = Process()
    process.executableURL = node
    process.arguments = arguments
    process.currentDirectoryURL = repositoryRoot

    var environment = ProcessInfo.processInfo.environment
    environment["NO_COLOR"] = "1"
    environment["FORCE_COLOR"] = "0"
    process.environment = environment

    let input = Pipe()
    let output = Pipe()
    let errors = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = errors

    let log = OutputLog()
    let exit = ExitSignal()

    for (pipe, stream) in [(output, OutputLog.Stream.stdout), (errors, .stderr)] {
      pipe.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData

        if data.isEmpty {
          handle.readabilityHandler = nil
          log.ended(stream)
        } else {
          log.append(data, stream: stream)
        }
      }
    }

    process.terminationHandler = { finished in
      let status = finished.terminationStatus
      exit.fire(status)
      log.exited(status)
    }

    do {
      try process.run()
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      errors.fileHandleForReading.readabilityHandler = nil
      throw error
    }

    return Child(process: process, stdin: input.fileHandleForWriting, log: log, exit: exit)
  }

  /// SIGTERM, then SIGKILL after `grace`; returns once the child has exited.
  func terminate(grace: Duration) async {
    guard exit.status == nil else {
      closeStandardInput()
      return
    }

    let pid = pid
    let exit = exit
    send(SIGTERM)

    // Not a sleep in a test: an upper bound on a child that ignores SIGTERM.
    let escalation = Task.detached {
      try await Task.sleep(for: grace)

      if exit.status == nil {
        _ = Darwin.kill(pid, SIGKILL)
      }
    }

    _ = await exit.wait()
    escalation.cancel()
    closeStandardInput()
  }

  /// SIGKILL without waiting, for `deinit`.
  func killNow() {
    send(SIGKILL)
  }

  func closeStandardInput() {
    let wasOpen = stdinOpen.withLock { open in
      defer { open = false }
      return open
    }

    if wasOpen {
      try? stdin.close()
    }
  }

  /// Signal the child by its own PID, and only while it has not been reaped
  /// (after that the PID may belong to somebody else).
  private func send(_ signal: Int32) {
    guard exit.status == nil else {
      return
    }

    _ = Darwin.kill(pid, signal)
  }
}

/// The child's exit status, and everybody waiting for it.
final class ExitSignal: Sendable {
  private struct State {
    var status: Int32?
    var waiters: [CheckedContinuation<Int32, Never>] = []
  }

  private let state = Mutex(State())

  var status: Int32? { state.withLock { $0.status } }

  func fire(_ status: Int32) {
    let waiters = state.withLock { state in
      state.status = status
      defer { state.waiters = [] }
      return state.waiters
    }

    for waiter in waiters {
      waiter.resume(returning: status)
    }
  }

  /// Returns once the child has exited. Not cancellable on purpose: a stop
  /// always finishes (SIGKILL guarantees the exit), so teardown cannot be cut short.
  func wait() async -> Int32 {
    await withCheckedContinuation { continuation in
      let status = state.withLock { state -> Int32? in
        if let status = state.status {
          return status
        }

        state.waiters.append(continuation)
        return nil
      }

      if let status {
        continuation.resume(returning: status)
      }
    }
  }
}

/// Everything the child printed, and its lines as they arrive.
final class OutputLog: Sendable {
  enum Stream: Sendable {
    case stdout, stderr
  }

  enum Event: Sendable {
    case line(String)
    case exited(Int32)
  }

  private struct State {
    var stdout = ""
    var stderr = ""
    var partialLine = Data()
    var openStreams = 2
    var status: Int32?
  }

  private let state = Mutex(State())
  private let events: AsyncStream<Event>
  private let continuation: AsyncStream<Event>.Continuation

  init() {
    (events, continuation) = AsyncStream.makeStream(of: Event.self, bufferingPolicy: .bufferingNewest(256))
  }

  var text: String {
    state.withLock { state in
      state.stderr.isEmpty ? state.stdout : "\(state.stdout)--- stderr ---\n\(state.stderr)"
    }
  }

  func append(_ data: Data, stream: Stream) {
    let text = String(decoding: data, as: UTF8.self)

    let lines: [String] = state.withLock { state in
      switch stream {
      case .stderr:
        state.stderr += text
        return []
      case .stdout:
        state.stdout += text
        state.partialLine.append(data)
        var lines: [String] = []

        while let newline = state.partialLine.firstIndex(of: UInt8(ascii: "\n")) {
          lines.append(String(decoding: state.partialLine[..<newline], as: UTF8.self))
          state.partialLine.removeSubrange(...newline)
        }

        return lines
      }
    }

    for line in lines {
      continuation.yield(.line(line))
    }
  }

  /// One of the two pipes reached end of file.
  func ended(_ stream: Stream) {
    finishIfDone { $0.openStreams -= 1 }
  }

  /// The child exited. Reported only once both pipes are drained too, so
  /// whatever it printed on its way out is in `text` by then.
  func exited(_ status: Int32) {
    finishIfDone { $0.status = status }
  }

  private func finishIfDone(_ change: (inout State) -> Void) {
    let status = state.withLock { state -> Int32? in
      change(&state)
      return state.openStreams <= 0 ? state.status : nil
    }

    if let status {
      continuation.yield(.exited(status))
      continuation.finish()
    }
  }

  /// The address in `fake gateway listening on http://127.0.0.1:<port> (auth: …)`.
  static func listeningAddress(in line: String) -> String? {
    let marker = "fake gateway listening on "

    guard let range = line.range(of: marker) else {
      return nil
    }

    let address = line[range.upperBound...].prefix { !$0.isWhitespace }
    return address.isEmpty ? nil : String(address)
  }

  /// Wait for the listening line; fail at once if the child exits first, and
  /// after `timeout` if neither happens. Only one caller may wait.
  func waitForListening(timeout: Duration) async throws -> String {
    let events = events

    return try await withThrowingTaskGroup(of: String?.self) { group in
      group.addTask {
        for await event in events {
          switch event {
          case .line(let line):
            if let address = Self.listeningAddress(in: line) {
              return address
            }
          case .exited(let status):
            throw FakeGatewayError.exitedBeforeListening(status: status, output: self.text)
          }
        }

        try Task.checkCancellation()
        throw FakeGatewayError.exitedBeforeListening(status: -1, output: self.text)
      }

      group.addTask {
        try await Task.sleep(for: timeout)
        return nil
      }

      defer { group.cancelAll() }

      guard let address = try await group.next() ?? nil else {
        throw FakeGatewayError.timedOut(timeout, output: self.text)
      }

      return address
    }
  }
}
#endif
