#if os(macOS)
import Darwin
import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

extension Integration {
  /// The harness itself: a gateway is a child of this process while it runs
  /// and gone after, however its test ended.
  @Suite("Fake gateway harness")
  struct FakeGatewayHarnessTests {
    @Test("a started gateway is one node child of this process, and stopping it leaves none")
    func childAccounting() async throws {
      let before = ChildProcesses.nodeChildren()
      let gateway = try await FakeGateway.start()

      let during = ChildProcesses.nodeChildren()
      #expect(during == before.union([gateway.pid]), "node children while running: \(during), before: \(before)")
      #expect(ChildProcesses.executableName(of: gateway.pid) == "node")
      #expect(gateway.baseURL == "http://127.0.0.1:\(gateway.port)")
      #expect(gateway.port > 0)

      let status = try await FakeGateway.plainRequest("GET", gateway.baseURL + RESTPath.status)
      #expect(status.status == 200)

      await gateway.stop()

      #expect(gateway.hasExited)
      #expect(!ChildProcesses.exists(gateway.pid))
      #expect(ChildProcesses.nodeChildren() == before)
    }

    @Test("a test body that throws still stops its gateway")
    func stopsOnThrow() async throws {
      let before = ChildProcesses.nodeChildren()
      let seen = Mutex<pid_t>(0)

      await #expect(throws: Planned.self) {
        try await FakeGateway.with { gateway in
          seen.withLock { $0 = gateway.pid }
          throw Planned()
        }
      }

      let pid = seen.withLock { $0 }
      #expect(pid > 0)
      #expect(!ChildProcesses.exists(pid))
      #expect(ChildProcesses.nodeChildren() == before)
    }

    @Test("a cancelled test stops its gateway")
    func stopsOnCancel() async throws {
      let before = ChildProcesses.nodeChildren()
      let (started, startedContinuation) = AsyncStream.makeStream(of: pid_t.self)

      let task = Task {
        try await FakeGateway.with { gateway in
          startedContinuation.yield(gateway.pid)
          // Parked until cancelled (iterating a stream nobody writes to ends
          // on cancellation); the cancellation is what this test is about.
          let (parked, holder) = AsyncStream.makeStream(of: Never.self)
          for await _ in parked {}
          holder.finish()
          try Task.checkCancellation()
        }
      }

      var iterator = started.makeAsyncIterator()
      let pid = try #require(await iterator.next())
      #expect(ChildProcesses.exists(pid))

      task.cancel()
      let result = await task.result

      #expect(throws: CancellationError.self) { try result.get() }
      #expect(!ChildProcesses.exists(pid))
      #expect(ChildProcesses.nodeChildren() == before)
    }

    @Test("a gateway that exits before it listens is reported with what it printed, and leaves nothing")
    func exitBeforeListening() async throws {
      let before = ChildProcesses.nodeChildren()

      let error = await #expect(throws: FakeGatewayError.self) {
        try await FakeGateway.start(FakeGateway.Options(extraArguments: ["--auth", "bogus"]))
      }

      guard case .exitedBeforeListening(let status, let output)? = error else {
        Issue.record("expected exitedBeforeListening, got \(String(describing: error))")
        return
      }

      #expect(status == 1)
      #expect(output.contains("--auth must be none, token, native or cookie"))
      #expect(ChildProcesses.nodeChildren() == before)
    }

    @Test("if this process dies, the gateway's stdin closes and it exits on its own")
    func orphanGuard() async throws {
      let before = ChildProcesses.nodeChildren()
      let gateway = try await FakeGateway.start()

      let status = await gateway.closeStandardInputAndWaitForExit()

      #expect(status == 0)
      #expect(!ChildProcesses.exists(gateway.pid))
      #expect(ChildProcesses.nodeChildren() == before)
    }

    @Test("the control endpoints inject a turn, raise a request and hold push registrations")
    func controlEndpoints() async throws {
      try await FakeGateway.with { gateway in
        let injected = try await gateway.inject(
          FakeGateway.Injection(user: "Hello from outside the app.", assistant: "Seen it.", author: ("u-9", "Pat"))
        )
        #expect(injected.sessionID.hasPrefix("runtime-"))
        #expect(injected.storedSessionID.hasPrefix("stored-researcher-"))

        // The injected turn is in REST history, read through the client under test.
        let http = try HTTPClient(baseURL: gateway.baseURL, credentials: SessionTokenCredentials(token: ""))
        let page = try #require(try await http.get(RESTPath.sessionMessages(injected.storedSessionID)))
        let contents = (page["messages"]?.arrayValue ?? []).compactMap { $0["content"]?.stringValue }
        #expect(contents.contains("Hello from outside the app."))
        #expect(contents.contains("Seen it."))

        let raised = try await gateway.raiseRequest("clarify", params: ["question": .string("Which one?")])
        #expect(raised == FakeGateway.RaisedRequest(method: "clarify", sessionID: injected.sessionID))

        try await gateway.setPushRegistrations(["device-1": .object(["token": .string("relay-token")])])
        let push = try await gateway.pushSection()
        #expect(push["registrations"]?["device-1"]?["token"]?.stringValue == "relay-token")

        let unknown = await #expect(throws: FakeGatewayError.self) {
          try await gateway.inject(FakeGateway.Injection(profile: "nobody"))
        }
        guard case .control(let path, let status, _)? = unknown else {
          Issue.record("expected a control error, got \(String(describing: unknown))")
          return
        }
        #expect(path == "/__fake/inject")
        #expect(status == 404)
      }
    }
  }
}

private struct Planned: Error {}
#endif
