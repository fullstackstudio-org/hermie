import Foundation
import Observation

/**
 The person's reusable prompts for one live session: what the composer, Settings → Prompts and a
 bot's settings read, and the one way to change them (NX-13).

 It holds no storage of its own. The session's ui_meta bridge (`GatewayMetaBridge`) attaches its
 `UIMetaSync`; every edit goes through that sync as a choice (marked, debounced, sent to the
 gateway, and so to the person's other devices), and every copy the sync takes in is read back here.
 Before a sync is attached (the first moments of a session) nothing is offered to edit
 (`canEdit`), and a person's prompts are the ones the device already held (the sync's stored copy)
 as soon as it has been read.

 The order the person gave is the order everywhere: a bot's own prompts first (as the person
 arranged them), then the global ones.
 */
@MainActor
@Observable
public final class PromptsModel {
  /// Every prompt that reads as one, in the person's order.
  public private(set) var prompts: [Prompt] = []
  public private(set) var canEdit = false
  /// How many entries the section holds, prompts or not: the room for a new one is what is left of the limit.
  public private(set) var entryCount = 0

  @ObservationIgnored private var sync: UIMetaSync?
  @ObservationIgnored private var following: Task<Void, Never>?
  @ObservationIgnored private let makeID: @Sendable () -> String

  public init(makeID: @escaping @Sendable () -> String = PromptID.make) {
    self.makeID = makeID
  }

  /// Read from `sync` from now on, and write through it. Replaces any sync attached before.
  public func attach(_ sync: UIMetaSync) {
    detach()
    self.sync = sync
    canEdit = true
    refresh()

    let changes = sync.changes()

    following = Task { [weak self] in
      // The stored copy may still be on its way off the disk; it is what an offline launch shows.
      await sync.load()

      guard self?.settleFirstRead(for: sync) == true, !Task.isCancelled else {
        return
      }

      for await _ in changes {
        guard let self, !Task.isCancelled else {
          return
        }

        self.refresh()
      }
    }
  }

  /// The stored copy has been read: show it, when `sync` is still the one attached.
  private func settleFirstRead(for sync: UIMetaSync) -> Bool {
    guard self.sync === sync else {
      return false
    }

    refresh()
    return true
  }

  /// Stop reading from `sync`, when it is the one attached. The list keeps what it shows.
  public func detach(_ sync: UIMetaSync) {
    if self.sync === sync {
      detach()
    }
  }

  private func detach() {
    following?.cancel()
    following = nil
    sync = nil
    canEdit = false
  }

  // MARK: Reading

  /// The prompts offered everywhere.
  public var global: [Prompt] { prompts.filter { $0.bot == nil } }

  /// The prompts of one bot, not the global ones.
  public func prompts(of bot: String) -> [Prompt] { prompts.filter { $0.bot == bot } }

  /// What is offered in `bot`'s chat: its own prompts, then the global ones.
  public func available(for bot: String) -> [Prompt] { prompts(of: bot) + global }

  public func prompts(in scope: PromptScope) -> [Prompt] {
    switch scope {
    case .global: global
    case .bot(let name): prompts(of: name)
    }
  }

  public func prompt(id: String) -> Prompt? { prompts.first { $0.id == id } }

  /// How many prompts a bot has of its own.
  public func count(of bot: String) -> Int { prompts(of: bot).count }

  /// Room for one more.
  public var canAdd: Bool { canEdit && entryCount < PromptLibrary.maxPrompts }

  // MARK: Choices

  /// Add a prompt at the end of its scope. Answers its id, or nil when it has no words, the list is
  /// full, or no sync is attached yet.
  @discardableResult
  public func add(title: String, text: String, scope: PromptScope) -> String? {
    guard let sync else {
      return nil
    }

    let prompt = Prompt(id: makeID(), title: title, text: text, bot: scope.botName)
    var added = false

    sync.updateApp(.choice) { added = PromptLibrary.add(prompt, in: &$0) }
    refresh()
    return added ? prompt.id : nil
  }

  /// Change a prompt's title, text and bot (its scope), keeping its place and whatever else its entry
  /// holds. False when it is gone or the new words are empty.
  @discardableResult
  public func update(_ prompt: Prompt) -> Bool {
    var updated = false

    sync?.updateApp(.choice) { updated = PromptLibrary.update(prompt, in: &$0) }
    refresh()
    return updated
  }

  @discardableResult
  public func remove(id: String) -> Bool {
    var removed = false

    sync?.updateApp(.choice) { removed = PromptLibrary.remove(id: id, in: &$0) }
    refresh()
    return removed
  }

  /// Put a prompt at place `index` among the prompts of its scope.
  public func move(id: String, toIndex index: Int) {
    sync?.updateApp(.choice) { PromptLibrary.move(id: id, toIndex: index, in: &$0) }
    refresh()
  }

  /// One place up (`-1`) or down (`1`) in its scope.
  public func step(id: String, by delta: Int) {
    guard let prompt = prompt(id: id), let position = prompts(in: prompt.scope).firstIndex(where: { $0.id == id }) else {
      return
    }

    move(id: id, toIndex: position + delta)
  }

  // MARK: Keeping up

  private func refresh() {
    guard let sync else {
      return
    }

    entryCount = PromptLibrary.entryCount(in: sync.app)

    let next = PromptLibrary.prompts(in: sync.app)

    if next != prompts {
      prompts = next
    }
  }
}
