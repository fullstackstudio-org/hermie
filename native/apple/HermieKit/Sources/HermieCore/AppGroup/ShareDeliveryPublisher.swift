import Foundation
import HermieShared
import HermieStore

/**
 Keeps the share extension's one credential (`hermie.share.delivery`) in step with the app's.

 What `writeShareDeliveryRecord`, `dropShareDeliveryRecordFor` and `publishedShareDeliveryGateway`
 in `delivery-credential.ts` did. The record goes into the secret store, which in the apps is the
 keychain under the group the app and the share extension both declare — the same item shape the
 Expo build writes, so neither side has to know which build wrote it. Never into the App Group
 container.

 The three moments to call it (the wiring is the session layer's):

 - the active gateway changed (sign-in, switch, removal): `publish(_:)` with the active gateway's
   record, or nil when there is none, which deletes it;
 - a token rotated: `refresh(_:)`, which only replaces a record that is this gateway's or absent;
 - a gateway signed out: `drop(gatewayId:)`, which only removes a record that is that gateway's.

 Nothing here throws. A keychain that refuses means the extension queues instead of sending, which
 is what it did before it could send at all.
 */
public struct ShareDeliveryPublisher: Sendable {
  private let store: any SecretStore

  public init(store: any SecretStore) {
    self.store = store
  }

  /// Publish `record`, or take the published one away when it is nil. Answers whether that worked.
  @discardableResult
  public func publish(_ record: ShareDeliveryRecord?) -> Bool {
    do {
      guard let record else {
        try store.delete(SecretKeys.shareDelivery)
        return true
      }

      try store.set(SecretKeys.shareDelivery, record.encodedString())

      return true
    } catch {
      return false
    }
  }

  /**
   Publish a rotated token's record, unless the published record belongs to another gateway.

   Also when nothing is published, which is what a sign-out leaves behind: otherwise signing out
   and back in would leave the extension with nothing until the active gateway next changed. A
   record for an inactive gateway is inert, because the extension compares its key with the one in
   `share-targets.json` before it sends.
   */
  @discardableResult
  public func refresh(_ record: ShareDeliveryRecord) -> Bool {
    guard let published = publishedGatewayId(), published != record.gatewayId else {
      return publish(record)
    }

    return false
  }

  /// Take the published record away if it is `gatewayId`'s. Answers whether it was removed.
  @discardableResult
  public func drop(gatewayId: String) -> Bool {
    guard publishedGatewayId() == gatewayId else {
      return false
    }

    return (try? store.delete(SecretKeys.shareDelivery)) != nil
  }

  /// Whose record is published now, or nil (also when the store cannot be read).
  public func publishedGatewayId() -> String? {
    ShareDeliveryRecord.parse((try? store.get(SecretKeys.shareDelivery)) ?? nil)?.gatewayId
  }
}
