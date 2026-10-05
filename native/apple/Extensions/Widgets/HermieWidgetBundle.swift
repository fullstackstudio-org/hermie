import SwiftUI
import WidgetKit

/**
 The extension's entry point.

 Three widgets, not three configurations of one. They answer different questions — which chat,
 which chats, and how many need me — and WidgetKit's gallery lists a bundle's widgets separately,
 so a reader adding one picks by the question rather than by a family name.

 The Mac gets the first two: "N need input" is drawn only in the lock-screen accessory families,
 which macOS does not have.

 And one control, "Ask Hermie" (`HermieAskControl`), for Control Center, the Lock Screen and the
 Mac's menu bar. A control is not a widget, but it lives in the same bundle.
 */
@main
struct HermieWidgetBundle: WidgetBundle {
  var body: some Widget {
    HermieBotWidget()
    HermieBotsWidget()
    #if os(iOS)
      HermieNeedsInputWidget()
    #endif
    HermieAskControl()
  }
}
