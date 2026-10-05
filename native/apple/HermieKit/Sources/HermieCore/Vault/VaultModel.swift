import Foundation
import Observation

public enum VaultPhase: Sendable, Equatable {
  case idle
  case loading
  case loaded
  case failed(VaultFailure)
}

/**
 One bot's vault on the gateway, for its Vault page and its row on the bot settings: the items (metadata only),
 the places logins come from, and what the page does to them (add, remove after a confirmation, lock and unlock
 a password manager, switch one on or off).

 **It never holds a secret.** It keeps what `vault.list` and `vault.sources` answer, which is metadata. A secret
 passes through `add(_:)` and `unlock(_:password:)` as an argument, goes into the one call that sends it, and is
 gone when that call returns, whether it was stored or refused; a refusal's words are kept only after every
 secret that went with the call is taken out of them.

 Every call names the bot (`profile`), so it reaches that bot's own vault and nobody else's.
 */
@MainActor
@Observable
public final class VaultModel {
  /// The bot's name, which is its profile on the gateway.
  public let bot: String
  @ObservationIgnored let backend: any VaultBackend
  /// Where the item count is remembered between two openings of the bot settings; nil keeps none.
  @ObservationIgnored let countKey: String?
  @ObservationIgnored let counts: VaultCounts

  public private(set) var phase: VaultPhase = .idle
  public private(set) var items: [VaultItem] = []
  public private(set) var sources: [VaultSource] = []

  /// An item is on its way into the vault.
  public private(set) var adding = false
  /// Why the last add did not go through.
  public private(set) var addFailure: VaultFailure?
  /// The password manager being unlocked.
  public private(set) var unlocking: String?
  /// Why the last unlock did not go through.
  public private(set) var unlockFailure: VaultFailure?
  /// The items being removed, by id.
  public private(set) var removing: Set<String> = []
  /// The password managers being locked or switched, by name.
  public private(set) var busySources: Set<String> = []
  /// Why the last remove, lock or switch did not go through.
  public private(set) var actionFailure: VaultFailure?
  /// The item the page asks about before it is removed.
  public private(set) var pendingRemoval: VaultItem?

  @ObservationIgnored private var generation = 0

  public init(bot: String, backend: any VaultBackend, countKey: String? = nil, counts: VaultCounts = .shared) {
    self.bot = bot
    self.backend = backend
    self.countKey = countKey
    self.counts = counts
  }

  // MARK: - What the page reads

  /// The password managers worth showing: the ones on the gateway's host, or switched on.
  public var managers: [VaultSource] {
    sources.filter { !$0.isLocal && ($0.installed || $0.enabled) }
  }

  /// A manager's name for an item it holds; nil for the bot's own vault.
  public func managerName(of item: VaultItem) -> String? {
    guard !item.isLocal else {
      return nil
    }

    return sources.first { $0.name == item.backend }?.displayName ?? item.backend
  }

  /// How many items the vault holds: the count of this model's own read, or one remembered from a recent read
  /// (`VaultCounts`); nil when neither is known.
  public var count: Int? {
    if phase == .loaded {
      return items.count
    }

    return countKey.flatMap { counts.count(for: $0) }
  }

  // MARK: - Reading

  /// Read the items and the sources. A failed read keeps what an earlier one found.
  public func load() async {
    generation += 1
    let mine = generation

    if phase != .loaded {
      phase = .loading
    }

    let backend = self.backend
    let bot = self.bot

    async let listed = Result { try await backend.list(profile: bot) }
    async let found = Result { try await backend.sources(profile: bot) }
    let (itemsRead, sourcesRead) = await (listed, found)

    guard generation == mine else {
      return
    }

    switch itemsRead {
    case .success(let rows):
      items = rows
      phase = .loaded

      if let countKey {
        counts.remember(rows.count, for: countKey)
      }
    case .failure(let error):
      phase = items.isEmpty && phase != .loaded ? .failed(VaultFailure.classify(error)) : .loaded
    }

    if case .success(let rows) = sourcesRead {
      sources = rows
    }
  }

  /// Read the vault unless a recent read already said how many items it holds (the bot settings row: a
  /// listing can ask a password manager on the gateway's host, which is not instant).
  public func loadCountIfStale() async {
    guard phase != .loaded, countKey.flatMap({ counts.count(for: $0) }) == nil else {
      return
    }

    await load()
  }

  // MARK: - Adding

  /// Store `request` in the bot's vault. Answers whether it was stored; the list is read again when it was, and
  /// when the answer did not come in time (it may have been stored). The request (and the secret in it) is not
  /// kept, whatever the answer.
  @discardableResult
  public func add(_ request: VaultAddRequest) async -> Bool {
    guard !adding else {
      return false
    }

    adding = true
    addFailure = nil
    defer { adding = false }

    do {
      _ = try await backend.add(profile: bot, request)
    } catch {
      let failure = VaultFailure.classify(error, scrubbing: request.secretTexts)
      addFailure = failure

      if failure == .timedOut {
        await load()
      }

      return false
    }

    await load()
    return true
  }

  public func dismissAddFailure() {
    addFailure = nil
  }

  // MARK: - Removing

  /// Ask before `item` goes. Nothing is sent until `confirmRemoval(_:)`.
  public func askRemoval(_ item: VaultItem) {
    guard item.isLocal else {
      return
    }

    pendingRemoval = item
  }

  /// The question went away without a yes.
  public func cancelRemoval() {
    pendingRemoval = nil
  }

  /// The person said yes to removing `item` (the item the question was about, handed in by the dialog: the
  /// dialog's dismissal clears the question before its button's action runs). Answers whether it was removed.
  @discardableResult
  public func confirmRemoval(_ item: VaultItem) async -> Bool {
    pendingRemoval = nil

    guard item.isLocal, !removing.contains(item.id) else {
      return false
    }

    removing.insert(item.id)
    defer { removing.remove(item.id) }

    return await act {
      guard try await $0.remove(profile: $1, id: item.id) else {
        throw VaultFailure.failed("")
      }
    }
  }

  // MARK: - Password managers

  /// Unlock `source` with its master password. Answers whether it unlocked. The password is not kept,
  /// whatever the answer.
  @discardableResult
  public func unlock(_ source: String, password: SecretValue) async -> Bool {
    guard unlocking == nil, !password.isEmpty else {
      return false
    }

    unlocking = source
    unlockFailure = nil
    defer { unlocking = nil }

    do {
      try await backend.unlock(profile: bot, source: source, password: password)
    } catch {
      let failure = VaultFailure.classify(error, scrubbing: [password.revealed])
      unlockFailure = failure

      if failure == .timedOut {
        await load()
      }

      return false
    }

    await load()
    return true
  }

  public func dismissUnlockFailure() {
    unlockFailure = nil
  }

  /// Lock `source` again: the gateway forgets its session token.
  @discardableResult
  public func lock(_ source: String) async -> Bool {
    await onSource(source) { try await $0.lock(profile: $1, source: source) }
  }

  /// Switch a password manager on or off for this bot (off also locks it).
  @discardableResult
  public func setEnabled(_ source: String, _ enabled: Bool) async -> Bool {
    await onSource(source) { try await $0.setSourceEnabled(profile: $1, source: source, enabled: enabled) }
  }

  public func dismissActionFailure() {
    actionFailure = nil
  }

  private func onSource(_ name: String, _ action: @Sendable (any VaultBackend, String) async throws -> Void) async
    -> Bool
  {
    guard !busySources.contains(name) else {
      return false
    }

    busySources.insert(name)
    defer { busySources.remove(name) }

    return await act(action)
  }

  /// One remove, lock or switch; the page is read again after, whatever the answer.
  private func act(_ action: @Sendable (any VaultBackend, String) async throws -> Void) async -> Bool {
    actionFailure = nil

    do {
      try await action(backend, bot)
    } catch {
      actionFailure = VaultFailure.classify(error)
      await load()
      return false
    }

    await load()
    return true
  }
}

/// How many items each bot's vault held at its last read, for a short while, so the bot settings row can say
/// it without listing the vault every time the settings open. Counts only, never an item.
@MainActor
public final class VaultCounts {
  public static let shared = VaultCounts()

  /// How long a count is shown without reading the vault again.
  public static let freshFor: Duration = .seconds(60)

  private var entries: [String: (count: Int, at: ContinuousClock.Instant)] = [:]
  private let now: () -> ContinuousClock.Instant

  public init(now: @escaping () -> ContinuousClock.Instant = { ContinuousClock.now }) {
    self.now = now
  }

  /// The key of one bot's vault on one gateway.
  public static func key(gateway: String, bot: String) -> String {
    "\(gateway)\u{1F}\(bot)"
  }

  public func remember(_ count: Int, for key: String) {
    entries[key] = (count, now())
  }

  /// The count read within `freshFor`; nil when there is none that recent.
  public func count(for key: String) -> Int? {
    guard let entry = entries[key], now() - entry.at < Self.freshFor else {
      return nil
    }

    return entry.count
  }
}
