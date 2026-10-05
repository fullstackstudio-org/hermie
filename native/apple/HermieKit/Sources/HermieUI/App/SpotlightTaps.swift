import HermieCore
import HermieShared
import SwiftUI

#if canImport(CoreSpotlight)
  import CoreSpotlight
#endif

extension View {
  /**
   A tap on one of the app's results in the system's search: the system hands the app an activity
   (`CSSearchableItemActionType`) carrying the item's identifier, which is a `hermie://` link the router
   already opens (a bot's chat, or one of its other conversations). An identifier that is not one of the
   four shapes (`DeepLink`) is ignored, as a link from outside is.
   */
  func spotlightTaps(_ open: @escaping @MainActor (DeepLink) -> Void) -> some View {
    #if canImport(CoreSpotlight)
      onContinueUserActivity(CSSearchableItemActionType) { activity in
        let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String

        if let link = ChatSpotlightIndex.link(forIdentifier: identifier) {
          open(link)
        }
      }
    #else
      self
    #endif
  }
}
