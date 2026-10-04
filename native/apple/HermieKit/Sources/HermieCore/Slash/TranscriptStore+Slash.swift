import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

// The slash-command half of `chat-controller.ts`: the gateway's command list kept per chat,
// completions for what is being typed, and running a command with its answer put in the transcript.
//
// A command's answer is one row, the kind a reader cannot miss (`commandRow`): the line the reader
// typed as its title and the whole answer as its body, plain text, at the `quiet` verbosity too.

/// The command list one chat's runtime session answered, and when.
struct CachedSlashCatalog: Sendable {
  var runtimeID: String
  var catalog: SlashCatalog
  /// Milliseconds, the store's clock.
  var loadedAt: Double
}

/// A `commands.catalog` call in flight, shared by everyone who asks while it is.
struct SlashCatalogLoad: Sendable {
  var id: Int
  var runtimeID: String
  var task: Task<Result<SlashCatalog, GatewayRPCFailure>, Never>
}

/// An error out of a gateway call, kept as a value so a task can hand it to every waiter.
struct GatewayRPCFailure: Error, Sendable {
  var error: any Error
}

/// What `complete.slash` answered for a line.
public struct SlashRemoteCompletions: Sendable, Equatable {
  public var items: [SlashSuggestion]
  /// The method that failed, when one did (it is named, never its message, for the list's one line).
  public var failure: String?

  public init(items: [SlashSuggestion] = [], failure: String? = nil) {
    self.items = items
    self.failure = failure
  }
}

/// How long the command list is believed. Commands do not change mid-chat, but skills can be
/// installed on the gateway while the app is open; a list this old is fetched again the next time
/// the reader types a slash (the old one is shown meanwhile, and kept if the fetch fails).
public enum SlashLimits {
  public static let catalogMaxAgeMs: Double = 5 * 60 * 1000
}

extension TranscriptStore {
  // MARK: - The command list

  /// The list as it was last fetched for this chat's session, however old: for a reader who types
  /// a slash and should see something at once.
  public func cachedSlashCatalog(_ key: String) -> SlashCatalog? {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, let cached = slashCatalogs[key],
      cached.runtimeID == runtimeID
    else {
      return nil
    }

    return cached.catalog
  }

  /// Whether the cached list is too old to rely on (or there is none).
  public func slashCatalogIsStale(_ key: String) -> Bool {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, let cached = slashCatalogs[key],
      cached.runtimeID == runtimeID
    else {
      return true
    }

    return now() - cached.loadedAt >= SlashLimits.catalogMaxAgeMs
  }

  /// `commands.catalog`, fetched once per session however many keystrokes ask while it is in the
  /// air, and again once it is `catalogMaxAgeMs` old. A refused fetch is never remembered as an
  /// empty list (one bad answer used to leave every command a prompt for the rest of the session):
  /// the next call tries again, and a fetch that failed after an earlier success answers the
  /// earlier list.
  public func slashCatalog(_ key: String, refresh: Bool = false) async throws -> SlashCatalog {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      throw ChatRuntimeError.notAttached(key)
    }

    if !refresh, !slashCatalogIsStale(key), let cached = cachedSlashCatalog(key) {
      return cached
    }

    let load: SlashCatalogLoad

    if let inFlight = slashCatalogLoads[key], inFlight.runtimeID == runtimeID {
      load = inFlight
    } else {
      nextSlashLoadID += 1
      let link = self.link
      let params: JSONValue = ["session_id": .string(runtimeID), "profile": .string(key)]
      let task = Task<Result<SlashCatalog, GatewayRPCFailure>, Never> {
        do {
          let reply = try await link.requestReply(RPC.CommandsCatalog.name, params: params)
          return .success(SlashCatalog(json: reply.result))
        } catch {
          return .failure(GatewayRPCFailure(error: error))
        }
      }
      load = SlashCatalogLoad(id: nextSlashLoadID, runtimeID: runtimeID, task: task)
      slashCatalogLoads[key] = load
    }

    let outcome = await load.task.value

    if slashCatalogLoads[key]?.id == load.id {
      slashCatalogLoads[key] = nil
    }

    switch outcome {
    case .success(let catalog):
      if chats[key]?.state.runtimeSessionID == runtimeID {
        slashCatalogs[key] = CachedSlashCatalog(runtimeID: runtimeID, catalog: catalog, loadedAt: now())
      }

      return catalog
    case .failure(let failure):
      if let stale = cachedSlashCatalog(key) {
        return stale
      }

      throw failure.error
    }
  }

  /// The road a command takes for this chat, or nil when the gateway has no such command.
  public func slashRoute(_ key: String, name: String) -> SlashRoute? {
    SlashRouting.route(for: name, in: cachedSlashCatalog(key))
  }

  // MARK: - Completions

  /// `complete.slash`: what the gateway would put after what is typed (its own ranking, and what
  /// can follow a command's name: a model, a level). An item's `text` carries no slash and
  /// `replace_from` says how much of the line the answer stands for, so an accepted item rebuilds
  /// the line without doubling anything; without it, a bare command name.
  ///
  /// Never throws: a refusal is an answer (`failure`), because the list says it in a line.
  public func completeSlash(_ key: String, typed: String) async -> SlashRemoteCompletions {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      return SlashRemoteCompletions(failure: RPC.CompleteSlash.name)
    }

    var params: JSONObject = ["text": .string(typed)]

    if slashSessionParam {
      params["session_id"] = .string(runtimeID)
    }

    let reply: RPCReply<JSONValue>

    do {
      reply = try await link.requestReply(RPC.CompleteSlash.name, params: .object(params))
    } catch {
      guard slashSessionParam, Self.refusesSessionID(error) else {
        return SlashRemoteCompletions(failure: RPC.CompleteSlash.name)
      }

      // An older gateway refuses the field it does not know; it is left out from now on.
      slashSessionParam = false

      do {
        reply = try await link.requestReply(RPC.CompleteSlash.name, params: ["text": .string(typed)])
      } catch {
        return SlashRemoteCompletions(failure: RPC.CompleteSlash.name)
      }
    }

    let replaceFrom = reply.result["replace_from"]?.intValue
    let items: [SlashSuggestion] = (reply.result["items"]?.arrayValue ?? []).compactMap { row in
      guard let text = row["text"]?.stringValue, !text.isEmpty || row["display"]?.stringValue != nil else {
        return nil
      }

      let display = row["display"]?.stringValue ?? text
      let isSkill = row["kind"]?.stringValue == "skill"
      // The gateway says how much of the line its answer stands for (a UTF-16 column, as the web
      // reads it); without it, the item is a bare command name.
      let isArgument = (replaceFrom ?? 1) > 1
      let insert: String

      if let replaceFrom {
        insert = Self.utf16Prefix(of: typed, count: replaceFrom) + text
      } else {
        insert = "/\(display.hasPrefix("/") ? String(display.dropFirst()) : display) "
      }

      return SlashSuggestion(
        label: isArgument ? display : (display.hasPrefix("/") ? display : "/\(display)"),
        detail: row["meta"]?.stringValue ?? "",
        kind: isArgument ? .argument : (isSkill ? .skill : .command),
        insert: insert
      )
    }

    return SlashRemoteCompletions(items: items)
  }

  /// The refusal an older gateway gives `complete.slash` for a `session_id` it does not know:
  /// pydantic's "Extra inputs are not permitted", naming the field.
  static func refusesSessionID(_ error: any Error) -> Bool {
    let message = ChatResolver.describe(error)
    return message.contains("session_id") && message.contains("Extra inputs are not permitted")
  }

  static func utf16Prefix(of text: String, count: Int) -> String {
    guard count > 0 else {
      return ""
    }

    return String(decoding: Array(text.utf16.prefix(count)), as: UTF16.self)
  }

  // MARK: - Running a command

  /// Run a slash command and put its answer in the transcript.
  ///
  /// There are two kinds of answer, and the gateway does not label which it is about to give: plain
  /// worker text in `output`, or one of the `command.dispatch` DIRECTIVES, which `slash.exec`
  /// also returns (it reroutes pending-input built-ins and skill bundles into `command.dispatch`
  /// itself and hands the directive straight back). `/queue list` answers `{type: "send",
  /// message: "list"}`: read as output it put the word `list` in the transcript and queued nothing.
  ///
  /// A directive's `message` is model-facing scaffolding and no surface may draw it: a skill
  /// bundle's `message` is the whole expanded skill body, `display` the line the reader is meant to
  /// see.
  ///
  /// Throws what the gateway refused with; the row is for what it ANSWERED.
  @discardableResult
  public func runSlash(_ key: String, command: String) async throws -> SlashOutcome {
    try await dispatchSlash(key, command: command, depth: 0)
  }

  private func dispatchSlash(_ key: String, command: String, depth: Int) async throws -> SlashOutcome {
    let line = SlashLine(parsing: command)

    // Before any round trip: a `/new` that reaches the gateway has already failed, whichever method
    // carries it. Checked at every depth, so an alias that resolves to one of these lands here too.
    if SlashRouting.conversationCommands.contains(line.name) {
      try await startNewConversation(key, argument: line.argument, command: command)
      return SlashOutcome()
    }

    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      throw ChatRuntimeError.notAttached(key)
    }

    if line.name == SlashRouting.statusCommand, slashRoute(key, name: line.name) == .local {
      let report = try await sessionStatus(key, runtimeID: runtimeID)
      showCommandRow(key, runtimeID, command, report)
      return SlashOutcome()
    }

    let result = try await callSlash(key, runtimeID: runtimeID, command: command, line: line)

    if let warning = result["warning"]?.stringValue, !warning.isEmpty {
      showCommandRow(key, runtimeID, command, warning, quietWhenEmpty: true)
    }

    // No `type`: plain worker or plugin text, which is the common case.
    guard let directive = SlashDirective(json: result) else {
      showCommandRow(key, runtimeID, command, result["output"]?.stringValue ?? "")
      return SlashOutcome()
    }

    switch directive {
    case .exec(let output):
      showCommandRow(key, runtimeID, command, output ?? "")
      return SlashOutcome()

    case .alias(let target):
      // One hop only. An alias that points at an alias that points back would otherwise pace the
      // socket until something gave out.
      guard depth == 0, !target.trimmingCharacters(in: .whitespaces).isEmpty else {
        showCommandRow(key, runtimeID, command, "That is an alias the gateway could not follow.")
        return SlashOutcome()
      }

      let slashed = target.hasPrefix("/") ? target : "/\(target)"

      return try await dispatchSlash(
        key, command: line.argument.isEmpty ? slashed : "\(slashed) \(line.argument)", depth: depth + 1)

    case .prefill(let message):
      let notice = result["notice"]?.stringValue ?? ""

      if !notice.isEmpty {
        showCommandRow(key, runtimeID, command, notice)
      }

      // The composer owns its field; the store does not reach into it.
      return SlashOutcome(prefill: message)

    case .send(let message, let display):
      return try await sendDirective(
        key, runtimeID, command, result: result, message: message, display: display)

    case .skill(let message, let display):
      return try await sendDirective(
        key, runtimeID, command, result: result, message: message, display: display)
    }
  }

  /// A `send` or `skill` directive: the gateway wants `message` sent to the model as the reader's
  /// prompt, and the reader shown the invocation instead.
  private func sendDirective(
    _ key: String, _ runtimeID: String, _ command: String, result: JSONValue, message: String?,
    display: String?
  ) async throws -> SlashOutcome {
    // A skill directive carries no notice in the vendored union and a send does; both are read off
    // the raw result, so both shapes reach the reader.
    let notice = (result["notice"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

    if !notice.isEmpty {
      showCommandRow(key, runtimeID, command, notice)
    }

    guard let message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      showCommandRow(key, runtimeID, command, display ?? "Nothing to send.")
      return SlashOutcome()
    }

    // A skill's expansion is no line to park in the queue strip, where the reader would read the
    // whole skill body: it is refused while a turn runs, and run again when the turn is over.
    if display != nil, chats[key]?.state.turn.active == true {
      showCommandRow(
        key, runtimeID, command,
        "This bot is still working on the last turn. Let it finish, or stop it, and run this again.")
      return SlashOutcome()
    }

    // The bubble shows the invocation; the gateway is sent the expansion.
    try await send(key, text: message, display: display ?? command)
    return SlashOutcome()
  }

  /// The gateway method that takes this command: `slash.exec`, or `command.dispatch` for a skill
  /// (the catalogue says which; a gateway whose answer says `command.dispatch` is believed over the
  /// catalogue).
  private func callSlash(_ key: String, runtimeID: String, command: String, line: SlashLine) async throws
    -> JSONValue
  {
    let dispatch = { [link] () async throws -> JSONValue in
      try await link.requestReply(
        RPC.CommandDispatch.name,
        params: [
          "name": .string(line.name), "arg": .string(line.argument), "session_id": .string(runtimeID),
          "profile": .string(key)
        ]
      ).result
    }

    if slashRoute(key, name: line.name) == .dispatch {
      return try await dispatch()
    }

    do {
      return try await link.requestReply(
        RPC.SlashExec.name,
        params: ["session_id": .string(runtimeID), "command": .string(command), "profile": .string(key)]
      ).result
    } catch {
      // The gateway's way of saying "right command, wrong method": matched on the method's name,
      // the part of the sentence that is a protocol fact.
      guard ChatResolver.describe(error).contains("command.dispatch") else {
        throw error
      }

      return try await dispatch()
    }
  }

  /// `session.status`: the gateway's report on this chat's live session (model, tokens, what is
  /// running), as the plain text the TUI shows for `/status`.
  public func sessionStatus(_ key: String) async throws -> String {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      throw ChatRuntimeError.notAttached(key)
    }

    return try await sessionStatus(key, runtimeID: runtimeID)
  }

  private func sessionStatus(_ key: String, runtimeID: String) async throws -> String {
    let reply = try await link.requestReply(
      RPC.SessionStatus.name,
      params: ["session_id": .string(runtimeID), "profile": .string(key)]
    )

    return reply.result["output"]?.stringValue ?? ""
  }

  /// A command's answer in the transcript, if the chat is still the conversation it was run in:
  /// one that moved on meanwhile (a `/new`, another device) would show it under the wrong words.
  private func showCommandRow(
    _ key: String, _ runtimeID: String, _ command: String, _ body: String, quietWhenEmpty: Bool = false
  ) {
    guard chats[key]?.state.runtimeSessionID == runtimeID else {
      return
    }

    let text = body.trimmingCharacters(in: .whitespacesAndNewlines)

    if text.isEmpty, quietWhenEmpty {
      return
    }

    commandRow(key, runtimeID, command, text.isEmpty ? "Ran, with no output." : body)
  }
}
