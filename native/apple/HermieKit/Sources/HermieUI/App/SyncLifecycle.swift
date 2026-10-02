import HermieCore
import SwiftUI

/// Sync's part of a main window: a reconcile whenever the app comes to the front (I11; the engine
/// runs at most one per 30 seconds for this). The launch's own reconcile starts in `AppLaunch.start()`.
struct SyncLifecycle: ViewModifier {
  let launch: AppLaunch

  @Environment(\.scenePhase) private var scenePhase

  func body(content: Content) -> some View {
    content
      .onChange(of: scenePhase) { _, phase in
        if phase == .active {
          Task { await launch.becameActive() }
        }
      }
  }
}

extension View {
  /// See `SyncLifecycle`.
  func syncLifecycle(launch: AppLaunch) -> some View {
    modifier(SyncLifecycle(launch: launch))
  }
}
