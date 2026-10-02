import HermieShared
import SwiftUI

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/**
 What the widget and share extensions both draw with: a picture out of the App Group container, and
 the app's colours from the hex the snapshot carries.

 Compiled into both extension targets from this one file. It needs SwiftUI, which `HermieShared`
 (Foundation only) does not link.
 */
enum ContainerImage {
  /**
   One bot's picture, or nil.

   Read every time it is drawn rather than cached: an extension process is short-lived and killed
   for memory before anything else. The path came out of the snapshot; one that would land outside
   the container reads nothing (`SharedContainer.resolve`).
   */
  static func load(_ path: String?) -> Image? {
    guard let container = SharedContainer.url(), let url = SharedContainer.resolve(path, in: container) else {
      return nil
    }

    #if os(iOS)
      return UIImage(contentsOfFile: url.path).map { Image(uiImage: $0) }
    #else
      return NSImage(contentsOf: url).map { Image(nsImage: $0) }
    #endif
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }

  /**
   The `#RRGGBB` the snapshot carries, or `fallback`.

   A fallback rather than an optional, because the caller is a view body and there is nothing
   sensible for it to do with a nil: a bot whose colour did not parse is drawn in the default
   colour, not left out of the list.
   */
  init(hexString: String, fallback: UInt32 = 0x2A72DC) {
    var value: UInt64 = 0
    let digits = hexString.hasPrefix("#") ? String(hexString.dropFirst()) : hexString

    guard digits.count == 6, Scanner(string: digits).scanHexInt64(&value) else {
      self.init(hex: fallback)

      return
    }

    self.init(hex: UInt32(value))
  }
}
