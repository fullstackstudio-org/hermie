import Foundation
import HermieProtocol

/**
 This installation's part of one gateway's push section (ADR-0017, D28): its row in
 `push.registrations` and its `seen` heartbeat, written through that gateway's `UIMetaSync`.

 The row mirrors `PushController.addressState(for:)`:

 - **registered**: `pushRowFor` of the relay address — `v: 1`, `transport: "relay"`, the relay
   origin, the handle, the send secret (`secret`), the platform, the types, `preview`, the gateway
   key and `updatedAt` — plus `clears: true` (this build handles clearing pushes, so a sender may
   send it one), `requestMethods: true` (it never shows Allow or Deny for a request that is not an
   approval, so a sender may post those) and every key of this installation's existing row that this
   build does not write (`enc` from a newer build, say), carried as it came. No row when no type is wanted, which is
   how every reader treats one.
 - **none**: the row is removed, and stays removed: the sync remembers it, so a gateway copy that
   still holds the row (one taken in before this launch said so) is written back without it.
 - **unknown**: nothing is touched; a keychain that cannot be read right now is not a reason to
   take this device off a gateway.

 The row is re-checked after every copy taken in and whenever the app comes to the front, so a
 gateway copy that lost it (the plugin moved the rows to the per-person key) is repaired; and the
 sync itself sends the section again when the gateway's copy differs from this device's own row.
 Checks run one at a time, so an older address never lands after a newer one.

 It reaches its own row and nothing else (`UIMetaSync.setPushRow`), never writes the manage secret
 (`PushRelayAddress` does not hold it), and writes only when the row would change.

 It also reads the plugin advert: a gateway whose plugin does not advertise `push.relay`, or whose
 `relayOrigins` leave this relay out, will not deliver to the row (`delivery`). The row is written
 anyway and starts working when the plugin does; Settings says why nothing arrives meanwhile.

 The heartbeat follows the Expo app (`push-sync.ts`): while a chat is open and the app is in front,
 `seen[<installation id>]` is stamped at once and then every `heartbeat` (a minute), as `{bot, at}`
 where the plugin advertises `push.seen.per_chat` and as a bare stamp otherwise; stale entries are
 swept on every stamp. Nothing is stamped until the gateway's capabilities have been read: a bare
 stamp where the plugin reads `{bot, at}` would hold back notifications for every chat.
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

  /// The plugin reads `{bot, at}` in `seen`. Meaningful once `capabilitiesKnown`.
  public private(set) var perChat = false
  /// A copy of the gateway's sections, plugin advert included, has been taken in.
  public private(set) var capabilitiesKnown = false
  /// Whether the gateway's notifier will deliver to this row.
  public private(set) var delivery: PushDelivery = .unknown

  private let addressState: @MainActor (String) async -> PushAddressState
  private let relayOrigin: String
  private let onDelivery: (@MainActor (PushDelivery) -> Void)?
  private let heartbeat: Duration
  private let now: @Sendable () -> Double
  private var openBot: String?
  private var foreground = true
  private var timer: Task<Void, Never>?
  private var refreshing: Task<Bool, Never>?

  /// - Parameters:
  ///   - addressState: `PushController.addressState(for:)`, or a stand-in in a test.
  ///   - relayOrigin: the relay this build registers with, checked against the plugin's list.
  ///   - onDelivery: told every time the delivery verdict changes (the controller, for Settings).
  ///   - now: Unix seconds, for `seen`.
  public init(
    sync: UIMetaSync,
    gatewayId: String,
    gatewayKey: String,
    installation: String,
    relayOrigin: String = PushRelay.defaultOrigin,
    addressState: @escaping @MainActor (String) async -> PushAddressState,
    onDelivery: (@MainActor (PushDelivery) -> Void)? = nil,
    heartbeat: Duration = .seconds(60),
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
  ) {
    self.sync = sync
    self.gatewayId = gatewayId
    self.gatewayKey = gatewayKey
    self.installation = installation
    self.relayOrigin = relayOrigin
    self.addressState = addressState
    self.onDelivery = onDelivery
    self.heartbeat = heartbeat
    self.now = now
  }

  /// Over the launch's push controller, which also hears the delivery verdict.
  public convenience init(sync: UIMetaSync, gatewayId: String, gatewayKey: String, installation: String, push: PushController) {
    self.init(
      sync: sync,
      gatewayId: gatewayId,
      gatewayKey: gatewayKey,
      installation: installation,
      relayOrigin: push.relay,
      addressState: { [weak push] id in await push?.addressState(for: id) ?? .unknown },
      onDelivery: { [weak push] delivery in push?.setDelivery(delivery, for: gatewayId) }
    )
  }

  // MARK: The row

  /// `PushController.onAddressesChanged`: rewrite the row when this gateway is among them.
  public func addressesChanged(_ gatewayIds: Set<String>) async {
    if gatewayIds.contains(gatewayId) {
      await refresh()
    }
  }

  /// Make the row match the address now. Returns whether the device's copy changed. Calls run one
  /// after another, each reading the address afresh, so the last one always wins.
  @discardableResult
  public func refresh() async -> Bool {
    let previous = refreshing
    let task = Task { [weak self] () -> Bool in
      _ = await previous?.value
      return await self?.check() ?? false
    }

    refreshing = task
    return await task.value
  }

  private func check() async -> Bool {
    let state = await addressState(gatewayId)
    let before = sync.app

    switch state {
    case .unknown:
      return false

    case .none:
      // Always said, row or not: the sync then keeps it out of every copy taken in, and sends the
      // section again when the gateway still holds it.
      sync.setPushRow(nil, installation: installation)

    case .registered(let address):
      if PushRows.noTypeWanted(types) {
        sync.setPushRow(nil, installation: installation)
      } else {
        let row = row(for: address, existing: ownRow)

        if row.json != ownRow {
          sync.setPushRow(row, installation: installation)
        }
      }
    }

    return sync.app != before
  }

  /// This installation's row as the sync holds it now, or nil.
  public var ownRow: JSONObject? {
    sync.app?[PushRows.sectionKey]?[PushRows.registrationsKey]?[installation]?.objectValue
  }

  /// The row for an address, carrying what this build does not write from the existing row.
  func row(for address: PushRelayAddress, existing: JSONObject?) -> UIMetaPushRow {
    var built = PushRows.rowFor([
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

    // This build handles clearing pushes (`PushClearing`), so a sender may send them to this row. A
    // build that does not know the field would show one as a new request, buttons and all; this is
    // why the contract makes it an opt-in. `pushRowFor` stays the reference's own port.
    built[PushRows.clearsKey] = .bool(true)

    // Hermie never offers Allow or Deny for a confirmation, a secure input or a clarify: the marker
    // that lets a sender post those kinds to this row (`requests` in the contract).
    built[PushRows.requestMethodsKey] = .bool(true)

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

  /// The app came to the front or left it. Coming to the front also re-checks the row.
  public func setForeground(_ foreground: Bool) {
    guard self.foreground != foreground else {
      return
    }

    self.foreground = foreground
    syncHeartbeat()

    if foreground {
      Task { await refresh() }
    }
  }

  /// Stamp now, once the gateway's capabilities are known. Public so a test can drive the cadence
  /// without a clock.
  public func beat() {
    guard capabilitiesKnown else {
      return
    }

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

  /// A copy was taken in: learn the plugin's capabilities and verdict, stamp if a chat was waiting
  /// for them, and re-check the row (not awaited: the sync waits for this before it sends).
  public func didApply(_ documents: UIMetaDocuments, snapshot: UIMetaSnapshot) async {
    let advert: JSONObject?

    switch snapshot.plugin {
    case .advert(let read):
      advert = read
    case .absent:
      advert = nil
    case .unread:
      return
    }

    let wasKnown = capabilitiesKnown

    perChat = UIMetaPlugin.hasCapability(advert, PushRows.perChatCapability)
    capabilitiesKnown = true

    let verdict = PushDelivery.of(advert: advert, relay: relayOrigin)

    if verdict != delivery {
      delivery = verdict
      onDelivery?(verdict)
    }

    if !wasKnown, foreground, openBot != nil {
      beat()
    }

    Task { await refresh() }
  }
}
