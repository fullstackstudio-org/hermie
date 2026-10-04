import HermieCore
import SwiftUI

/// Self-enrolment's part of a main window: when the app comes to the front, a sign-in again that is
/// waiting for its callback listens again (iOS may have reclaimed the suspended app's socket while
/// the person was in another app for a one-time code). Nothing happens when nothing is listening.
struct PasskeyReauthLifecycle: ViewModifier {
  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(\.scenePhase) private var scenePhase

  func body(content: Content) -> some View {
    content
      .onChange(of: scenePhase) { _, phase in
        if phase == .active, let passkeys = live?.session?.passkeys {
          Task { await passkeys.appBecameActive() }
        }
      }
  }
}

extension View {
  /// See `PasskeyReauthLifecycle`.
  func passkeyReauthLifecycle() -> some View {
    modifier(PasskeyReauthLifecycle())
  }
}
