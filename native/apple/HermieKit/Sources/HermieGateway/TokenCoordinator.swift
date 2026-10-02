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
///   `clear`) that lands while a store read or a refresh is out cannot be
///   overwritten by it: the read hands back what is current, the refresh
///   throws `AuthChangedError`.
/// - **A definitive rejection signs out; anything else does not.** The
///   refresh closure's failure is passed through `isAuthRejection` (a
///   `GatewayError` of kind `auth` by default); only that clears the tokens.
/// - **Rotation is never thrown away.** The refresh token just spent is dead at
///   the server, so a rotated set whose write failed is still served from
///   memory, and the failed write is recorded.
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
  private var nextFlightID = 0
  private var loadFlight: (id: Int, task: Task<TokenSet?, any Error>)?
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
  public func current() async throws -> TokenSet? {
    if case .known(let tokens) = cached {
      return tokens
    }

    if loadFlight == nil {
      let flightEpoch = authEpoch
      let id = flightID()
      let store = store

      // Inherits this actor, so everything after the read runs isolated and once per flight.
      let task = Task<TokenSet?, any Error> {
        do {
          let loaded = try await store.load()

          // A sign-in or sign-out landed while the read was out: its result wins.
          if authEpoch != flightEpoch {
            if case .known(let tokens) = cached {
              return tokens
            }

            return nil
          }

          cached = .known(loaded)

          if loadFlight?.id == id {
            loadFlight = nil
          }

          return loaded
        } catch {
          if loadFlight?.id == id {
            loadFlight = nil
          }

          timeline?.record(.failure(.tokenReadFailed, error))
          throw error
        }
      }

      loadFlight = (id, task)
    }

    return try await loadFlight!.task.value
  }

  /// An access token that is good to use right now: the stored one while it
  /// is comfortably valid, otherwise the result of one shared rotation. `nil`
  /// means the person has to sign in again.
  public func accessToken(_ options: AccessTokenOptions = AccessTokenOptions()) async throws -> String? {
    if let flight = refreshFlight {
      joinedRefreshes += 1
      return try await flight.task.value
    }

    guard let tokens = try await current() else {
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
      try await clear()
      return nil
    }

    // The store read suspended, so a second caller can have opened a rotation meanwhile.
    if let raced = refreshFlight {
      joinedRefreshes += 1
      return try await raced.task.value
    }

    return try await startRefresh(tokens).value
  }

  /// Persist a freshly minted token set and fence any flight in progress.
  public func save(_ tokens: TokenSet) async throws {
    beginAuthChange()
    cached = .known(tokens)
    try await store.save(tokens)
  }

  /// Forget the tokens and fence any flight in progress.
  public func clear() async throws {
    beginAuthChange()
    cached = .known(nil)
    try await store.clear()
  }

  private func beginAuthChange() {
    authEpoch += 1
    refreshFlight = nil
    loadFlight = nil
  }

  private func flightID() -> Int {
    nextFlightID += 1
    return nextFlightID
  }

  private func startRefresh(_ tokens: TokenSet) -> Task<String?, any Error> {
    let flightEpoch = authEpoch
    let id = flightID()
    let refresh = refresh
    let store = store

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
          try await clear()
          return nil
        }

        throw error
      }

      guard authEpoch == flightEpoch else {
        throw AuthChangedError()
      }

      timeline?.record(AuthEvent(.refreshOK, expiresIn: rotated.expiresAt != 0 ? rotated.expiresAt - nowSeconds() : nil))
      cached = .known(rotated)

      // The new access token is handed out only once this write has been
      // attempted; the store puts the refresh token down first (see
      // `SecretTokenStore.save`).
      do {
        try await store.save(rotated)
        timeline?.record(AuthEvent(.tokenWriteOK))
      } catch {
        timeline?.record(.failure(.tokenWriteFailed, error))
      }

      return rotated.accessToken
    }

    refreshFlight = (id, task)
    return task
  }
}
