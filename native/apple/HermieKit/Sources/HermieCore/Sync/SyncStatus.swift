import Foundation
import HermieStore
import Observation
import Synchronization
import os

// MARK: - Outcomes and errors

/// How one reconcile ended.
public enum SyncOutcome: Sendable, Equatable {
  /// A plan was applied (fully, or up to a remote write that failed and is retried later).
  case applied(SyncSummary)
  /// Nothing to do: this device and iCloud Keychain agree.
  case upToDate
  /// Sync did not run; the reason says why.
  case skipped(SyncSkipReason)
  /// Something could not be read or written; nothing after the failing step was done.
  case failed(SyncEngineError)
  /// Changes kept arriving while it ran; the reconcile they triggered does the work.
  case superseded
}

extension SyncOutcome: CustomStringConvertible {
  public var description: String {
    switch self {
    case let .applied(summary):
      "applied(added: \(summary.added), updated: \(summary.updated), purged: \(summary.purged), "
        + "published: \(summary.published), deleted: \(summary.deleted), remoteFailures: \(summary.remoteFailures))"
    case .upToDate: "upToDate"
    case let .skipped(reason): "skipped(\(reason.rawValue))"
    case let .failed(error): "failed(\(error.description))"
    case .superseded: "superseded"
    }
  }
}

public enum SyncSkipReason: String, Sendable, Equatable {
  /// "Sync with iCloud Keychain" is off on this device.
  case disabled
  /// The person has not seen the disclosure yet; nothing is published before that.
  case notDisclosed
  /// The synced store cannot be used by this process.
  case unavailable
  /// The sync state was written by a newer build; nothing is written over it.
  case unsupportedState
}

/// What an applied plan changed. Counts only.
public struct SyncSummary: Sendable, Equatable {
  public var added = 0
  public var updated = 0
  public var purged = 0
  public var published = 0
  public var deleted = 0
  /// Remote writes that failed; their registers are put back by a later reconcile.
  public var remoteFailures = 0

  public init() {}
}

/**
 Why the engine stopped. No case carries a value, a key, an account or an address: every
 description is written by hand, so a log line or an error alert cannot leak a credential.
 */
public enum SyncEngineError: Error, Sendable, Equatable, CustomStringConvertible {
  /// The gateway list was written by a newer build.
  case unsupportedRegistry
  /// The gateway list is there but cannot be read as a whole.
  case unreadableRegistry
  /// The sync state was written by a newer build.
  case unsupportedState
  /// A per-gateway config is not a JSON object.
  case unreadableConfig
  /// The device-only keychain failed (including "cannot be read until the device is unlocked").
  case secretStore(SecretStoreError)
  /// The synced store failed.
  case syncedStore(SecretStoreError)
  /// The synced store cannot be used by this process.
  case storeUnavailable
  /// SQLite failed, with its result code.
  case database(code: Int32)
  /// No gateway with that id.
  case unknownGateway
  /// "Remove from All Devices" for a gateway that is not synced.
  case notAttached
  /// An id, address or field the operation cannot take.
  case invalidArgument
  /// The system could not produce random bytes.
  case randomUnavailable
  /// The gateway's credentials are still bound to an origin it has left; nothing is stored for it
  /// until that move is finished.
  case credentialsQuarantined
  /// A plan that breaks the merge's contract (more than one local op for a gateway); not applied.
  case invalidPlan
  /// Any other error, by its type name only.
  case other(String)

  public var description: String {
    switch self {
    case .unsupportedRegistry: "The gateway list was written by a newer version of Hermie."
    case .unreadableRegistry: "The gateway list could not be read."
    case .unsupportedState: "The sync state was written by a newer version of Hermie."
    case .unreadableConfig: "A gateway's configuration could not be read."
    case let .secretStore(error): "The device keychain failed: \(error.description)"
    case let .syncedStore(error): "iCloud Keychain failed: \(error.description)"
    case .storeUnavailable: "iCloud Keychain is not available to this app."
    case let .database(code): "The local database failed with code \(code)."
    case .unknownGateway: "There is no such gateway on this device."
    case .notAttached: "This gateway is not synced, so it can only be removed from this device."
    case .invalidArgument: "The gateway or field is not one sync can take."
    case .randomUnavailable: "No random bytes were available."
    case .credentialsQuarantined: "This gateway's credentials still belong to its previous address."
    case .invalidPlan: "The sync plan was not one the engine can apply."
    case let .other(type): "Sync failed (\(type))."
    }
  }

  /// Any error as one of these, keeping nothing but what the cases above may say.
  static func wrap(_ error: any Error, synced: Bool = false) -> SyncEngineError {
    switch error {
    case let error as SyncEngineError: error
    case let error as SecretStoreError: synced ? .syncedStore(error) : .secretStore(error)
    case let error as SQLiteError: .database(code: error.code)
    case is GatewayRegistryError: .unsupportedRegistry
    default: .other(String(describing: type(of: error)))
    }
  }
}

// MARK: - Logging

/**
 Where the engine's diagnostics go. The engine only ever passes text it built from gateway ids,
 accounts (`gw.<key>`), stamps, device tags, field names, counts and the descriptions of
 `SyncEngineError`, `SyncPlan` and `SyncLocalOp`, none of which holds a value.
 */
public struct SyncLogger: Sendable {
  let sink: @Sendable (String) -> Void

  public init(_ sink: @escaping @Sendable (String) -> Void) {
    self.sink = sink
  }

  /// The unified log, subsystem `dev.hermie.app`, category `sync`.
  public static let system: SyncLogger = {
    let logger = Logger(subsystem: "dev.hermie.app", category: "sync")
    return SyncLogger { line in logger.info("\(line, privacy: .public)") }
  }()

  public static let none = SyncLogger { _ in }

  func callAsFunction(_ line: String) {
    sink(line)
  }
}

// MARK: - Events

/**
 What the UI hears from sync: the person-facing events of a plan, and the engine's own
 `unavailable`. Ids and names only, never a credential. Other plan events (`headersNotSynced`, and
 whatever a later merge adds) go to `SyncStatus.developerNotes` only (review A9).
 */
public enum SyncNotice: Sendable, Equatable {
  case adopted(gatewayId: String)
  case removedElsewhere(gatewayId: String, name: String)
  /// The gateway is here but has no credential this device can use: "Sign in to continue".
  case needsSignIn(gatewayId: String)
  /// The synced store cannot be used by this process; sync is paused.
  case unavailable
  /// iCloud Keychain read empty ("Delete Everything from iCloud Keychain" elsewhere, or this
  /// device's copy was lost): these gateways stay here but are no longer synced. "Sync Again" is
  /// `GatewaySyncEngine.resync(id:)`.
  case storeEmptied(gatewayIds: [String])
  /// These gateways stay on this device only: a removal on all devices made elsewhere is newer than
  /// when they were added (or moved) here. "Sync Again" (`resync`) does not publish them over that
  /// removal; adding the gateway again here does.
  case removedElsewhereKeptHere(gatewayIds: [String])
}

/// Every subscriber gets every event from the moment it subscribed.
final class SyncEventHub<Element: Sendable>: Sendable {
  private struct State {
    var next = 0
    var continuations: [Int: AsyncStream<Element>.Continuation] = [:]
  }

  private let state = Mutex(State())

  func subscribe() -> AsyncStream<Element> {
    let (stream, continuation) = AsyncStream.makeStream(of: Element.self)
    let id = state.withLock { state in
      state.next += 1
      state.continuations[state.next] = continuation
      return state.next
    }

    continuation.onTermination = { [weak self] _ in
      _ = self?.state.withLock { $0.continuations.removeValue(forKey: id) }
    }

    return stream
  }

  func send(_ events: [Element]) {
    guard !events.isEmpty else { return }
    let continuations = state.withLock { Array($0.continuations.values) }
    for continuation in continuations {
      for event in events { continuation.yield(event) }
    }
  }
}

// MARK: - Status

/**
 What Settings, the onboarding and the developer screen show about sync, kept current by the
 engine. Read-only for the views; the engine is the only writer.
 */
@MainActor
@Observable
public final class SyncStatus {
  public enum Availability: Sendable, Equatable {
    /// Not looked at yet.
    case unknown
    case available
    /// The synced store refuses this process (unsigned build, no keychain group): the switch is disabled.
    case unavailable
  }

  /// One gateway's place in sync.
  public enum GatewayState: Sendable, Equatable {
    /// Sync is off on this device, or the disclosure has not been seen.
    case off
    /// Not yet in iCloud Keychain as far as this device has seen (it is published at the next reconcile).
    case pending
    /// Its item was read back from iCloud Keychain.
    case synced
    /// Its item vanished from iCloud Keychain (deleted elsewhere, keychain reset); kept here, device-only.
    case absent
    /// Kept on this device only, for the reason given.
    case deviceOnly(DeviceOnlyReason)
  }

  public enum DeviceOnlyReason: Sendable, Equatable {
    /// "Sync this gateway" is off.
    case switchedOff
    /// Another gateway here has the same origin and is the synced one.
    case sameOriginAsAnother
    /// A newer build detached it for a reason this build does not know.
    case newerBuild
  }

  public struct Gateway: Sendable, Equatable {
    public var state: GatewayState
    /// Offer "Remove from All Devices": only for a gateway that is attached (`detached == nil`).
    public var canRemoveFromAllDevices: Bool
    public var signedOut: Bool
  }

  public private(set) var enabled = true
  public private(set) var disclosed = false
  public private(set) var availability = Availability.unknown
  public private(set) var unsupportedState = false
  public private(set) var lastOutcome: SyncOutcome?
  /// Epoch milliseconds of the last reconcile that ran to the end.
  public private(set) var lastReconciledAt: Double?
  /// By gateway id.
  public private(set) var gateways: [String: Gateway] = [:]
  /// How far (ms) the newest stamp in iCloud Keychain is ahead of this device's clock. For the
  /// developer screen only: sync never corrects a clock, and a person never needs to see this.
  public private(set) var clockSkew: Double?
  /// The newest plan events that are not for the person (`headersNotSynced`, a restored
  /// credential), as value-free descriptions, newest last. For the developer screen only.
  public private(set) var developerNotes: [String] = []

  static let developerNoteLimit = 50

  nonisolated public init() {}

  struct Update: Sendable {
    var enabled: Bool
    var disclosed: Bool
    var unsupportedState: Bool
    var gateways: [String: Gateway]
    var availability: Availability?
    var outcome: SyncOutcome?
    var reconciledAt: Double?
    var clockSkew: Double??
    var developerNotes: [String] = []
  }

  func apply(_ update: Update) {
    if enabled != update.enabled { enabled = update.enabled }
    if disclosed != update.disclosed { disclosed = update.disclosed }
    if unsupportedState != update.unsupportedState { unsupportedState = update.unsupportedState }
    if gateways != update.gateways { gateways = update.gateways }
    if let availability = update.availability, availability != self.availability { self.availability = availability }
    if let outcome = update.outcome { lastOutcome = outcome }
    if let reconciledAt = update.reconciledAt { lastReconciledAt = reconciledAt }
    if let skew = update.clockSkew { clockSkew = skew }
    if !update.developerNotes.isEmpty {
      developerNotes = Array((developerNotes + update.developerNotes).suffix(Self.developerNoteLimit))
    }
  }

  /// The view of every registry gateway, from the sync state.
  nonisolated static func gateways(ids: [String], state: SyncState?) -> [String: Gateway] {
    var result: [String: Gateway] = [:]
    let active = state.map { $0.enabled && $0.disclosed && $0.unsupportedVersion == nil } ?? false

    for id in ids {
      let entry = state?.entries[id]
      let gatewayState: GatewayState

      if !active {
        gatewayState = .off
      } else if let entry {
        switch entry.detached {
        case nil: gatewayState = entry.seen ? .synced : .pending
        case .absent?: gatewayState = .absent
        case .user?: gatewayState = .deviceOnly(.switchedOff)
        case .duplicateOrigin?: gatewayState = .deviceOnly(.sameOriginAsAnother)
        case .other?: gatewayState = .deviceOnly(.newerBuild)
        }
      } else {
        gatewayState = .pending
      }

      result[id] = Gateway(
        state: gatewayState,
        canRemoveFromAllDevices: active && entry != nil && entry?.detached == nil,
        signedOut: entry?.signedOut ?? false
      )
    }

    return result
  }
}
