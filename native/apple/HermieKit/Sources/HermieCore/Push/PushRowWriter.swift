import Foundation
import HermieProtocol

/**
 This installation's part of one gateway's push section (ADR-0017, D28): its row in
 `push.registrations` and its `seen` heartbeat, written through that gateway's `UIMetaSync`.

 The row mirrors `PushController.addressState(for:)`:

 - **registered**: `pushRowFor` of the relay address — `v: 1`, `transport: "relay"`, the relay
   origin, the handle, the send secret (`secret`), the platform, the types, `preview`, the gateway
   key and `updatedAt` — plus every key of this installation's existing row that this build does not
   write (`enc` from a newer build, say), carried as it came. No row when no type is wanted, which
   is how every reader treats one.
 - **none**: the row is removed.
 - **unknown**: nothing is touched; a keychain that cannot be read right now is not a reason to
   take this device off a gateway.

 It reaches its own row and nothing else (`UIMetaSync.setPushRow`), never writes the manage secret
 (`PushRelayAddress` does not hold it), and writes only when the row would change.

 The heartbeat follows the Expo app (`push-sync.ts`): while a chat is open and the app is in front,
 `seen[<installation id>]` is stamped at once and then every `heartbeat` (a minute), as `{bot, at}`
 where the plugin advertises `push.seen.per_chat` and as a bare stamp otherwise; stale entries are
 swept on every stamp.
 */
@MainActor
public final class PushRowWriter: UIMetaContributor {
  public let sync: UIMetaSync
  public let gatewayId: String
  /// `GatewayKey.of(address)`: written into the row so a notification can name its gateway.
  public let gatewayKey: String
  public let installation: String

  /// The types this device asks for. Every type until the reader turns one off (a later task).
  public var types: JSONObject = PushRows.defaultTypes
  /// Whether this device wants message text. Senders ignore it for a relay row until the row
  /// carries an encryption key (D29); written so the row says what the reader chose.
  public var preview = false

  /// The plugin reads `{bot, at}` in `seen`. Learnt from every copy taken in; false until then.
  public private(set) var perChat = false

  private let addressState: @MainActor (String) async -> PushAddressState
  private let heartbeat: Duration
  private let now: @Sendable () -> Double
  private var openBot: String?
  private var foreground = true
  private var timer: Task<Void, Never>?

  /// - Parameters:
  ///   - addressState: `PushController.addressState(for:)`, or a stand-in in a test.
  ///   - now: Unix seconds, for `seen`.
  public init(
    sync: UIMetaSync,
    gatewayId: String,
    gatewayKey: String,
    installation: String,
    addressState: @escaping @MainActor (String) async -> PushAddressState,
    heartbeat: Duration = .seconds(60),
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
  ) {
    self.sync = sync
    self.gatewayId = gatewayId
    self.gatewayKey = gatewayKey
    self.installation = installation
    self.addressState = addressState
    self.heartbeat = heartbeat
    self.now = now
  }

  /// Over the launch's push controller.
  public convenience init(sync: UIMetaSync, gatewayId: String, gatewayKey: String, installation: String, push: PushController) {
    self.init(sync: sync, gatewayId: gatewayId, gatewayKey: gatewayKey, installation: installation) { [weak push] id in
      await push?.addressState(for: id) ?? .unknown
    }
  }

  // MARK: The row

  /// `PushController.onAddressesChanged`: rewrite the row when this gateway is among them.
  public func addressesChanged(_ gatewayIds: Set<String>) async {
    if gatewayIds.contains(gatewayId) {
      await refresh()
    }
  }

  /// Make the row match the address now. Returns whether anything was written.
  @discardableResult
  public func refresh() async -> Bool {
    let state = await addressState(gatewayId)
    let existing = ownRow

    switch state {
    case .unknown:
      return false

    case .none:
      guard existing != nil else {
        return false
      }

      sync.setPushRow(nil, installation: installation)
      return true

    case .registered(let address):
      guard !PushRows.noTypeWanted(types) else {
        guard existing != nil else {
          return false
        }

        sync.setPushRow(nil, installation: installation)
        return true
      }

      let row = row(for: address, existing: existing)

      guard row.json != existing else {
        return false
      }

      sync.setPushRow(row, installation: installation)
      return true
    }
  }

  /// This installation's row as the sync holds it now, or nil.
  public var ownRow: JSONObject? {
    sync.app?[PushRows.sectionKey]?[PushRows.registrationsKey]?[installation]?.objectValue
  }

  /// The row for an address, carrying what this build does not write from the existing row.
  func row(for address: PushRelayAddress, existing: JSONObject?) -> UIMetaPushRow {
    let built = PushRows.rowFor([
      "address": [
        "transport": "relay",
        "relay": .string(address.relay),
        "handle": .string(address.handle),
        "secret": .string(address.sendSecret)
      ],
      "gatewayKey": .string(gatewayKey),
      "platform": .string(address.platform),
      "types": .object(types),
      "preview": .bool(preview),
      "updatedAt": .number(address.updatedAt.rounded(.down))
    ])

    // A relay row never also names another transport's address (`pushAddressOf` refuses it).
    let written = Set(built.keys).union(["token", "endpoint", "keys"])
    var carried = (existing ?? [:]).filter { !written.contains($0.key) }

    for (key, value) in built where !UIMetaPushRow.knownKeys.contains(key) {
      carried[key] = value
    }

    return UIMetaPushRow(
      transport: "relay",
      relay: address.relay,
      handle: address.handle,
      sendSecret: address.sendSecret,
      carried: carried
    )
  }

  // MARK: The heartbeat

  /// Which chat is on screen, or nil. Drives the heartbeat with `setForeground`.
  public func setOpenChat(_ bot: String?) {
    guard openBot != bot else {
      return
    }

    openBot = bot
    syncHeartbeat()
  }

  public func setForeground(_ foreground: Bool) {
    guard self.foreground != foreground else {
      return
    }

    self.foreground = foreground
    syncHeartbeat()
  }

  /// Stamp now. Public so a test can drive the cadence without a clock.
  public func beat() {
    sync.setPushSeen(
      PushSeenEntry(bot: openBot ?? "", at: now().rounded(.down)),
      installation: installation,
      now: now(),
      perChat: perChat
    )
  }

  /// Stop the heartbeat (the gateway is no longer this device's).
  public func stop() {
    timer?.cancel()
    timer = nil
  }

  private func syncHeartbeat() {
    guard foreground, openBot != nil else {
      stop()
      return
    }

    // A new chat on screen is stamped at once: that is the moment a redundant notification would
    // otherwise go out.
    beat()

    guard timer == nil else {
      return
    }

    let heartbeat = heartbeat

    timer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: heartbeat)

        guard !Task.isCancelled, let self else {
          return
        }

        self.beat()
      }
    }
  }

  // MARK: UIMetaContributor

  public func didApply(_ documents: UIMetaDocuments, snapshot: UIMetaSnapshot) async {
    switch snapshot.plugin {
    case .advert(let advert):
      perChat = UIMetaPlugin.hasCapability(advert, PushRows.perChatCapability)
    case .absent:
      perChat = false
    case .unread:
      break
    }
  }
}
