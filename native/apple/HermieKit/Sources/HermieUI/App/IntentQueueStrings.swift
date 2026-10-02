import Foundation
import HermieCore

extension IntentQueueFailures {
  /// The sentences the Shortcuts queue answers with by itself, in the reader's language
  /// (`Resources/Native.xcstrings`). Pass this to `IntentQueueDrainer.drain`.
  public static var localized: IntentQueueFailures {
    IntentQueueFailures(
      unreadable: String(localized: "native.intents.unreadable", table: "Native", bundle: .module),
      expired: String(localized: "native.intents.expired", table: "Native", bundle: .module),
      gatewayGone: String(localized: "native.intents.gatewayGone", table: "Native", bundle: .module)
    )
  }
}
