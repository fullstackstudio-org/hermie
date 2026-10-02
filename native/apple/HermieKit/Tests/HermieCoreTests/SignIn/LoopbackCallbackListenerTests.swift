import Darwin
import Foundation
import HermieGateway
import Synchronization
import Testing

@testable import HermieCore

/// The loopback listener on real sockets. Every test binds a port the system chooses, as the app
/// does, so the tests run in parallel.
@Suite("Loopback callback listener")
struct LoopbackCallbackListenerTests {
  static let code = "code-SECRET-4f1c"
  static let state = "state-expected"

  /// A listener on an ephemeral port that takes callbacks carrying `state`.
  static func listening() async throws -> (LoopbackCallbackListener, UInt16) {
    let listener = LoopbackCallbackListener(port: 0)

    try await listener.start { url in
      URLComponents(string: url)?.queryItems?.first { $0.name == "state" }?.value == state
    }

    return (listener, try #require(await listener.port))
  }

  @Test("the callback is answered with the success page and handed over, once")
  func validCallback() async throws {
    let (listener, port) = try await Self.listening()
    let waiting = Task { try await listener.callback() }

    let response = try await rawHTTP(port: port, browserGET("/callback?code=\(Self.code)&state=\(Self.state)", port: port))
    let url = try await waiting.value

    #expect(response.hasPrefix("HTTP/1.1 200 OK"))
    #expect(response.contains(LoopbackPages.english.success.title))
    #expect(url == "http://127.0.0.1:\(port)/callback?code=\(Self.code)&state=\(Self.state)")

    // The page is self-contained and carries nothing from the request.
    #expect(!response.contains(Self.code))
    #expect(!response.contains(Self.state))
    #expect(!response.lowercased().contains("<script"))
    #expect(!response.contains("src="))
    #expect(!response.contains("href="))
    #expect(response.contains("Cache-Control: no-store"))
    #expect(response.contains("Content-Security-Policy: default-src 'none'"))
  }

  @Test("single use: after the callback nothing is listening any more")
  func singleUse() async throws {
    let (listener, port) = try await Self.listening()

    _ = try await rawHTTP(port: port, browserGET("/callback?code=\(Self.code)&state=\(Self.state)", port: port))
    #expect(try await listener.callback().contains(Self.code))

    // A second request is refused at the socket, or at least never answered with a 200.
    let second = try? await rawHTTP(port: port, browserGET("/callback?code=other&state=\(Self.state)", port: port))
    #expect(second.map { !$0.contains("200 OK") } ?? true)
    #expect(try await listener.callback().contains(Self.code))
  }

  @Test("a request that is not the callback gets a 400 and the listening goes on")
  func wrongPathKeepsListening() async throws {
    let (listener, port) = try await Self.listening()
    let waiting = Task { try await listener.callback() }

    for request in [
      browserGET("/favicon.ico", port: port),
      browserGET("/callbackX?code=\(Self.code)&state=\(Self.state)", port: port),
      browserGET("/?code=\(Self.code)&state=\(Self.state)", port: port),
      "POST /callback?code=\(Self.code)&state=\(Self.state) HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nContent-Length: 0\r\n\r\n",
      // Another origin that resolves here (DNS rebinding) names itself in Host.
      browserGET("/callback?code=\(Self.code)&state=\(Self.state)", port: port, host: "evil.example.test:\(port)"),
      "GET /callback?code=\(Self.code)&state=\(Self.state) HTTP/1.1\r\n\r\n",
      "not http at all\r\n\r\n"
    ] {
      let response = try await rawHTTP(port: port, request)

      #expect(response.hasPrefix("HTTP/1.1 400 Bad Request"), "answered: \(response.prefix(40))")
      #expect(!response.contains(Self.code))
    }

    _ = try await rawHTTP(port: port, browserGET("/callback?code=\(Self.code)&state=\(Self.state)", port: port))
    #expect(try await waiting.value.contains(Self.code))
  }

  @Test("a callback with the wrong state gets a 400 and the listening goes on")
  func wrongStateKeepsListening() async throws {
    let (listener, port) = try await Self.listening()
    let waiting = Task { try await listener.callback() }

    let wrong = try await rawHTTP(port: port, browserGET("/callback?code=stolen&state=someone-else", port: port))

    #expect(wrong.hasPrefix("HTTP/1.1 400"))
    #expect(wrong.contains(LoopbackPages.english.rejected.title))
    #expect(!wrong.contains("stolen"))

    _ = try await rawHTTP(port: port, browserGET("/callback?code=\(Self.code)&state=\(Self.state)", port: port))
    #expect(try await waiting.value.contains(Self.code))
  }

  @Test("a request head over 8 KiB is refused")
  func oversizedHead() async throws {
    let (listener, port) = try await Self.listening()
    let padding = String(repeating: "a", count: 9_000)
    let response = try await rawHTTP(
      port: port,
      "GET /callback?code=\(Self.code)&state=\(Self.state) HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nX-Pad: \(padding)\r\n\r\n"
    )

    #expect(!response.contains("200 OK"))
    await listener.stop()
  }

  @Test("a port another process holds is reported as in use")
  func portBusy() async throws {
    let (socket, port) = try Self.occupyLoopbackPort()
    defer { close(socket) }

    let listener = LoopbackCallbackListener(port: port)

    await #expect(throws: LoopbackListenerError.portInUse(port: port)) {
      try await listener.start { _ in true }
    }
  }

  @Test("a start refused for a busy port is not retried, and stopping afterwards returns")
  func portBusyThenStop() async throws {
    let (socket, port) = try Self.occupyLoopbackPort()
    defer { close(socket) }

    // Repeated: the failure used to start a rebind that raced stop() and could hold it for ever.
    for _ in 0..<25 {
      let listener = LoopbackCallbackListener(port: port)

      await #expect(throws: LoopbackListenerError.portInUse(port: port)) {
        try await listener.start { _ in true }
      }

      await listener.stop()
      #expect(await listener.port == nil)
    }
  }

  @Test("cancelling the wait stops the listener and frees the port")
  func cancelFreesThePort() async throws {
    let (listener, port) = try await Self.listening()
    let waiting = Task { try await listener.callback() }

    waiting.cancel()

    await #expect(throws: LoopbackListenerError.cancelled) {
      try await waiting.value
    }

    // The same port can be bound again at once: nothing of the old listener holds it.
    let again = LoopbackCallbackListener(port: port)

    try await again.start { _ in true }
    await again.stop()
  }

  @Test("stop() ends a wait, and a stopped listener cannot start again")
  func stopEndsTheWait() async throws {
    let (listener, _) = try await Self.listening()
    let waiting = Task { try await listener.callback() }

    await listener.stop()

    await #expect(throws: LoopbackListenerError.cancelled) {
      try await waiting.value
    }

    await #expect(throws: LoopbackListenerError.cancelled) {
      try await listener.start { _ in true }
    }
  }

  @Test("resume() changes nothing while the listener is listening")
  func resumeWhileListening() async throws {
    let (listener, port) = try await Self.listening()

    await listener.resume()

    #expect(await listener.port == port)
    let response = try await rawHTTP(port: port, browserGET("/callback?code=\(Self.code)&state=\(Self.state)", port: port))
    #expect(response.hasPrefix("HTTP/1.1 200"))
  }

  @Test("nothing about a request appears in an error's description")
  func errorsSayNothing() {
    for error in [LoopbackListenerError.portInUse(port: 38007), .unavailable, .cancelled, .alreadyWaiting] {
      #expect(!error.description.contains("code="))
      #expect(!error.description.contains("state="))
    }
  }

  @Test("the pages escape what they are given")
  func pagesEscape() {
    let page = LoopbackPage(title: "<script>x</script>", message: "a & \"b\"", language: "en\"><x")

    #expect(!page.html.contains("<script>"))
    #expect(page.html.contains("&lt;script&gt;"))
    #expect(page.html.contains("a &amp; &quot;b&quot;"))
  }

  @Test("the request line and Host are read; anything malformed is refused")
  func parsing() {
    let ok = LoopbackRequest(head: Data("GET /callback?x=1 HTTP/1.1\r\nhost: 127.0.0.1:38007\r\n\r\n".utf8))

    #expect(ok?.method == "GET")
    #expect(ok?.target == "/callback?x=1")
    #expect(ok?.isCallback(port: 38007) == true)
    #expect(ok?.isCallback(port: 38008) == false)
    #expect(LoopbackRequest(head: Data("GET /callback HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n".utf8)) == nil)
    #expect(LoopbackRequest(head: Data("GET /callback\r\n\r\n".utf8)) == nil)
    #expect(LoopbackRequest(head: Data([0xff, 0xfe, 0x0d, 0x0a, 0x0d, 0x0a])) == nil)
  }

  @Test("the system chooses the port, and the redirect URI names it")
  func systemChoosesThePort() async throws {
    let first = LoopbackCallbackListener()
    let second = LoopbackCallbackListener()
    let a = try await first.start { _ in true }
    let b = try await second.start { _ in true }

    #expect(a != 0)
    #expect(b != 0)
    #expect(a != b)
    #expect(LoopbackCallbackListener.redirectURI(port: a) == "http://127.0.0.1:\(a)/callback")
    await first.stop()
    await second.stop()
  }

  @Test("the socket taken away: listening again on the same port, and the callback still arrives")
  func listensAgain() async throws {
    let (listener, port) = try await Self.listening()
    let waiting = Task { try await listener.callback() }

    await listener.simulateSocketTakenAway()

    #expect(await listener.port == port)
    let response = try await rawHTTP(port: port, browserGET("/callback?code=\(Self.code)&state=\(Self.state)", port: port))
    #expect(response.hasPrefix("HTTP/1.1 200"))
    #expect(try await waiting.value.contains(Self.code))
  }

  @Test("the socket taken away and the port gone meanwhile: the wait ends with the reason, at once")
  func listeningAgainFails() async throws {
    let (listener, port) = try await Self.listening()
    let waiting = Task { try await listener.callback() }
    let held = Mutex<Int32>(-1)

    await listener.simulateSocketTakenAway {
      held.withLock { $0 = (try? Self.occupyLoopbackPort(port))?.0 ?? -1 }
    }

    defer { held.withLock { if $0 >= 0 { close($0) } } }

    #expect(held.withLock { $0 } >= 0)
    await #expect(throws: LoopbackListenerError.portInUse(port: port)) {
      try await waiting.value
    }

    // And a wait that starts afterwards hears the same.
    await #expect(throws: LoopbackListenerError.portInUse(port: port)) {
      try await listener.callback()
    }
  }

  @Test("resume() after the attempt ended does nothing")
  func resumeAfterStop() async throws {
    let (listener, _) = try await Self.listening()

    await listener.stop()
    await listener.resume()

    await #expect(throws: LoopbackListenerError.cancelled) {
      try await listener.callback()
    }
  }

  /// Bind and listen on 127.0.0.1 with `port`, or one the system picks, as another app would.
  static func occupyLoopbackPort(_ port: UInt16 = 0) throws -> (Int32, UInt16) {
    let descriptor = socket(AF_INET, SOCK_STREAM, 0)

    try #require(descriptor >= 0)

    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")

    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }

    try #require(bound == 0)
    try #require(listen(descriptor, 4) == 0)

    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) }
    }

    return (descriptor, UInt16(bigEndian: address.sin_port))
  }
}
