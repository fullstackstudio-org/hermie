import HermieUI
import SwiftUI

// The host for the transcript UI tests: a debug-only app that shows one of
// HermieUI's debug screens and nothing else, so the tests never touch the real
// app, its keychain group or a gateway. It is not shipped and is not part of
// the `Hermie` scheme; `scripts/test.sh --ui` builds and runs it.
//
// `-HermieLabScreen lab|gallery` picks the screen (default: the menu).

@main
struct HermieLabApp: App {
  var body: some Scene {
    WindowGroup {
      NavigationStack {
        switch UserDefaults.standard.string(forKey: "HermieLabScreen") {
        case "lab": TranscriptLabView()
        case "gallery": TranscriptItemGallery()
        default: TranscriptDebugMenu()
        }
      }
    }
  }
}
