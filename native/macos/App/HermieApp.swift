import HermieUI
import SwiftUI

/// The Mac app: SwiftUI on AppKit, not an iPad build. Everything it shows
/// lives in HermieKit; this file only declares the scenes.
@main
struct HermieApp: App {
  var body: some Scene {
    WindowGroup {
      PlaceholderView()
        .frame(minWidth: 480, minHeight: 360)
    }
    .defaultSize(width: 900, height: 640)
  }
}
