import Foundation
import HermieProtocol

// The composer's slash commands: the list that opens under the field while a command is being
// written, how its keys work, and running the command. The gateway's rules are the store's
// (`TranscriptStore+Slash.swift`); this is the reader's side of them.
//
// While the field holds a line that starts with a slash, and no line break:
//
// - the NAME is completed from the gateway's command list (`commands.catalog`, kept per chat and
//   filtered here, so the list answers at once and the reader's keys never wait for a round trip);
//   a gateway whose list cannot be read is asked for the completions themselves
//   (`complete.slash`), as the web client always does;
// - once the name is done, the ARGUMENT is completed by the gateway (`complete.slash` knows the
//   models and the levels), the command's own subcommands are offered at once, and the line under
//   the list says what the command takes.
//
// Only the newest question may paint: answers arrive out of order, and the answer for `/` must not
// land over the one for `/mo`.

/// What a line that starts with a slash is.
enum CommandDecision {
  /// A command the gateway has: run it.
  case command
  /// Prose that happens to begin with a slash (`/usr/local/bin`): send it to the bot as written.
  case prompt
  /// A send for this very line is already waiting for the command list, or the reader changed the
  /// line meanwhile: nothing to do.
  case abandoned
}

extension ComposerModel {
  // MARK: - The field set from somewhere other than typing

  /// Set the field without opening the list: a stored draft, a prefill, words put back after a
  /// failure. Typing is what opens it.
  func putDraft(_ text: String) {
    settingProgrammatically = true
    draft = text
    settingProgrammatically = false
  }

  // MARK: - The list

  /// The list for what is in the field now: opened, narrowed or closed.
  func refreshSuggestions() {
    if suggestionsDismissed {
      suggestionsDismissed = false
    }

    guard let stage = SlashStage(draft: draft) else {
      closeSuggestions()
      return
    }

    if !inSlashRun {
      inSlashRun = true
      catalogFailedInRun = false
      syncCatalog()
    }

    compute(stage)
  }

  /// The field no longer holds a command being written: nothing is listed, and what was asked of
  /// the gateway is no longer wanted.
  func closeSuggestions() {
    suggestionSerial += 1
    remoteTask?.cancel()
    remoteTask = nil
    inSlashRun = false
    catalogFailedInRun = false
    show([], loading: false, failure: nil)
    setHint(nil)

    if suggestionsDismissed {
      suggestionsDismissed = false
    }
  }

  private func compute(_ stage: SlashStage) {
    suggestionSerial += 1
    let serial = suggestionSerial
    remoteTask?.cancel()
    remoteTask = nil

    switch stage {
    case .name(let query):
      setHint(nil)

      if let catalog = commandCatalog {
        show(catalog.suggestions(matching: query), loading: false, failure: nil)
      } else {
        show([], loading: true, failure: nil)

        // The list could not be read: the gateway's own completions are what there is.
        if catalogFailedInRun {
          askGateway(typed: draft, serial: serial)
        }
      }

    case .argument(let command, let typed):
      let catalog = commandCatalog
      setHint(catalog?.argumentHint(for: command))

      if let known = catalog?.command(named: command), !known.takesArgument {
        // Nothing follows this command's name.
        show([], loading: false, failure: nil)
        return
      }

      let own = catalog?.subcommandSuggestions(for: command, argument: SlashLine(parsing: typed).argument) ?? []
      show(own, loading: own.isEmpty, failure: nil)
      askGateway(typed: typed, serial: serial)
    }
  }

  /// `complete.slash` for the line as typed. A newer question supersedes this one.
  private func askGateway(typed: String, serial: Int) {
    let store = chat.store
    let key = bot

    remoteTask = Task { [weak self] in
      let answer = await store.completeSlash(key, typed: typed)

      guard let self, !Task.isCancelled, serial == self.suggestionSerial else {
        return
      }

      self.apply(answer)
    }
  }

  private func apply(_ answer: SlashRemoteCompletions) {
    if !answer.items.isEmpty {
      show(answer.items, loading: false, failure: nil)
      return
    }

    // What the command list already offered stays; a refusal is said only when there is nothing
    // else to show.
    let failure = suggestions.isEmpty && argumentHint == nil ? answer.failure : nil
    show(suggestions, loading: false, failure: failure)
  }

  /// Fetch the command list for this chat (a cached one answers at once; one that has gone stale
  /// is fetched again, and the old one is kept if that fails), once per run of typing.
  private func syncCatalog() {
    guard catalogTask == nil else {
      return
    }

    let store = chat.store
    let key = bot

    catalogTask = Task { [weak self] in
      let loaded = try? await store.slashCatalog(key)

      guard let self else {
        return
      }

      self.catalogTask = nil
      var changed = false

      if let loaded {
        changed = loaded != self.commandCatalog || self.catalogFailedInRun
        self.commandCatalog = loaded
        self.catalogFailedInRun = false
      } else if self.commandCatalog == nil {
        changed = true
        self.catalogFailedInRun = true
      }

      if changed, self.inSlashRun, let stage = SlashStage(draft: self.draft) {
        self.compute(stage)
      }
    }
  }

  private func show(_ items: [SlashSuggestion], loading: Bool, failure: String?) {
    if items != suggestions {
      suggestions = items
      selectedSuggestion = 0
    }

    if suggestionsLoading != loading {
      suggestionsLoading = loading
    }

    if suggestionsFailure != failure {
      suggestionsFailure = failure
    }
  }

  private func setHint(_ hint: SlashArgumentHint?) {
    if argumentHint != hint {
      argumentHint = hint
    }
  }

  // MARK: - Keys

  /// A key pressed in the field while the list may be open. Answers whether the list used it: when
  /// it did not, the field does what it always does with the key.
  ///
  /// Up and Down move (and wrap), Tab takes the line, Return takes it too, except when what is in the
  /// field already IS that line (`/status` typed in full): then Return sends it. Escape closes the
  /// list and keeps it closed until the reader types again.
  @discardableResult
  public func handle(_ key: CompletionKey) -> Bool {
    guard suggestionsOpen else {
      return false
    }

    switch key {
    case .escape:
      suggestionsDismissed = true
      return true

    case .up, .down:
      guard !suggestions.isEmpty else {
        return false
      }

      let step = key == .down ? 1 : suggestions.count - 1
      selectedSuggestion = (selectedSuggestion + step) % suggestions.count
      return true

    case .tab:
      guard !suggestions.isEmpty else {
        return false
      }

      acceptSuggestion()
      return true

    case .enter:
      guard suggestions.indices.contains(selectedSuggestion) else {
        return false
      }

      let chosen = suggestions[selectedSuggestion].insert.trimmingCharacters(in: .whitespacesAndNewlines)

      if chosen == draft.trimmingCharacters(in: .whitespacesAndNewlines) {
        return false
      }

      acceptSuggestion()
      return true
    }
  }

  /// Put the line on the arrow keys' row, for a pointer that hovers over it.
  public func selectSuggestion(at index: Int) {
    if suggestions.indices.contains(index), selectedSuggestion != index {
      selectedSuggestion = index
    }
  }

  /// Take a line of the list (the one the arrow keys are on, or `index`): the field holds what it
  /// inserts, and the list moves on to what could follow.
  public func acceptSuggestion(at index: Int? = nil) {
    let chosen = index ?? selectedSuggestion

    guard suggestions.indices.contains(chosen) else {
      return
    }

    draft = suggestions[chosen].insert
  }

  /// Close the list until the reader types again.
  public func dismissSuggestions() {
    if suggestionsOpen {
      suggestionsDismissed = true
    }
  }

  // MARK: - Running a command

  /// Is the line a command the gateway has? The command list answers; when it has not been read
  /// yet the send waits for it (a second Return meanwhile does nothing), so a command typed
  /// quickly after opening the chat is not sent to the bot as prose. A gateway whose list cannot
  /// be read degrades to exactly that: the line goes out as a prompt, and the gateway understands
  /// a leading slash.
  func decideCommand(_ line: String) async -> CommandDecision {
    let name = SlashLine(parsing: line).name

    if SlashRouting.route(for: name, in: commandCatalog) != nil {
      return .command
    }

    guard !name.isEmpty else {
      return .prompt
    }

    guard commandCatalog == nil else {
      return .prompt
    }

    guard !resolvingCommand else {
      return .abandoned
    }

    resolvingCommand = true
    defer {
      resolvingCommand = false
    }

    if let loaded = try? await chat.store.slashCatalog(bot) {
      commandCatalog = loaded
    }

    // The reader typed on while it loaded: what they meant is the new line, which they send themselves.
    guard draft.trimmingCharacters(in: .whitespacesAndNewlines) == line else {
      return .abandoned
    }

    return SlashRouting.route(for: name, in: commandCatalog) != nil ? .command : .prompt
  }

  /// Run a command. The field is emptied first, so a second Return finds nothing to send; its words
  /// come back, ahead of anything typed since, if the gateway refused it.
  func runSlashCommand(_ command: String, body: String) async {
    guard canSend else {
      notice = .notSent(ChatRuntimeError.notAttached(bot).message)
      return
    }

    notice = nil
    sendsInFlight += 1
    draft = ""
    onSubmit?()

    defer {
      sendsInFlight -= 1
    }

    do {
      let outcome = try await chat.store.runSlash(bot, command: command)
      announce(.commandRan)

      // A `prefill` is text for the field, which the store does not reach into.
      if let prefill = outcome.prefill {
        putDraft(draft.isEmpty ? prefill : "\(prefill)\n\(draft)")
      }
    } catch is ConversationBusyError {
      putBack(body)
      notice = .busy
    } catch let error as ChatRuntimeError where error.isNotAttached {
      putBack(body)
      notice = .notSent(error.message)
    } catch {
      putBack(body)
      notice = .commandFailed(ChatResolver.describe(error))
    }
  }

  /// The words come back to the field, ahead of anything typed since.
  private func putBack(_ body: String) {
    putDraft(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? body : "\(body)\n\(draft)")
  }
}
