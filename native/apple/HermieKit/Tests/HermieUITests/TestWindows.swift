#if os(macOS)
import AppKit

extension NSWindow {
  /// Put a test window on screen without showing it: some tests need a window that is on screen, so SwiftUI keeps
  /// updating it, but a run of the suite must never cover what the person is doing on this Mac. A transparent window
  /// that ignores the mouse, ordered in without activating the test process, is on screen and invisible.
  /// `HERMIE_SHOW_TEST_WINDOWS=1` shows them, for looking at a failure.
  @MainActor
  func orderInForTest() {
    if ProcessInfo.processInfo.environment["HERMIE_SHOW_TEST_WINDOWS"] != "1" {
      alphaValue = 0
      ignoresMouseEvents = true
      hasShadow = false
    }
    orderFrontRegardless()
  }
}
#endif
