import Foundation
import HermieProtocol
import HermieShared
import HermieStore
import Observation

/// One gateway's registration as Settings shows it.
public enum PushGatewayState: Sendable, Equatable {
  /// Notifications are off, or not permitted.
  case off
  /// Signed out of on this device: not registered until the next sign-in there.
  case signedOut
  /// On and permitted, and nothing is registered yet: no token, or the first pass has not run.
  case waiting
  case registered(handlePrefix: String, refreshedAt: Double)
  /// Past the relay's limit of registrations per device (`PushPlan.maxRegistrations`).
  case limited
  /// The last pass could not register or refresh it. It is tried again on a later one.
  case failed(PushPassFailure)
}

/// A configured gateway as push needs it: its id, the link key a notification names it by, and
/// whether it is the one the app is connected to.
public struct PushGatewayRef: Sendable, Hashable {
  public var id: String
  public var key: String
  public var active: Bool

  public init(id: String, key: String, active: Bool = false) {
    self.id = id
    self.key = key
    self.active = active
  }
}

/// Where a tap sends the reader.
public enum PushRoute: Sendable, Equatable {
  /// A chat, by a link whose gateway key names a configured gateway.
  case chat(DeepLink)
  /**
   One conversation of that bot (a branch, an older session) that the notification named. The
   router cannot open a conversation by id yet: until the conversation viewer lands, the shell
   opens `link`'s chat and hands `sessionId` to that seam (`AppRouter` has none yet).
   */
  case conversation(DeepLink, sessionId: String)
  /**
   A request that is not an approval (a clarify, a secure input, a confirmation, at level `passkey`
   one that can only be done in the app): open it. The seam for the later task that shows it; until
   then the shell opens `link`'s chat (or `PushOpenRequest.destination`'s conversation) and drops the
   rest. Re-read the request from the gateway by `requestId` before showing anything.
   */
  case request(DeepLink, PushOpenRequest)
  /**
   A `security` notice (a passkey added to or removed from the person's account on that gateway):
   the gateway's account settings, where what changed is shown. Never a chat, and never acted on.
   */
  case security(gatewayId: String)
  /// The chat list: the notification could not be tied to a configured gateway or a usable bot.
  case chatList
}

/// Why a gateway cannot deliver to this device's relay row yet, read from its plugin advert.
public enum PushDeliveryProblem: Sendable, Equatable {
  /// No Hermie plugin, or one that predates the relay sender (`push.relay` not advertised).
  case pluginTooOld
  /// The plugin's sender posts only to the relay origins it lists, and this relay is not one.
  case relayNotAllowed
}

/// Whether a gateway's notifier will deliver to this device's relay row.
public enum PushDelivery: Sendable, Equatable {
  /// Not read yet.
  case unknown
  case ready
  /// The row is written anyway, and starts working when the plugin does.
  case cannotDeliver(PushDeliveryProblem)

  /// From a plugin advert (`nil` is no plugin at all), as `pluginAdvertOf` in
  /// `packages/gateway-client` reads it: `relayOrigins` absent is an empty list.
  public static func of(advert: JSONObject?, relay: String) -> PushDelivery {
    guard let advert, UIMetaPlugin.hasCapability(advert, PushRows.relayCapability) else {
      return .cannotDeliver(.pluginTooOld)
    }

    let origins = (advert["relayOrigins"]?.arrayValue ?? []).map { PushRows.relayOriginOf($0) }.filter { !$0.isEmpty }
    let ours = PushRows.relayOriginOf(.string(relay))

    return !ours.isEmpty && origins.contains(ours) ? .ready : .cannotDeliver(.relayNotAllowed)
  }
}

/// The signed-out mark could not be stored, so the sign-out did not happen for push.
public struct PushRetireError: Error, Sendable, Equatable {
  public init() {}
}

/// The session layer is not there to ask. The default of both session seams.
public struct PushSessionUnavailable: Error, Sendable, Equatable {
  public init() {}
}

/// Why push is not running on this device, when it should be and cannot.
public enum PushTrouble: Sendable, Equatable {
  /// The stored switch or the signed-out list cannot be read.
  case settingsUnreadable
  /// The stored registrations cannot be read.
  case registrationsUnreadable
}

/// The open requests of one bot's session on one gateway, read from it just now (`approval.pending`
/// for that session). Every row names its bot and session.
public typealias PushPendingReader = @MainActor (PushApprovalScope) async throws -> [PushOpenApproval]

/// Answer one request (`approval.respond` with the row's `session_id`).
public typealias PushResponder = @MainActor (PushApprovalAnswer) async throws -> Void

extension GatewayDirectory {
  /**
   The gateways push should know about, in the registry's order (stable, so the registration limit
   never moves between gateways when another becomes live), the live one marked; or nil while that
   is unknown: not read yet, unreadable, or stored by a newer build. Nil is never "no gateways":
   push neither starts nor revokes anything on it.
   */
  public var pushGateways: [PushGatewayRef]? {
    guard loaded, !loadFailed, unsupportedVersion == nil else {
      return nil
    }

    return entries.map { PushGatewayRef(id: $0.id, key: $0.key, active: $0.id == activeId) }
  }
}

/**
 Push on this device: the reader's switch, the system permission, the APNs token and the relay
 registrations, plus what a tap on a notification does.

 Owned by `AppLaunch`. It reaches the system only through `PushSystem`, the relay only through
 `PushRegistrar` and the gateways only through the two session seams, so all of it is tested with
 fakes.

 - Nothing runs before `start()`, and `start()` runs only once the gateway list is known
   (`setGateways`) and the switch and the signed-out list could be read. Unknown is never read as
   off or as empty.
 - Permission is asked for only from `setEnabled(true)`, which only an explicit action calls.
 - The token is asked for only when the switch is on and the system allows notifications.
 - Every change of switch, permission, token or gateway list runs a registrar pass.
 - A gateway signed out of (`retire`) stays unregistered across list changes and launches, until
   the sign-in path calls `resume`.

 Taps (ADR-0017: a notification is a hint, never an instruction): the payload's gateway key must
 name a configured gateway and its bot name must be valid, or the tap opens the chat list. A plain
 tap opens the chat. Allow and Deny answer only on the gateway the app is connected to and only for
 the bot's own chat (a branch or another conversation just opens); they re-read that bot's session
 through `pendingApprovals`, decide with `PushTapRules.resolve` (request id, bot and session must
 all match), answer through `respond`, once per request even if the tap arrives twice, and open the
 chat either way (first, before the answer). The session layer answers only while the app lock is
 open (`LiveWiring`); otherwise the chat is all that opens. Only an approval is ever answered from a
 notification: a clarify, a secure input and a confirmation (at level `passkey` it can only be done in the app) open as `PushRoute.request`,
 and a request opens its conversation by its stored `sessionKey` (its `sessionId` is the runtime id).

 A clearing push (`PushPayload.isClear`) is never a tap and never shown (`presentation` is `hidden`):
 `handleDelivery` removes the delivered notification it withdraws through `deliveredNotifications`.

 Seams for later tasks: `addressState(for:)` and `onAddressesChanged` for the ui_meta push row
 writer; `pendingApprovals`, `respond`, `retire`, `resume` and `setGateways` for the session layer;
 `deliveredNotifications` for the system's centre; `PushRoute.request` for showing a request.
 */
@MainActor
@Observable
public final class PushController {
  public private(set) var permission: PushPermission = .undetermined
  /// The reader's switch. Independent of the permission and the token.
  public private(set) var enabled = false
  /// APNs has handed this launch a token.
  public private(set) var hasToken = false
  /// The system's reason it could not give a token, verbatim and shortened.
  public private(set) var tokenFailure: String?
  /// The registrations held, by gateway id. No secrets.
  public private(set) var registrations: [String: PushRegistration] = [:]
  /// The last pass's failures, by gateway id.
  public private(set) var failures: [String: PushPassFailure] = [:]
  /// Gateways whose stored registration this build cannot decode (kept and skipped).
  public private(set) var undecodable: [String] = []
  /// Every configured gateway, in the registry's order.
  public private(set) var gateways: [PushGatewayRef] = []
  /// Gateways signed out of on this device: never registered until `resume`.
  public private(set) var retired: Set<String> = []
  /// Becomes true when `start()` has read the stored switch and the permission.
  public private(set) var started = false
  /// Why push cannot run, when it cannot. Settings offers `resetDevice()` for it.
  public private(set) var trouble: PushTrouble?
  /// The last change of the switch could not be stored; the switch stayed where it was.
  public private(set) var switchWriteFailed = false
  /// Which kinds of notification this device wants, and whether it wants a preview.
  public private(set) var preferences = PushPreferences.standard
  /// The last change of a preference could not be stored; it stayed where it was.
  public private(set) var preferencesWriteFailed = false
  /// Gateways a reset could not revoke at the relay (their secrets are kept for another try).
  public private(set) var resetLeftovers: [String] = []
  /// Whether each gateway's notifier will deliver to this device, as its row writer read it.
  public private(set) var deliveries: [String: PushDelivery] = [:]

  public let environment: APNsEnvironment
  public let environmentSource: APNsEnvironmentDetection.Source
  public let topic: String

  /// Called with the gateways whose relay address changed, after the pass that changed it: the
  /// ui_meta push row writer rewrites (or removes) those rows, reading `addressState(for:)`.
  @ObservationIgnored public var onAddressesChanged: (@MainActor (Set<String>) -> Void)?

  /// Called after the preferences changed and were stored: the ui_meta push row writer puts them in
  /// this installation's row on the live gateway (the others pick them up when they next write).
  @ObservationIgnored public var onPreferencesChanged: (@MainActor () -> Void)?

  /// The session seam for reading one bot's open requests. Until it is set, reading fails and an
  /// action opens the chat.
  @ObservationIgnored public var pendingApprovals: PushPendingReader = { _ in throw PushSessionUnavailable() }

  /// The session seam for answering one. Until it is set, answering fails and the chat opens.
  @ObservationIgnored public var respond: PushResponder = { _ in throw PushSessionUnavailable() }

  /// The session seam for telling a bot's own chat from its other conversations: every id the
  /// roster knows the bot's canonical chat by (the stored and the resolved one). Empty until the
  /// roster has been read, which sends a session the notifier did not classify to the chat.
  @ObservationIgnored public var canonicalSessionIds: @MainActor (_ gatewayId: String, _ bot: String) -> [String] = {
    _, _ in []
  }

  /// The session seam for a mute: whether the reader silenced this bot's chat on this gateway
  /// (`ChatArrangementModel`, read from the app section's `mutes`). The gateway's notifier already
  /// holds back a muted chat's notifications; this covers one that was on its way when the mute was
  /// chosen, or a notifier that has not read the section yet. Nothing is muted until it is set.
  @ObservationIgnored public var isMuted: @MainActor (_ gatewayId: String, _ bot: String) -> Bool = { _, _ in false }

  /// The system's delivered notifications, for a clearing push to take one off. The app shell sets
  /// one over `UNUserNotificationCenter`; until then nothing is delivered and nothing is removed.
  @ObservationIgnored public var deliveredNotifications: any PushDeliveredNotifications = NoDeliveredNotifications()

  @ObservationIgnored private var token: APNsDeviceToken?
  @ObservationIgnored private var gatewaysKnown = false
  @ObservationIgnored private var linkHandlers: [(id: UUID, handler: @MainActor (PushRoute) -> Void)] = []
  @ObservationIgnored private var pendingRoutes: [PushRoute] = []
  @ObservationIgnored private var pendingResponses: [(action: String, payload: PushPayload)] = []
  @ObservationIgnored private var heldFallback: Task<Void, Never>?
  @ObservationIgnored private var answering: Set<String> = []
  @ObservationIgnored private var writingPreferences = false
  @ObservationIgnored private let heldTapTimeout: Duration

  @ObservationIgnored public let system: any PushSystem
  @ObservationIgnored public let registrar: PushRegistrar
  @ObservationIgnored private let settings: KeyValueStore

  /// - Parameter heldTapTimeout: how long a tap from a cold start waits for the gateway list
  ///   before it opens the chat list instead.
  public init(
    system: any PushSystem,
    registrar: PushRegistrar,
    settings: KeyValueStore,
    topic: String,
    environment: APNsEnvironment,
    environmentSource: APNsEnvironmentDetection.Source,
    heldTapTimeout: Duration = .seconds(10)
  ) {
    self.system = system
    self.registrar = registrar
    self.settings = settings
    self.topic = topic
    self.environment = environment
    self.environmentSource = environmentSource
    self.heldTapTimeout = heldTapTimeout
  }

  /// Switched on and permitted.
  public var wanted: Bool {
    enabled && permission == .granted
  }

  /// The gateways that should be registered: configured, not signed out of, in registry order.
  public var gatewayIds: [String] {
    gateways.map(\.id).filter { !retired.contains($0) }
  }

  /// The gateways past the relay's per-device limit, which are not registered.
  public var limited: Set<String> {
    Set(PushPlan.selection(gatewayIds, holding: Set(registrations.keys).union(undecodable)).limited)
  }

  /// The relay origin registrations are made at.
  public nonisolated var relay: String {
    registrar.client.origin
  }

  // MARK: Lifecycle

  /**
   Read the switch, the signed-out list and the permission, declare the categories, ask for a token
   if wanted, and run a first pass (which revokes registrations that are no longer wanted).
   Idempotent. Does nothing until the gateway list is known, and nothing when the stored settings
   cannot be read (`trouble`): a later call tries again, and Settings offers a reset.
   */
  public func start() async {
    guard !started, gatewaysKnown else {
      return
    }

    let stored: Bool?
    let signedOut: [String]?

    do {
      stored = try await settings.value(Bool.self, forKey: StoreKeys.pushEnabled)
      signedOut = try await settings.value([String].self, forKey: StoreKeys.pushRetired)
    } catch {
      trouble = .settingsUnreadable
      return
    }

    trouble = nil
    system.setCategories(PushCategoryDescriptor.all(title: \.contractTitle))
    enabled = stored ?? false
    retired = Set(signedOut ?? [])
    // Unreadable choices are the standard ones: every type, no preview. Nothing is lost by it, and the
    // next change writes them again.
    preferences = PushPreferences.decoded(try? await settings.string(forKey: StoreKeys.pushPreferences))
    permission = await system.permission()

    if let held = await registrar.registrations() {
      registrations = Dictionary(held.map { ($0.gatewayId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    started = true

    if wanted {
      system.registerForRemoteNotifications()
    }

    await reconcile()
    await system.setBadgeCount(0)
  }

  /// The app came to the front: the permission may have changed in the system's settings.
  public func becameActive() async {
    guard started else {
      await start()
      return
    }

    await system.setBadgeCount(0)

    let next = await system.permission()

    guard next != permission else {
      return
    }

    permission = next

    if wanted {
      system.registerForRemoteNotifications()
    }

    await reconcile()
  }

  /**
   The reader's switch. Turning it on asks for permission when it has never been asked; this is
   the only place that question is put. Ignored before `start()`. The switch moves only once it is
   stored: a switch that says on and comes back off at the next launch would be a lie.
   */
  public func setEnabled(_ on: Bool) async {
    guard started else {
      return
    }

    do {
      try await settings.set(on, forKey: StoreKeys.pushEnabled)
    } catch {
      switchWriteFailed = true
      return
    }

    switchWriteFailed = false
    enabled = on

    if on {
      if permission == .undetermined {
        permission = await system.requestPermission()
      }

      if permission == .granted {
        system.registerForRemoteNotifications()
      }
    }

    await reconcile()
  }

  /// Switch one kind of notification on or off. Ignored before `start()`, and for a name this build
  /// does not know. Like the switch, it moves only once it is stored.
  public func setType(_ type: String, _ on: Bool) async {
    await change { $0.setting(type, on) }
  }

  /// Whether a notification may carry the words of a message (`preview`).
  public func setPreview(_ on: Bool) async {
    await change {
      var next = $0
      next.preview = on

      return next
    }
  }

  /// One change at a time, each made from the choices as they are when its turn comes, so two quick
  /// taps are two changes in order and never one that overwrote the other.
  private func change(_ transform: (PushPreferences) -> PushPreferences) async {
    guard started else {
      return
    }

    while writingPreferences {
      await Task.yield()
    }

    writingPreferences = true

    defer {
      writingPreferences = false
    }

    let next = transform(preferences)

    guard next != preferences else {
      return
    }

    guard let text = next.encoded() else {
      preferencesWriteFailed = true
      return
    }

    do {
      try await settings.setString(text, forKey: StoreKeys.pushPreferences)
    } catch {
      preferencesWriteFailed = true
      return
    }

    preferencesWriteFailed = false
    preferences = next
    onPreferencesChanged?()
  }

  /// Every configured gateway, in the registry's order (`GatewayDirectory.pushGateways`). Only ever
  /// a known list. Signed-out gateways stay in it; `retire` keeps them unregistered.
  public func setGateways(_ next: [PushGatewayRef]) async {
    let first = !gatewaysKnown

    gatewaysKnown = true

    guard first || next != gateways else {
      return
    }

    gateways = next
    heldFallback?.cancel()
    heldFallback = nil

    let held = pendingResponses
    pendingResponses = []

    for response in held {
      await handleResponse(actionIdentifier: response.action, payload: response.payload)
    }

    let configured = Set(next.map(\.id))

    if started, !retired.isSubset(of: configured) {
      // A gateway that is gone has nothing left to resume.
      retired.formIntersection(configured)
      try? await settings.set(retired.sorted(), forKey: StoreKeys.pushRetired)
    }

    if started {
      await reconcile()
    }
  }

  /**
   Sign-out: revoke one gateway's registration now and keep it unregistered, across list changes
   and launches, until `resume(gatewayId:)`. The retired mark is stored before the relay is asked,
   so a crash in between cannot bring the registration back; a mark that cannot be stored fails
   the retire (`PushRetireError`) with nothing changed, since a sign-out the next launch forgets
   is not one.
   */
  public func retire(gatewayId: String) async throws {
    var next = retired
    next.insert(gatewayId)

    do {
      try await settings.set(next.sorted(), forKey: StoreKeys.pushRetired)
    } catch {
      throw PushRetireError()
    }

    retired = next

    let had = registrations[gatewayId] != nil

    await registrar.retire(gatewayId: gatewayId)

    if let held = await registrar.registrations() {
      registrations = Dictionary(held.map { ($0.gatewayId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    if had, registrations[gatewayId] == nil {
      onAddressesChanged?([gatewayId])
    }
  }

  /// Sign-in: the gateway may be registered again. The sign-in path calls this.
  public func resume(gatewayId: String) async {
    guard retired.remove(gatewayId) != nil else {
      return
    }

    try? await settings.set(retired.sorted(), forKey: StoreKeys.pushRetired)
    await reconcile()
  }

  /**
   "Reset notifications on this device": revoke every registration a keychain secret still names,
   drop the stored registrations, the switch and the signed-out list, then start again from off.
   For a device whose stored push state cannot be read.
   */
  public func resetDevice() async {
    resetLeftovers = await registrar.resetDevice()

    try? await settings.removeValue(forKey: StoreKeys.pushEnabled)
    try? await settings.removeValue(forKey: StoreKeys.pushRetired)
    try? await settings.removeValue(forKey: StoreKeys.pushPreferences)

    let rows = Set(gateways.map(\.id)).union(registrations.keys)

    enabled = false
    preferences = .standard
    preferencesWriteFailed = false
    retired = []
    registrations = [:]
    failures = [:]
    undecodable = []
    trouble = nil
    switchWriteFailed = false
    started = false

    onAddressesChanged?(rows)
    await start()
  }

  /// What a gateway's push row is written from, or nil.
  public func address(for gatewayId: String) async -> PushRelayAddress? {
    await registrar.address(gatewayId: gatewayId)
  }

  /// What a gateway's push row should say: registered, none or unknown.
  public func addressState(for gatewayId: String) async -> PushAddressState {
    await registrar.addressState(gatewayId: gatewayId)
  }

  // MARK: System callbacks

  public func didRegister(deviceToken: Data) {
    guard let next = APNsDeviceToken(data: deviceToken) else {
      tokenFailure = "invalid token"
      return
    }

    tokenFailure = nil
    hasToken = true

    guard next != token else {
      return
    }

    token = next

    if started {
      Task { await reconcile() }
    }
  }

  public func didFailToRegister(message: String) {
    let trimmed = message.split(whereSeparator: \.isNewline).joined(separator: " ")
    tokenFailure = String(trimmed.prefix(200))
  }

  // MARK: Passes

  /// Run one registrar pass with the current state and publish what it ended with. Nil, and
  /// nothing done, before `start()`.
  @discardableResult
  public func reconcile() async -> PushPassReport? {
    guard started else {
      return nil
    }

    let context = PushContext(
      token: token,
      environment: environment,
      topic: topic,
      wanted: wanted,
      gatewayIds: gatewayIds
    )

    let report = await registrar.reconcile(context)

    if report.skipped {
      trouble = .registrationsUnreadable
    } else {
      registrations = report.registrations
      undecodable = report.undecodable

      if trouble == .registrationsUnreadable {
        trouble = nil
      }
    }

    failures = report.failures

    if !report.addressChanged.isEmpty {
      onAddressesChanged?(report.addressChanged)
    }

    return report
  }

  /// What a gateway's row writer read from its plugin advert. Settings says when it cannot deliver.
  public func setDelivery(_ delivery: PushDelivery, for gatewayId: String) {
    if deliveries[gatewayId] != delivery {
      deliveries[gatewayId] = delivery
    }
  }

  /// One gateway's state, for Settings.
  public func state(for gatewayId: String) -> PushGatewayState {
    guard wanted else {
      return .off
    }

    if retired.contains(gatewayId) {
      return .signedOut
    }

    if limited.contains(gatewayId) {
      return .limited
    }

    if let failure = failures[gatewayId] {
      return .failed(failure)
    }

    if let registration = registrations[gatewayId] {
      return .registered(handlePrefix: PushRelay.handlePrefix(registration.handle), refreshedAt: registration.refreshedAt)
    }

    return .waiting
  }

  // MARK: Notifications

  /// How a notification is shown while the app is in front.
  public func presentation(for payload: PushPayload?) -> PushPresentation {
    guard let payload else {
      return .foreground
    }

    // A clearing push is silent: it takes a notification away and shows nothing itself.
    if payload.isClear {
      return .hidden
    }

    // A muted chat stays silent in front too (messages, finished turns, cron results). What needs
    // the person (an approval, a clarify, a secure prompt, a passkey confirmation) and what no
    // switch turns off (`security`) are shown whatever the mute says.
    if payload.silencedByMute, mutedChat(payload) {
      return .hidden
    }

    return .foreground
  }

  /// Whether the payload names a configured gateway and a bot whose chat is muted there.
  private func mutedChat(_ payload: PushPayload) -> Bool {
    let key = payload.string("gatewayKey")
    let bot = payload.string("bot")

    guard !key.isEmpty, !bot.isEmpty, let gateway = gateways.first(where: { $0.key == key }) else {
      return false
    }

    return isMuted(gateway.id, bot)
  }

  /**
   A notification arrived (in front or as a silent data message): when it is a clearing push, remove
   the delivered notification it withdraws (by request id, or by `replaces`) and report how many went;
   nil when it is not a clearing push, which the caller then treats as any other notification.
   */
  @discardableResult
  public func handleDelivery(_ payload: PushPayload?) async -> Int? {
    guard let payload else {
      return nil
    }

    return await PushClearing.apply(payload, to: deliveredNotifications)
  }

  /// A tap on a notification, or on one of its actions. See the type's documentation for the rules.
  public func handleResponse(actionIdentifier: String, payload: PushPayload?) async {
    guard let payload else {
      return
    }

    // A clearing push is never tapped, and is never an instruction to open anything.
    if await handleDelivery(payload) != nil {
      return
    }

    // A cold start from a notification: the tap waits for the gateway list instead of guessing,
    // and opens the chat list if the list does not come.
    guard gatewaysKnown else {
      hold(actionIdentifier, payload)
      return
    }

    guard let tap = PushTap(actionIdentifier: actionIdentifier, payload: payload),
      !tap.gatewayKey.isEmpty,
      let gateway = gateways.first(where: { $0.key == tap.gatewayKey })
    else {
      open(.chatList)
      return
    }

    // A change to the person's own account lands on that gateway's account settings.
    if tap.type == PushContract.securityType {
      open(.security(gatewayId: gateway.id))
      return
    }

    // Where it lands: the bot's chat, or the conversation the notification named.
    let canonicalIds = canonicalSessionIds(gateway.id, tap.bot)

    let chat: PushRoute =
      if let request = PushTapRules.openRequest(tap, canonicalIds: canonicalIds) {
        .request(tap.link, request)
      } else {
        switch PushTapRules.destination(tap, canonicalIds: canonicalIds) {
        case .chat: .chat(tap.link)
        case .conversation(let sessionId): .conversation(tap.link, sessionId: sessionId)
        }
      }

    // A plain tap; an action on a gateway the app is not connected to (its requests cannot be
    // re-read there); an action about a branch or another conversation: open, answer nothing.
    guard tap.action != .open, gateway.active, PushTapRules.answersInPlace(tap), case .chat = chat else {
      open(chat)
      return
    }

    let flight = "\(gateway.id)\u{1F}\(tap.requestId)"

    guard answering.insert(flight).inserted else {
      // The same tap delivered twice: the first is already answering it.
      return
    }

    defer { answering.remove(flight) }

    // Answered or not, the reader lands in the chat, where what is actually true is shown. First,
    // so a tap from a cold start (which waits for the socket and the app lock) is not a blank wait.
    open(chat)

    let scope = PushApprovalScope(gatewayId: gateway.id, bot: tap.bot, sessionId: tap.sessionId)

    if let pending = try? await pendingApprovals(scope),
      case .respond(let bot, let sessionId, let requestId, let choice) = PushTapRules.resolve(tap, pending: pending)
    {
      try? await respond(
        PushApprovalAnswer(gatewayId: gateway.id, bot: bot, sessionId: sessionId, requestId: requestId, choice: choice)
      )
    }
  }

  private func hold(_ action: String, _ payload: PushPayload) {
    pendingResponses.append((action, payload))

    guard heldFallback == nil else {
      return
    }

    let timeout = heldTapTimeout

    heldFallback = Task { [weak self] in
      try? await Task.sleep(for: timeout)

      guard !Task.isCancelled, let self, !self.gatewaysKnown else {
        return
      }

      let held = self.pendingResponses
      self.pendingResponses = []
      self.heldFallback = nil

      for _ in held {
        self.open(.chatList)
      }
    }
  }

  // MARK: Routing

  /// A window's router, attached while the window is up. Routes that arrived while no window was
  /// attached are delivered to it, in order.
  public func attachLinkHandler(_ id: UUID, _ handler: @escaping @MainActor (PushRoute) -> Void) {
    linkHandlers.removeAll { $0.id == id }
    linkHandlers.append((id, handler))

    let waiting = pendingRoutes
    pendingRoutes = []

    for route in waiting {
      handler(route)
    }
  }

  /// The window became the one in front: its router receives the next taps.
  public func activateLinkHandler(_ id: UUID) {
    guard let index = linkHandlers.firstIndex(where: { $0.id == id }) else {
      return
    }

    linkHandlers.append(linkHandlers.remove(at: index))
  }

  /// The window closed. Only its own handler is removed; with none left, taps are held again.
  public func detachLinkHandler(_ id: UUID) {
    linkHandlers.removeAll { $0.id == id }
  }

  private func open(_ route: PushRoute) {
    if let current = linkHandlers.last {
      current.handler(route)
    } else {
      pendingRoutes.append(route)
    }
  }
}
