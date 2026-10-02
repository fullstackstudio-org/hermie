import Foundation

/// Thrown to a caller whose refresh was overtaken by a sign-in or sign-out
/// (`AuthChangedError`).
public struct AuthChangedError: Error, Sendable, Equatable, CustomStringConvertible {
  public init() {}

  public var description: String { "Authentication changed while the request was in progress. Try again." }
}

/// Options for one `accessToken` call (`AccessTokenOptions`).
public struct AccessTokenOptions: Sendable, Equatable {
  public var forceRefresh: Bool
  /// The access token that just got a 401. A late 401 must join a rotation
  /// that is already running rather than rotate its winner a second time.
  public var rejectedAccessToken: String?

  public init(forceRefresh: Bool = false, rejectedAccessToken: String? = nil) {
    self.forceRefresh = forceRefresh
    self.rejectedAccessToken = rejectedAccessToken
  }
}

/// The one owner of token rotation for one gateway (the port of
/// `TokenCoordinator` in `native-auth.ts`).
///
/// - **Single flight.** Concurrent callers that need a refresh share one.
/// - **An auth epoch fences every flight.** A sign-in or sign-out (`save`,
///   `clear`) that lands while a refresh is out makes it throw
///   `AuthChangedError` instead of writing.
/// - **Store calls never interleave.** `TokenStore` is synchronous and every
///   call is made on this actor, so the epoch check and a save's writes run as
///   one step; a sign-out cannot land between a rotation's refresh token and
///   its access token. (The reference's store is async and needs a fenced load
///   flight; here a read cannot overlap a sign-in at all.)
/// - **A definitive rejection signs out; anything else does not.** Only a
///   refresh failure `isAuthRejection` accepts (a `GatewayError` of kind
///   `auth` by default) clears the tokens.
/// - **Rotation is never thrown away.** The refresh token just spent is dead at
///   the server, so a rotated set whose write failed is still served from
///   memory, the failed write is recorded, and the write is tried again on the
///   next call.
///
/// Time is read only through `nowSeconds`.
public actor TokenCoordinator {
  public typealias Refresh = @Sendable (TokenSet) async throws -> TokenSet

  private enum Cache {
    case unknown
    case known(TokenSet?)
  }

  private let store: any TokenStore
  private let refresh: Refresh
  private let nowSeconds: @Sendable () -> Double
  private let skewSeconds: Double
  private let isAuthRejection: @Sendable (any Error) -> Bool
  private let timeline: (any AuthEventRecorder)?

  private var authEpoch = 0
  private var cached = Cache.unknown
  /// A rotated set that is being served but did not reach the store.
  private var unsaved: TokenSet?
  private var nextFlightID = 0
  private var refreshFlight: (id: Int, task: Task<String?, any Error>)?
  /// How many callers joined a refresh already in flight instead of starting one.
  private(set) var joinedRefreshes = 0

  public init(
    store: any TokenStore,
    refresh: @escaping Refresh,
    nowSeconds: @escaping @Sendable () -> Double,
    skewSeconds: Double = NativeAuth.refreshSkewSeconds,
    isAuthRejection: @escaping @Sendable (any Error) -> Bool = { ($0 as? GatewayError)?.kind == .auth },
    timeline: (any AuthEventRecorder)? = nil
  ) {
    self.store = store
    self.refresh = refresh
    self.nowSeconds = nowSeconds
    self.skewSeconds = skewSeconds
    self.isAuthRejection = isAuthRejection
    self.timeline = timeline
  }

  /// The token set as stored, without refreshing anything. A failed read is
  /// not remembered: the next call reads again.
  public func current() throws -> TokenSet? {
    retryUnsavedWrite()

    if case .known(let tokens) = cached {
      return tokens
    }

    do {
      let loaded = try store.load()
      cached = .known(loaded)
      return loaded
    } catch {
      timeline?.record(.failure(.tokenReadFailed, error))
      throw error
    }
  }

  /// An access token that is good to use right now: the stored one while it
  /// is comfortably valid, otherwise the result of one shared rotation. `nil`
  /// means the person has to sign in again.
  public func accessToken(_ options: AccessTokenOptions = AccessTokenOptions()) async throws -> String? {
    if let flight = refreshFlight {
      joinedRefreshes += 1
      return try await flight.task.value
    }

    guard let tokens = try current() else {
      return nil
    }

    // A 401 for a token that is no longer the stored one was already handled
    // by whoever rotated it; hand back the current token instead.
    let rejected = options.rejectedAccessToken ?? ""
    let rejectedCurrent = rejected.isEmpty || rejected == tokens.accessToken

    if !(options.forceRefresh && rejectedCurrent),
      !NativeAuth.tokenNeedsRefresh(tokens, nowSeconds: nowSeconds(), skew: skewSeconds)
    {
      timeline?.record(AuthEvent(.tokenServed, expiresIn: tokens.expiresAt != 0 ? tokens.expiresAt - nowSeconds() : nil))
      return tokens.accessToken
    }

    if tokens.refreshToken.isEmpty {
      timeline?.record(AuthEvent(.tokenCleared, reason: .noRefreshToken))
      try clear()
      return nil
    }

    return try await startRefresh(tokens).value
  }

  /// Persist a freshly minted token set and fence any refresh in flight.
  ///
  /// If the store refuses, nothing is handed out: the store is cleared (best
  /// effort, so a half-written set from two accounts cannot survive) and the
  /// coordinator answers "signed out" until the next successful save.
  public func save(_ tokens: TokenSet) throws {
    beginAuthChange()

    do {
      try store.save(tokens)
      cached = .known(tokens)
    } catch {
      try? store.clear()
      cached = .known(nil)
      throw error
    }
  }

  /// Forget the tokens and fence any refresh in flight. Signed out here even
  /// if the store refuses the delete.
  public func clear() throws {
    beginAuthChange()
    cached = .known(nil)
    try store.clear()
  }

  private func beginAuthChange() {
    authEpoch += 1
    refreshFlight = nil
    unsaved = nil
  }

  /// Write a rotated set; on failure keep it to try again.
  private func persist(_ rotated: TokenSet) {
    do {
      try store.save(rotated)
      unsaved = nil
      timeline?.record(AuthEvent(.tokenWriteOK))
    } catch {
      unsaved = rotated
      timeline?.record(.failure(.tokenWriteFailed, error))
    }
  }

  /// A rotated set that did not reach the store is written again while it is
  /// still the one being served.
  private func retryUnsavedWrite() {
    guard let pending = unsaved, case .known(let served?) = cached, served == pending else {
      return
    }

    persist(pending)
  }

  private func startRefresh(_ tokens: TokenSet) -> Task<String?, any Error> {
    let flightEpoch = authEpoch
    nextFlightID += 1
    let id = nextFlightID
    let refresh = refresh

    // Inherits this actor: everything but `refresh` itself runs isolated.
    let task = Task<String?, any Error> {
      defer {
        if refreshFlight?.id == id {
          refreshFlight = nil
        }
      }

      timeline?.record(AuthEvent(.refreshStart))

      let rotated: TokenSet

      do {
        rotated = try await refresh(tokens)
      } catch {
        guard authEpoch == flightEpoch else {
          throw AuthChangedError()
        }

        timeline?.record(.failure(.refreshFailed, error))

        if isAuthRejection(error) {
          timeline?.record(AuthEvent(.tokenCleared, reason: .refreshRejected))
          try clear()
          return nil
        }

        throw error
      }

      // From here to the return nothing suspends, so no sign-in or sign-out
      // can land between this check, the writes and the token handed out.
      guard authEpoch == flightEpoch else {
        throw AuthChangedError()
      }

      timeline?.record(AuthEvent(.refreshOK, expiresIn: rotated.expiresAt != 0 ? rotated.expiresAt - nowSeconds() : nil))
      cached = .known(rotated)
      // The store puts the refresh token down first (see `SecretTokenStore.save`).
      persist(rotated)

      guard authEpoch == flightEpoch else {
        throw AuthChangedError()
      }

      return rotated.accessToken
    }

    refreshFlight = (id, task)
    return task
  }
}
