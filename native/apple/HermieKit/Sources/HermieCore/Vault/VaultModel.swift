import Foundation
import Observation

public enum VaultPhase: Sendable, Equatable {
  case idle
  case loading
  case loaded
  case failed(VaultFailure)
}

/**
 One bot's vault on the gateway, for its Vault page: the items (metadata only), the places logins come from,
 and what the page does to them (add, remove after a confirmation, lock and unlock a password manager, switch
 one on or off).

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
  /// The items being removed and the sources being locked or switched, by id and name.
  public private(set) var working: Set<String> = []
  /// Why the last remove, lock or switch did not go through.
  public private(set) var actionFailure: VaultFailure?
  /// The item the page asks about before it is removed.
  public private(set) var pendingRemoval: VaultItem?

  @ObservationIgnored private var generation = 0

  public init(bot: String, backend: any VaultBackend) {
    self.bot = bot
    self.backend = backend
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
    case .failure(let error):
      phase = items.isEmpty && phase != .loaded ? .failed(VaultFailure.classify(error)) : .loaded
    }

    if case .success(let rows) = sourcesRead {
      sources = rows
    }
  }

  // MARK: - Adding

  /// Store `request` in the bot's vault. Answers whether it was stored; the list is read again when it was.
  /// The request (and the secret in it) is not kept, whatever the answer.
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
      addFailure = VaultFailure.classify(error, scrubbing: request.secretTexts)
      return false
    }

    await load()
    return true
  }

  public func dismissAddFailure() {
    addFailure = nil
  }

  // MARK: - Removing

  /// Ask before `item` goes. Nothing is sent until `confirmRemoval()`.
  public func askRemoval(_ item: VaultItem) {
    guard item.isLocal else {
      return
    }

    pendingRemoval = item
  }

  public func cancelRemoval() {
    pendingRemoval = nil
  }

  /// The person said yes: remove the item asked about. Answers whether it was removed.
  @discardableResult
  public func confirmRemoval() async -> Bool {
    guard let item = pendingRemoval else {
      return false
    }

    pendingRemoval = nil
    return await work(on: item.id) {
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
      unlockFailure = VaultFailure.classify(error, scrubbing: [password.revealed])
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
    await work(on: source) { try await $0.lock(profile: $1, source: source) }
  }

  /// Switch a password manager on or off for this bot (off also locks it).
  @discardableResult
  public func setEnabled(_ source: String, _ enabled: Bool) async -> Bool {
    await work(on: source) { try await $0.setSourceEnabled(profile: $1, source: source, enabled: enabled) }
  }

  public func dismissActionFailure() {
    actionFailure = nil
  }

  /// One remove, lock or switch, with `key` marked as working while it runs; the page is read again after.
  private func work(
    on key: String, _ action: @Sendable (any VaultBackend, String) async throws -> Void
  ) async -> Bool {
    guard !working.contains(key) else {
      return false
    }

    working.insert(key)
    actionFailure = nil
    defer { working.remove(key) }

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
