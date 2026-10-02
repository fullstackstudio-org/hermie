import Foundation
import HermieShared
import HermieStore

/**
 Keeps the share extension's one credential (`hermie.share.delivery`) in step with the app's.

 ## A keychain group of its own

 The record lives in the keychain group `<team>.dev.hermie.app.share`, which the app and the share
 extension both declare — and it is the ONLY group the share extension declares. The app's own
 group (`<team>.dev.hermie.app`) holds every gateway's refresh tokens, session tokens, front-door
 pairs and push secrets; a process that parses content from any app and talks to the network must
 not be able to read them. So the extension can read this one item and nothing else.

 Earlier builds wrote the record into the app's own group. Every publish and every drop deletes that
 copy first, naming the app's group explicitly (a delete without a group would reach the share
 group too). That is the whole migration: the next publish puts the record where the extension now
 looks, and the extension of this build cannot read the old one anyway.

 The item is written with the store's usual attributes: after first unlock, this device only, never
 synchronised.

 ## When to call it (the wiring is the session layer's)

 - the active gateway changed (sign-in, switch, removal): `publish(_:)` with the active gateway's
   record, or nil when there is none, which deletes it;
 - a token rotated: `refresh(_:)`, which only replaces a record that is this gateway's or absent;
 - a gateway signed out: `drop(gatewayId:)`, which only removes a record that is that gateway's.

 Nothing here throws. A keychain that refuses means the extension queues instead of sending.
 */
public struct ShareDeliveryPublisher: Sendable {
  /// The keychain group's name after the team prefix.
  public static let shareGroupSuffix = "dev.hermie.app.share"
  /// The app's own group, after the team prefix.
  public static let appGroupSuffix = "dev.hermie.app"
  /// The Info.plist keys the apps carry the two groups in, team prefix included (`$(AppIdentifierPrefix)…`).
  public static let shareGroupInfoKey = "HermieShareKeychainGroup"
  public static let appGroupInfoKey = "HermieKeychainGroup"

  private let store: any SecretStore
  private let legacyStore: (any SecretStore)?

  /**
   - `store`: the share group's store, where the record is written.
   - `legacyStore`: the app group's store, naming that group, where earlier builds wrote it; the
     copy there is deleted. Nil when there is nothing to clean up.
   */
  public init(store: any SecretStore, legacyStore: (any SecretStore)?) {
    self.store = store
    self.legacyStore = legacyStore
  }

  /**
   The keychain, with both groups read from the app's Info.plist. Nil when the build carries no team
   prefix (an unsigned or simulator build): naming a group the binary is not entitled to fails, and
   such a build has no share extension able to read it anyway.
   */
  public static func live(bundle: Bundle = .main) -> ShareDeliveryPublisher? {
    guard let shareGroup = group(bundle.object(forInfoDictionaryKey: shareGroupInfoKey) as? String, suffix: shareGroupSuffix),
      let appGroup = group(bundle.object(forInfoDictionaryKey: appGroupInfoKey) as? String, suffix: appGroupSuffix)
    else {
      return nil
    }

    return ShareDeliveryPublisher(
      store: KeychainStore(accessGroup: shareGroup), legacyStore: KeychainStore(accessGroup: appGroup))
  }

  /// A group from Info.plist, only when it is `<prefix>.<suffix>` with a non-empty prefix.
  static func group(_ value: String?, suffix: String) -> String? {
    guard let value, value.hasSuffix("." + suffix), value.count > suffix.count + 1 else {
      return nil
    }

    return value
  }

  /// Publish `record`, or take the published one away when it is nil. Answers whether that worked.
  @discardableResult
  public func publish(_ record: ShareDeliveryRecord?) -> Bool {
    dropLegacy()

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

   Also when nothing is published, which is what a sign-out leaves behind. A record for an inactive
   gateway is inert: the extension compares its key with `share-targets.json` and the entry's.
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

    dropLegacy()

    return (try? store.delete(SecretKeys.shareDelivery)) != nil
  }

  /// Whose record is published now, or nil (also when the store cannot be read).
  public func publishedGatewayId() -> String? {
    let current = (try? store.get(SecretKeys.shareDelivery)) ?? nil
    let legacy = (try? legacyStore?.get(SecretKeys.shareDelivery)) ?? nil

    return ShareDeliveryRecord.parse(current ?? legacy)?.gatewayId
  }

  private func dropLegacy() {
    try? legacyStore?.delete(SecretKeys.shareDelivery)
  }
}
