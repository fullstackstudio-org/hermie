#if DEBUG
  import SwiftUI

  /**
   Where debug views (the transcript lab, the item gallery) are linked from, in a debug build only.
   Settings → Advanced lists every entry. A feature registers its own screen at launch, so the shell
   never imports a feature's debug code:

   ```swift
   DebugScreens.register(id: "transcript-lab", title: "Transcript lab") { TranscriptLab() }
   ```
   */
  @MainActor
  public enum DebugScreens {
    public struct Entry: Identifiable {
      public let id: String
      public let title: String
      let make: @MainActor () -> AnyView
    }

    public private(set) static var entries: [Entry] = []

    /// Add a screen, or replace the one with the same id. Listed in registration order.
    public static func register<Screen: View>(
      id: String,
      title: String,
      _ make: @escaping @MainActor () -> Screen
    ) {
      let entry = Entry(id: id, title: title, make: { AnyView(make()) })

      if let index = entries.firstIndex(where: { $0.id == id }) {
        entries[index] = entry
      } else {
        entries.append(entry)
      }
    }

    public static func removeAll() {
      entries = []
    }
  }
#endif
