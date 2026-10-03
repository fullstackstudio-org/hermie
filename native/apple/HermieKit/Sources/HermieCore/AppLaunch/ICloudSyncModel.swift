import Foundation
import HermieStore
import Observation

/**
 Between the sync engine and the views of Settings → iCloud Sync, the Gateways page and the
 one-time disclosure (ADR-0032, I10). The views read what this computes and call its actions; they
 hold no logic of their own. Every change goes through the engine's intents; this reads the
 engine's `SyncStatus`, its person-facing notices and the records it offers.

 Nothing here writes to iCloud Keychain before the person has answered the disclosure: the engine
 refuses to (`GatewaySync.reconcile` rule 1, `writeRemote`), and the only call that answers it for
 the person is `acceptDisclosure()`.
 */
@MainActor
@Observable
public final class ICloudSyncModel {
  // MARK: Types

  /// The one line Settings shows about sync on this device.
  public enum Phase: Sendable, Equatable {
    /// Not looked at yet (the first reconcile of this launch has not run).
    case checking
    /// iCloud Keychain cannot be used by this copy of Hermie (an unsigned build, no keychain group).
    case unavailable
    /// The sync state on this device was written by a newer Hermie.
    case newerVersion
    /// "Sync with iCloud" is off on this device.
    case off
    /// On, but the person has not answered the disclosure yet; nothing is written.
    case awaitingAnswer
    /// A sync the person started is running.
    case syncing
    /// The last sync stopped; the failure says what to do.
    case failed(Failure)
    /// The last sync ran to the end.
    case upToDate
    /// On and answered; no sync has finished yet in this launch.
    case waiting
  }

  /// Why the last sync stopped, as much as a person can act on.
  public enum Failure: Sendable, Equatable {
    /// The keychain cannot be read until the device is unlocked.
    case locked
    /// The keychain refused or failed.
    case keychain
    /// Hermie's own storage failed.
    case storage
    /// Something on this device was written by a newer Hermie.
    case newerVersion
    /// Anything else.
    case other
  }

  /// One gateway's place in sync, for the row on the iCloud Sync page.
  public enum GatewayState: Sendable, Equatable {
    /// Sync is off on this device, or not answered yet.
    case off
    /// Not yet in iCloud Keychain as far as this device has seen.
    case waiting
    case synced
    /// It was in iCloud Keychain and is no longer there (emptied, or deleted elsewhere); kept here.
    case notInICloud
    /// Removed on all devices from another device, and kept here because it was added here first.
    case removedElsewhereKeptHere
    /// "Sync this gateway" is off.
    case thisDeviceOnly
    /// Another gateway here has the same address and is the synced one.
    case sameAddressAsAnother
    /// A newer Hermie set it aside for a reason this build does not know.
    case newerVersion
  }

  /// The small mark next to a gateway on the Gateways page.
  public enum Badge: Sendable, Equatable {
    case synced
    case waiting
    case thisDeviceOnly
  }

  public struct GatewayRow: Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let state: GatewayState
    /// The value of "Sync this gateway".
    public let syncThisGateway: Bool
    /// Whether "Sync this gateway" can be changed now.
    public let canToggle: Bool
    /// Offer "Sync Again": its item is gone from iCloud and publishing it again is what the person
    /// would want. Not for a gateway removed elsewhere (that would not bring it back there).
    public let canSyncAgain: Bool
    /// No credential this device can use: "Sign in needed".
    public let needsSignIn: Bool
  }

  /// A gateway in iCloud Keychain that is not on this device.
  public struct AvailableGateway: Sendable, Equatable, Identifiable {
    public let gateway: AdoptableGateway
    /// Removed from this device earlier ("Remove from This Device"); adding it is the person's
    /// choice. Otherwise the next sync adds it by itself.
    public let removedHere: Bool

    public var id: String { gateway.key }
    public var name: String { gateway.name }
    public var address: String { gateway.address }
    /// It will ask to sign in on this device once added.
    public var needsSignIn: Bool { gateway.authKind != "session_token" || !gateway.hasSessionToken }
  }

  /// Something sync did that the person should know, until it is resolved or dismissed.
  public struct Notice: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable {
      /// iCloud Keychain read empty; these gateways stay here, no longer synced. "Sync Again".
      case storeEmptied
      /// Removed on all devices elsewhere; these stay here because they were added here first.
      case removedElsewhereKeptHere
      /// Removed on all devices from another device, and so removed here.
      case removedElsewhere(name: String)
      /// Added from iCloud Keychain and needs a sign-in on this device.
      case needsSignIn
      /// Added from iCloud Keychain.
      case adopted
    }

    public let id: Int
    public let kind: Kind
    /// The gateways it is about that are still here (none for `removedElsewhere`).
    public fileprivate(set) var gatewayIds: [String]
  }

  /// What adding a gateway from iCloud did.
  public struct AddResult: Sendable, Equatable {
    /// The new gateway's id here; nil when the next sync adds it.
    public let gatewayId: String?
    /// It needs a sign-in on this device (call the sign-in seam with `gatewayId`).
    public let needsSignIn: Bool
  }

  // MARK: State

  public let status: SyncStatus
  private let engine: GatewaySyncEngine
  private let directory: GatewayDirectory

  /// Records in iCloud Keychain for gateways not on this device, each once.
  public private(set) var available: [AvailableGateway] = []
  public private(set) var notices: [Notice] = []
  /// Gateways that need a sign-in here (from the engine's notices and from adding one).
  public private(set) var signInNeeded: Set<String> = []
  /// Gateways kept here after a removal on all devices elsewhere (`removedElsewhereKeptHere`).
  public private(set) var keptAfterRemoval: Set<String> = []
  /// A sync, or another action, the person started is running.
  public private(set) var busy = false
  public private(set) var syncing = false
  /// The last action the person started that failed, until the next one.
  public private(set) var actionFailure: Failure?
  /// Settings asked to turn sync on while the disclosure is unanswered: show it there.
  public var disclosureRequested = false

  private var started = false
  /// Gateways a notice or mark is about that have been seen in the list, and seen `absent`.
  private var seenHere: Set<String> = []
  private var seenAbsent: Set<String> = []
  private var nextNoticeId = 0
  private var refreshing: Task<Void, Never>?
  /// `lookInICloud()` was called: reading before the answer is wanted.
  private var lookedBeforeAnswer = false

  public init(engine: GatewaySyncEngine, directory: GatewayDirectory) {
    self.engine = engine
    self.status = engine.status
    self.directory = directory
  }

  // MARK: Derived

  /// The disclosure is due: sync is on and usable here, the person has not answered, and there is
  /// something to write or to take (a gateway here, or one `lookInICloud()` found in iCloud
  /// Keychain).
  public var needsDisclosure: Bool {
    status.enabled && !status.disclosed && status.availability == .available && !status.unsupportedState
      && directory.loaded && !directory.loadFailed && directory.unsupportedVersion == nil
      && (!directory.isEmpty || !available.isEmpty)
  }

  /// The disclosure sheet is to be shown: due, or asked for from Settings.
  public var showsDisclosure: Bool {
    needsDisclosure || (disclosureRequested && status.availability == .available && !status.unsupportedState)
  }

  /// "Sync with iCloud" as the switch shows it: on and answered.
  public var isOn: Bool {
    status.enabled && status.disclosed && !status.unsupportedState
  }

  /// The switch can be used: the store is usable and the state is this build's.
  public var canChangeSwitch: Bool {
    status.availability == .available && !status.unsupportedState && !busy
  }

  /// Syncing runs on this device: on, answered, usable.
  public var isActive: Bool {
    isOn && status.availability == .available
  }

  public var phase: Phase {
    if status.unsupportedState { return .newerVersion }

    switch status.availability {
    case .unknown: return status.enabled ? .checking : .off
    case .unavailable: return .unavailable
    case .available: break
    }

    if !status.enabled { return .off }
    if !status.disclosed { return .awaitingAnswer }
    if syncing { return .syncing }

    switch status.lastOutcome {
    case nil, .superseded?: return .waiting
    case .upToDate?, .applied?: return .upToDate
    case let .skipped(reason)?:
      switch reason {
      case .unavailable: return .unavailable
      case .unsupportedState: return .newerVersion
      case .disabled, .notDisclosed: return .waiting
      }
    case let .failed(error)?:
      return error == .storeUnavailable ? .unavailable : .failed(Self.failure(error))
    }
  }

  /// When the last sync that ran to the end finished.
  public var lastSynced: Date? {
    status.lastReconciledAt.map { Date(timeIntervalSince1970: $0 / 1000) }
  }

  /// Every gateway on this device, in list order.
  public var rows: [GatewayRow] {
    directory.entries.map { entry in
      let gateway = status.gateways[entry.id]
      let state = gatewayState(entry.id, gateway?.state)
      let switchedOff = gateway?.state == .deviceOnly(.switchedOff)

      return GatewayRow(
        id: entry.id,
        name: entry.name,
        state: state,
        syncThisGateway: !switchedOff,
        canToggle: isActive && !busy && gateway != nil && state != .sameAddressAsAnother && state != .newerVersion,
        canSyncAgain: isActive && !busy && state == .notInICloud,
        needsSignIn: signInNeeded.contains(entry.id)
      )
    }
  }

  /// The mark for a gateway on the Gateways page; nil while sync is off here.
  public func badge(for gatewayId: String) -> Badge? {
    guard isActive, let state = status.gateways[gatewayId]?.state else { return nil }

    switch state {
    case .off: return nil
    case .synced: return .synced
    case .pending: return .waiting
    case .absent, .deviceOnly: return .thisDeviceOnly
    }
  }

  /// Offer "Remove from All Devices" for this gateway: it is synced, sync is on and answered here
  /// (the engine refuses `.allDevices` otherwise).
  public func canRemoveFromAllDevices(_ gatewayId: String) -> Bool {
    isActive && status.gateways[gatewayId]?.canRemoveFromAllDevices == true
  }

  /// How many things want the person's attention, for the badge on Settings.
  public var attentionCount: Int {
    notices.count
  }

  /// The names of the gateways a notice is about, in its order.
  public func names(in notice: Notice) -> [String] {
    notice.gatewayIds.compactMap { directory.entry(id: $0)?.name }
  }

  public func name(of gatewayId: String) -> String? {
    directory.entry(id: gatewayId)?.name
  }

  // MARK: Starting

  /**
   Listen to the engine's notices and follow its status. Call before the launch's first
   reconcile, so no notice of it is missed. Idempotent.
   */
  public func start() {
    guard !started else { return }
    started = true

    // The subscription is made here, synchronously: it hears everything from now on.
    let events = engine.events

    Task { [weak self] in
      for await notice in events {
        guard let self else { return }
        self.receive(notice)
      }
    }

    follow()
  }

  /// Re-run `settle()` whenever the status or the gateway list changes.
  private func follow() {
    withObservationTracking {
      _ = status.gateways
      _ = status.availability
      _ = status.enabled
      _ = status.disclosed
      _ = status.lastOutcome
      _ = status.lastReconciledAt
      _ = directory.entries
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.settle()
        self.follow()
      }
    }

    settle()
  }

  /**
   Notices and marks that no longer apply go, and the offered records are read again.

   A notice can arrive before the status or the gateway list shows what it is about (the engine
   announces a plan before it refreshes the status, and the list follows the store's change
   stream). So a gateway leaves a notice only once it has been seen in the state the notice is
   about and has left it since: seen here and now gone, seen `absent` and now attached again.
   */
  private func settle() {
    let here = Set(directory.entries.map(\.id))
    let absent = Set(status.gateways.compactMap { $0.value.state == .absent ? $0.key : nil })

    seenHere.formUnion(here)
    seenAbsent.formUnion(absent)

    func isHere(_ id: String) -> Bool { here.contains(id) || !seenHere.contains(id) }
    func isAbsent(_ id: String) -> Bool { isHere(id) && (absent.contains(id) || !seenAbsent.contains(id)) }

    let kept = keptAfterRemoval.filter(isAbsent)
    let signIn = signInNeeded.filter(isHere)
    // Assigned only when changed: every assignment redraws whatever reads it.
    if kept != keptAfterRemoval { keptAfterRemoval = kept }
    if signIn != signInNeeded { signInNeeded = signIn }

    let current = notices.compactMap { notice -> Notice? in
      var notice = notice
      switch notice.kind {
      case .storeEmptied:
        notice.gatewayIds = notice.gatewayIds.filter { isAbsent($0) && !keptAfterRemoval.contains($0) }
      case .removedElsewhereKeptHere:
        notice.gatewayIds = notice.gatewayIds.filter(keptAfterRemoval.contains)
      case .needsSignIn:
        notice.gatewayIds = notice.gatewayIds.filter(signInNeeded.contains)
      case .adopted:
        notice.gatewayIds = notice.gatewayIds.filter(isHere)
      case .removedElsewhere:
        return notice
      }
      return notice.gatewayIds.isEmpty ? nil : notice
    }
    if current != notices { notices = current }

    // Forget what no notice or mark needs any more.
    let tracked = Set(notices.flatMap(\.gatewayIds)).union(keptAfterRemoval).union(signInNeeded)
    seenHere.formIntersection(tracked)
    seenAbsent.formIntersection(tracked)

    refreshAvailable()
  }

  /**
   Look in iCloud Keychain for gateways that are not on this device, before the person has
   answered the disclosure: the onboarding calls this before it shows the wizard (I11), and when
   there are some, the disclosure becomes due for them. Reading is all it does. Nothing else reads
   iCloud Keychain before the answer: the launch only looks at this device's own gateways.
   */
  public func lookInICloud() {
    lookedBeforeAnswer = true
    refreshAvailable()
  }

  /// Read what iCloud Keychain offers that is not here: while sync runs here, or after
  /// `lookInICloud()` while the disclosure is unanswered. Nothing otherwise.
  private func refreshAvailable() {
    refreshing?.cancel()

    let unanswered = status.enabled && !status.disclosed && lookedBeforeAnswer
    guard status.availability == .available, !status.unsupportedState, isActive || unanswered else {
      refreshing = nil
      if !available.isEmpty { available = [] }
      return
    }

    refreshing = Task { [engine] in
      let fresh = (try? await engine.adoptable()) ?? []
      let removed = (try? await engine.removedHereAvailable()) ?? []
      guard !Task.isCancelled else { return }

      let next =
        fresh.map { AvailableGateway(gateway: $0, removedHere: false) }
        + removed.map { AvailableGateway(gateway: $0, removedHere: true) }

      if next != self.available { self.available = next }
    }
  }

  /// Wait for the offered records being read (tests, and a view that needs them now).
  public func availableSettled() async {
    await refreshing?.value
  }

  func receive(_ notice: SyncNotice) {
    switch notice {
    case let .storeEmptied(ids):
      add(.storeEmptied, ids)
    case let .removedElsewhereKeptHere(ids):
      keptAfterRemoval.formUnion(ids)
      // A storeEmptied notice that named them no longer does: this one says why.
      add(.removedElsewhereKeptHere, ids)
    case let .removedElsewhere(id, name):
      signInNeeded.remove(id)
      keptAfterRemoval.remove(id)
      add(.removedElsewhere(name: name), [id])
    case let .needsSignIn(id):
      signInNeeded.insert(id)
      add(.needsSignIn, [id])
    case let .adopted(id):
      add(.adopted, [id])
    case .unavailable:
      // The status line says so; it is not a notice.
      break
    }
    settle()
  }

  /// Merge into the newest notice of the same kind, so a run of syncs makes one notice.
  private func add(_ kind: Notice.Kind, _ ids: [String]) {
    if case .removedElsewhere = kind {
      nextNoticeId += 1
      notices.append(Notice(id: nextNoticeId, kind: kind, gatewayIds: ids))
      return
    }

    if let index = notices.lastIndex(where: { $0.kind == kind }) {
      for id in ids where !notices[index].gatewayIds.contains(id) {
        notices[index].gatewayIds.append(id)
      }
      return
    }

    nextNoticeId += 1
    notices.append(Notice(id: nextNoticeId, kind: kind, gatewayIds: ids))
  }

  // MARK: Actions

  /// "Sync with iCloud" on the disclosure: answered, and on.
  public func acceptDisclosure() async {
    await run {
      try await self.engine.disclose()
      if !self.status.enabled {
        try await self.engine.setSyncEnabled(true)
      }
    }
    disclosureRequested = false
  }

  /// "Keep on This Device" on the disclosure: sync off here. Nothing is written to iCloud Keychain,
  /// now or later, until the person turns it on in Settings (which asks again first).
  public func declineDisclosure() async {
    await run {
      if self.status.enabled {
        try await self.engine.setSyncEnabled(false)
      }
    }
    disclosureRequested = false
  }

  /// The switch turned on. Unanswered: the disclosure is asked for first, and answering it turns
  /// sync on. Answered: on straight away.
  public func turnOn() async {
    guard status.disclosed else {
      disclosureRequested = true
      return
    }

    await run { try await self.engine.setSyncEnabled(true) }
  }

  /**
   The switch turned off. Everything stays on this device. With `removingFromICloud`, every gateway
   synced from here is switched to "this device only" first, which deletes its item from iCloud
   Keychain; other devices keep their copies, device-only. Then sync stops here.
   */
  public func turnOff(removingFromICloud: Bool) async {
    await run {
      if removingFromICloud {
        for (id, gateway) in self.status.gateways.sorted(by: { $0.key < $1.key }) where gateway.canRemoveFromAllDevices {
          try await self.engine.setGatewaySynced(false, id: id)
        }
        let outcome = await self.engine.reconcileNow(.manual)
        if case let .failed(error) = outcome { throw error }
      }
      try await self.engine.setSyncEnabled(false)
    }
  }

  /// "Sync this gateway".
  public func setSynced(_ synced: Bool, gatewayId: String) async {
    await run { try await self.engine.setGatewaySynced(synced, id: gatewayId) }
  }

  /// "Sync Now".
  public func syncNow() async {
    syncing = true
    defer { syncing = false }

    await run {
      let outcome = await self.engine.reconcileNow(.manual)
      if case let .failed(error) = outcome { throw error }
    }
  }

  /// "Sync Again" for one gateway: published again at the next sync, which runs now.
  public func syncAgain(_ gatewayId: String) async {
    await run {
      try await self.engine.resync(id: gatewayId)
      _ = await self.engine.reconcileNow(.manual)
    }
  }

  /// "Sync Again" on a notice: every gateway it names.
  public func syncAgain(_ notice: Notice) async {
    let ids = notice.gatewayIds
    await run {
      for id in ids { try await self.engine.resync(id: id) }
      _ = await self.engine.reconcileNow(.manual)
    }
  }

  /// "Delete Everything from iCloud Keychain": every item goes, every gateway stays here.
  public func deleteEverything() async {
    await run { try await self.engine.deleteEverythingFromICloud() }
  }

  /**
   Add a gateway iCloud Keychain holds. One removed from this device earlier is added again here
   (the wizard's own intent, with no credential typed: the shareable ones come from iCloud at the
   sync that follows). Any other is added by that sync, which runs now.
   */
  @discardableResult
  public func add(_ offer: AvailableGateway) async -> AddResult? {
    var added: String?

    let succeeded = await run {
      if offer.removedHere {
        let gateway = offer.gateway
        added = try await self.engine.addGateway(
          NewGateway(
            name: gateway.name, address: gateway.address, authKind: GatewayAuthKind(rawValue: gateway.authKind),
            addedAt: gateway.addedAt))
      }
      let outcome = await self.engine.reconcileNow(.manual)
      if case let .failed(error) = outcome { throw error }
    }

    guard succeeded else { return nil }

    if let added, offer.needsSignIn {
      signInNeeded.insert(added)
    }

    refreshAvailable()
    return AddResult(gatewayId: added, needsSignIn: added != nil && offer.needsSignIn)
  }

  /**
   "Use These Gateways" in setup: every gateway on offer is added here. Unanswered, this is the
   answer (the step shows what is stored and where): the engine's `adopt` marks the disclosure
   seen and adopts them. Results come in the order offered, each with its id here and whether it
   needs a sign-in on this device.
   */
  public func useAvailable() async -> [AddResult] {
    let offers = available
    guard !offers.isEmpty else { return [] }

    let fresh = offers.filter { !$0.removedHere }.map(\.gateway)
    let removed = offers.filter(\.removedHere)

    let succeeded = await run {
      if !self.status.disclosed {
        // A device that has not answered: taking these is the answer; nothing of its own exists.
        _ = try await self.engine.adopt(fresh)
      }
      for offer in removed {
        let gateway = offer.gateway
        _ = try await self.engine.addGateway(
          NewGateway(
            name: gateway.name, address: gateway.address, authKind: GatewayAuthKind(rawValue: gateway.authKind),
            addedAt: gateway.addedAt))
      }
      let outcome = await self.engine.reconcileNow(.manual)
      if case let .failed(error) = outcome { throw error }
    }

    guard succeeded else { return [] }

    await directory.load()

    let results = offers.compactMap { offer -> AddResult? in
      guard let id = directory.entry(forKey: offer.gateway.key)?.id else { return nil }
      if offer.needsSignIn { signInNeeded.insert(id) }
      return AddResult(gatewayId: id, needsSignIn: offer.needsSignIn)
    }

    refreshAvailable()
    return results
  }

  /// The person signed in to this gateway here (`GatewayAccounts.signedIn(_:)` calls this).
  public func signedIn(_ gatewayId: String) {
    signInNeeded.remove(gatewayId)
    settle()
  }

  public func dismiss(_ notice: Notice) {
    notices.removeAll { $0.id == notice.id }
  }

  // MARK: Helpers

  /// Run one action: busy meanwhile, its failure kept for the status line.
  @discardableResult
  private func run(_ body: @MainActor () async throws -> Void) async -> Bool {
    busy = true
    actionFailure = nil
    defer { busy = false }

    do {
      try await body()
      return true
    } catch let error as SyncEngineError {
      actionFailure = error == .storeUnavailable ? .keychain : Self.failure(error)
      return false
    } catch {
      actionFailure = .other
      return false
    }
  }

  private func gatewayState(_ id: String, _ state: SyncStatus.GatewayState?) -> GatewayState {
    switch state {
    case nil, .off?: return .off
    case .pending?: return .waiting
    case .synced?: return .synced
    case .absent?: return keptAfterRemoval.contains(id) ? .removedElsewhereKeptHere : .notInICloud
    case .deviceOnly(.switchedOff)?: return .thisDeviceOnly
    case .deviceOnly(.sameOriginAsAnother)?: return .sameAddressAsAnother
    case .deviceOnly(.newerBuild)?: return .newerVersion
    }
  }

  static func failure(_ error: SyncEngineError) -> Failure {
    switch error {
    case .secretStore(.interactionNotAllowed), .syncedStore(.interactionNotAllowed): .locked
    case .secretStore, .syncedStore, .storeUnavailable, .randomUnavailable: .keychain
    case .database, .unreadableRegistry, .unreadableConfig: .storage
    case .unsupportedRegistry, .unsupportedState: .newerVersion
    case .unknownGateway, .notAttached, .invalidArgument, .credentialsQuarantined, .invalidPlan, .other: .other
    }
  }
}
