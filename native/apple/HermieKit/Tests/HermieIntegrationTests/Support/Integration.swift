#if os(macOS)
import Foundation
import Testing

/// Every black-box suite hangs off this one, so they share its traits: they run
/// only when asked for, one at a time, and none of them can hang a run.
///
/// Serialized because each test owns a child process, and the process
/// accounting in `FakeGatewayHarnessTests` counts this test process's `node`
/// children: nothing else in the target may start or stop one meanwhile.
/// Starting a fake gateway takes a fraction of a second, so running them in
/// a row costs little.
@Suite(
  .serialized,
  .enabled(
    if: IntegrationEnvironment.isEnabled,
    "Set HERMIE_INTEGRATION=1 to run the fake-gateway tests (native/apple/scripts/test.sh --integration)."
  ),
  .timeLimit(.minutes(1))
)
enum Integration {}

enum IntegrationEnvironment {
  /// `HERMIE_INTEGRATION=1`, which `native/apple/scripts/test.sh` sets when
  /// Node and the installed workspace are there (and always in CI).
  static var isEnabled: Bool {
    ProcessInfo.processInfo.environment["HERMIE_INTEGRATION"] == "1"
  }
}
#endif
