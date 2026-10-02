import Foundation
import HermieShareKit
import HermieShared
import HermieStore

/**
 The one credential this process may hold, read out of the keychain (ADR-0026).

 The record is in the keychain group `<team>.dev.hermie.app.share`, and that is the ONLY group this
 extension declares (`HermieShare-*.entitlements`). The app's own group, with every gateway's
 refresh and session tokens, is not readable from here at all: this process parses content handed
 over by any app and talks to the network, so it gets the one item it needs and nothing else.

 No group is named in the query. A read searches every group the binary declares, which is that one.
 The item shape is `HermieStore.KeychainStore`'s, the one the app writes with.
 */
enum HermieShareKeychain {
  /// The published record, or nil. Every failure is a nil, and nil means "queue it".
  static func deliveryCredential() -> ShareCredential? {
    let text = (try? KeychainStore().get(SecretKeys.shareDelivery)) ?? nil

    return ShareCredential(ShareDeliveryRecord.parse(text))
  }
}
