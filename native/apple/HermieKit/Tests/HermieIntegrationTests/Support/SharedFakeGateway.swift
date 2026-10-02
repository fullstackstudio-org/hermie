#if os(macOS)
import Testing

/// One fake gateway for a whole suite, for suites whose tests only read.
///
/// ```swift
/// @Suite(.fakeGateway(.init(auth: .token, token: "secret")))
/// struct Reads {
///   @Test func me() async throws { let gateway = try FakeGateway.shared … }
/// }
/// ```
///
/// Started before the suite's first test and stopped after its last, also when
/// a test fails or the run is cancelled. A test that changes the gateway's
/// state (signs in, rotates, revokes, injects) takes a fresh one with
/// `FakeGateway.with(_:_:)` instead.
struct SharedFakeGateway: SuiteTrait, TestScoping {
  var options: FakeGateway.Options

  /// Once for the suite, not once per test.
  var isRecursive: Bool { false }

  func provideScope(
    for test: Test,
    testCase: Test.Case?,
    performing function: @Sendable () async throws -> Void
  ) async throws {
    try await FakeGateway.with(options) { gateway in
      try await FakeGateway.$suiteGateway.withValue(gateway) {
        try await function()
      }
    }
  }
}

extension Trait where Self == SharedFakeGateway {
  /// Run the suite against one fake gateway started with `options`.
  static func fakeGateway(_ options: FakeGateway.Options = FakeGateway.Options()) -> Self {
    SharedFakeGateway(options: options)
  }
}

extension FakeGateway {
  @TaskLocal static var suiteGateway: FakeGateway?

  /// The suite's gateway (`.fakeGateway(_:)`).
  static var shared: FakeGateway {
    get throws {
      guard let suiteGateway else {
        throw SharedFakeGatewayMissing()
      }

      return suiteGateway
    }
  }
}

struct SharedFakeGatewayMissing: Error, CustomStringConvertible {
  var description: String { "This suite has no .fakeGateway(_:) trait." }
}
#endif
