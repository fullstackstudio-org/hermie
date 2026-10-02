import SwiftUI
import WidgetKit

/**
 The extension's entry point.

 `@main` is here and nowhere else, which is the reason `ios/HermieWidgets.podspec` restricts its
 source glob to its own directory: this file compiled into the app binary alongside the app's own
 entry point is a link error, and the two directories are what keeps that from being possible.

 Three widgets, not three configurations of one. They answer different questions — which chat,
 which chats, and how many need me — and WidgetKit's gallery lists a bundle's widgets separately,
 so a reader adding one picks by the question rather than by a family name.
 */
@main
struct HermieWidgetBundle: WidgetBundle {
  var body: some Widget {
    HermieBotWidget()
    HermieBotsWidget()
    HermieNeedsInputWidget()
  }
}
