import HermieShared
import SwiftUI

extension View {
  /**
   Tell the other devices of the same Apple ID which chat is open, so one of them can continue it
   (Handoff). The activity carries `link` and nothing else (`HandoffActivity`): never a word of the
   conversation, a draft or an address.

   Put this INSIDE the lock gate. While the app is locked the content is not built, so the activity is
   not advertised either: a locked Hermie does not tell the next device which bot the owner was
   writing to. nil advertises nothing.
   */
  func handoffAdvertising(_ link: DeepLink?) -> some View {
    userActivity(HandoffActivity.type, isActive: HandoffActivity.userInfo(for: link) != nil) { activity in
      activity.isEligibleForHandoff = true
      // Handoff only: the activity is not for search, for prediction or for the public index.
      activity.isEligibleForSearch = false
      #if os(iOS)
        activity.isEligibleForPrediction = false
      #endif
      activity.isEligibleForPublicIndexing = false
      activity.requiredUserInfoKeys = HandoffActivity.requiredUserInfoKeys
      activity.userInfo = HandoffActivity.userInfo(for: link)
    }
  }

  /**
   Continue an activity another device handed off: the link it carries goes to `open`, which is the
   router, as a link from the system does.

   Put this OUTSIDE the lock gate, beside `onOpenURL`: the router keeps what it was asked and shows it
   once the gate opens, so continuing on a locked device still asks for the unlock first. An activity
   that is not exactly a chat or a conversation link is ignored (`HandoffActivity.link`).
   */
  func handoffContinuation(_ open: @escaping @MainActor (DeepLink) -> Void) -> some View {
    onContinueUserActivity(HandoffActivity.type) { activity in
      if let link = HandoffActivity.link(from: activity.userInfo) {
        open(link)
      }
    }
  }
}
