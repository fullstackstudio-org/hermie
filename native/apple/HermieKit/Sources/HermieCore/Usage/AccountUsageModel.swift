import Foundation
import Observation

/**
 The provider accounts behind a screen's numbers (`account.usage`): one profile's, or the gateway's launch
 profile's where `profile` is nil.

 It is the part of a usage screen that may simply not be there. A gateway without the method is
 `unsupported`, and the screen keeps drawing the text lines of `session.usage` it drew before; a read that
 fails keeps what an earlier one found. Neither is ever a failure of the screen's own days.

 The gateway keeps a provider's answer for about a minute and re-reads it for `refresh: true` at most once per
 15 seconds (a refresh inside that is served from its cache). So `refresh()` asks for a forced read only when
 the last forced one is that old, and is an ordinary read otherwise: the button never has to be disabled, and
 nobody can hammer a provider with it.
 */
@MainActor
@Observable
public final class AccountUsageModel {
  public enum Phase: Sendable, Equatable {
    case idle
    case loading
    case loaded
    /// The gateway has no `account.usage`: the text lines are all there is.
    case unsupported
    /// Nothing could be read, and nothing was read before.
    case failed(UsageFailure)
  }

  /// The least time between two forced reads, which is the gateway's own floor.
  public static let refreshFloor: TimeInterval = 15

  public let profile: String?
  public private(set) var phase = Phase.idle
  /// What was last read; nil until a read has answered.
  public private(set) var usage: AccountUsage?
  /// The refresh button's read is under way, for its spinner.
  public private(set) var isRefreshing = false
  /// When the last read answered, by this device's clock.
  public private(set) var readAt: Date?

  @ObservationIgnored private let backend: any UsageBackend
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private var lastForcedAt: Date?
  @ObservationIgnored private var generation = 0

  public init(profile: String?, backend: any UsageBackend, now: @escaping @Sendable () -> Date = { Date() }) {
    self.profile = profile
    self.backend = backend
    self.now = now
  }

  /// There are structured providers to draw instead of the text lines.
  public var isStructured: Bool { usage != nil }

  /// The gateway would re-read the providers for a refresh now, and not serve it from its cache.
  public var canForceRefresh: Bool {
    guard let lastForcedAt else {
      return true
    }

    return now().timeIntervalSince(lastForcedAt) >= Self.refreshFloor
  }

  /// An ordinary read, from the gateway's cache where it has one. A newer read replaces an older one.
  public func load() async {
    await read(forcing: false, byHand: false)
  }

  /// The refresh button: a forced read where the gateway's 15 second floor has passed, else an ordinary one.
  public func refresh() async {
    await read(forcing: canForceRefresh, byHand: true)
  }

  private func read(forcing: Bool, byHand: Bool) async {
    generation += 1
    let mine = generation

    if forcing {
      lastForcedAt = now()
    }

    if byHand {
      isRefreshing = true
    }

    if phase == .idle || phase == .unsupported {
      phase = .loading
    }

    let outcome: Result<AccountUsage?, any Error>

    do {
      outcome = .success(try await backend.accountUsage(profile: profile, refresh: forcing))
    } catch {
      outcome = .failure(error)
    }

    guard generation == mine else {
      // A newer read is under way and will say; the spinner is its.
      return
    }

    isRefreshing = false

    switch outcome {
    case .success(let value?):
      usage = value
      readAt = now()
      phase = .loaded
    case .success(nil):
      // The gateway answered with nothing usable: what was known stays, and with nothing known the text
      // lines stand in.
      phase = usage == nil ? .failed(.failed("")) : .loaded
    case .failure(let error):
      switch UsageFailure.classify(error) {
      case .unsupported:
        usage = nil
        phase = .unsupported
      case let failure:
        // A failed read keeps what an earlier one found: a number that is a minute old beats none.
        phase = usage == nil ? .failed(failure) : .loaded
      }
    }
  }
}
