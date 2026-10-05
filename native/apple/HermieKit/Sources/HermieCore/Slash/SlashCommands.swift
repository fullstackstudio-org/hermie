import Foundation
import HermieProtocol

// The slash-command vocabulary of the composer: how a typed line splits, what the gateway's command
// list (`commands.catalog`) says about each command, which road a command takes, and what comes
// back from running one (`command.dispatch`). Pure values and functions, no gateway: the port of
// `@hermes/shared/slash` and of the catalogue half of `chat-controller.ts`, so the rules can be
// tested without a socket.
//
// Everything the gateway says here (names, descriptions, usage lines, a command's output) is plain
// text. It is never read as Markdown, and none of it is trusted to be a path or an address.

// MARK: - A typed line

/// `/name arg…`, split the way the gateway splits it (`parseSlashCommand`).
public struct SlashLine: Sendable, Equatable {
  /// The command's name: lower-cased, without the slash. Empty for `/`, `/   ` and `/ words`.
  public var name: String
  /// What follows the name, outer whitespace removed; its interior is kept as it was typed.
  public var argument: String

  public init(name: String, argument: String = "") {
    self.name = name
    self.argument = argument
  }

  /// Split a line. The name is lower-cased because every consumer is case-insensitive; the
  /// argument may span lines (`/goal` takes a pasted paragraph).
  public init(parsing text: String) {
    var rest = Substring(text)

    while rest.first == "/" {
      rest.removeFirst()
    }

    guard let first = rest.first, !first.isWhitespace else {
      self.init(name: "")
      return
    }

    let end = rest.firstIndex(where: \.isWhitespace) ?? rest.endIndex
    self.init(
      name: rest[..<end].lowercased(),
      argument: rest[end...].trimmingCharacters(in: .whitespacesAndNewlines)
    )
  }

  /// A slash COMMAND invocation: a `/` first, a bare name, then whitespace or the end. `/usr/local`
  /// (a second slash) and `run /clean` (not first) are prose.
  public static func looksLikeCommand(_ text: String) -> Bool {
    guard text.first == "/" else {
      return false
    }

    for character in text.dropFirst() {
      if character.isWhitespace {
        return true
      }

      if character == "/" {
        return false
      }
    }

    return true
  }
}

/// Which part of a line beginning with `/` the reader is on.
public enum SlashStage: Sendable, Equatable {
  /// Still typing the command's name; `query` is what follows the slash.
  case name(query: String)
  /// The name is done: `command` is it (lower-cased), `typed` the whole line as typed.
  case argument(command: String, typed: String)

  /// The stage of a field's text, or nil when it is not a command being typed: it does not begin
  /// with a slash, or it has a line break (a pasted paragraph that happens to start with `/`).
  public init?(draft: String) {
    guard draft.first == "/", !draft.contains(where: \.isNewline), SlashLine.looksLikeCommand(draft) else {
      return nil
    }

    guard let space = draft.firstIndex(where: \.isWhitespace) else {
      self = .name(query: String(draft.dropFirst()))
      return
    }

    let command = String(draft[draft.index(after: draft.startIndex)..<space]).lowercased()

    // `/ words` is a sentence that starts with a slash, not a command with no name.
    guard !command.isEmpty else {
      return nil
    }

    self = .argument(command: command, typed: draft)
  }
}

// MARK: - Which road a command takes

/// Which gateway method takes a command.
///
/// `slash.exec` runs worker commands and refuses a skill outright (`4018 skill command: use
/// command.dispatch`), so a skill goes to `command.dispatch`. `local` is this client's own: the
/// commands that start a conversation (the gateway's `/new` would rotate a worker's session, not
/// the one this app is bound to) and `/status` on a gateway whose catalogue does not list it.
public enum SlashRoute: Sendable, Equatable {
  case dispatch
  case exec
  case local
}

public enum SlashRouting {
  /// The commands that start a fresh conversation, which the app runs itself.
  public static let conversationCommands: Set<String> = ["new", "reset", "clear"]

  /// `/status`: the report on a live session. A gateway whose catalogue lists it answers it through
  /// `slash.exec`; one whose catalogue does not is asked with `session.status` instead, so the
  /// command never goes out as a prompt to the bot.
  public static let statusCommand = "status"

  /// The road for `name`, or nil when the gateway has no such command (the line is then a prompt).
  /// The conversation commands answer yes whatever the catalogue says, before it has arrived too:
  /// sent as a prompt `/new` would ask the MODEL to start a new session.
  public static func route(for name: String, in catalog: SlashCatalog?) -> SlashRoute? {
    let wanted = name.lowercased()

    if conversationCommands.contains(wanted) {
      return .local
    }

    guard !wanted.isEmpty, let catalog else {
      return nil
    }

    return catalog.route(for: wanted) ?? (wanted == statusCommand ? .local : nil)
  }
}

// MARK: - The gateway's command list

/// What a command takes after its name (`ArgumentMode`).
public enum SlashArgumentMode: String, Sendable, Equatable {
  case options
  case text
  case mixed
}

/// One command or skill the gateway offers this bot.
public struct SlashCommand: Sendable, Equatable, Identifiable {
  public enum Kind: Sendable, Equatable {
    case command
    case skill
  }

  /// Lower-cased, without the slash.
  public var name: String
  /// What it does, without the usage line the gateway appends to it.
  public var summary: String
  /// What it takes after its name (`[model]`, `[low|medium|high]`), when the gateway says.
  public var usage: String?
  public var argumentMode: SlashArgumentMode?
  /// The words that may follow it (`/queue list`).
  public var subcommands: [String]
  /// Other names that run the same command (`/q` for `/queue`).
  public var aliases: [String]
  public var kind: Kind
  /// How often the bot used the skill, which ranks skills in a long list.
  public var usageCount: Int

  public var id: String { name }

  public init(
    name: String,
    summary: String = "",
    usage: String? = nil,
    argumentMode: SlashArgumentMode? = nil,
    subcommands: [String] = [],
    aliases: [String] = [],
    kind: Kind = .command,
    usageCount: Int = 0
  ) {
    self.name = name
    self.summary = summary
    self.usage = usage
    self.argumentMode = argumentMode
    self.subcommands = subcommands
    self.aliases = aliases
    self.kind = kind
    self.usageCount = usageCount
  }

  /// Whether anything may follow the name.
  public var takesArgument: Bool {
    usage != nil || argumentMode != nil || !subcommands.isEmpty
  }
}

/// One line of the completion list: what is listed, and what the field holds once it is taken.
public struct SlashSuggestion: Sendable, Equatable, Identifiable {
  public enum Kind: Sendable, Equatable {
    case command
    case skill
    /// A word for the argument (a model, a level, a subcommand), not a command.
    case argument
    /// One of the person's reusable prompts (NX-13): taking it puts its text in the field, after the
    /// form for its fields when it has any, and never runs a command.
    case prompt
  }

  /// What is listed: `/model`, or `medium` for an argument.
  public var label: String
  /// The argument hint (`[model]`) for a command that takes one.
  public var hint: String?
  /// What the gateway says it is, in its own words.
  public var detail: String
  public var kind: Kind
  /// The alias the reader typed when it is not the command's own name (`q` for `/queue`).
  public var alias: String?
  /// What the field holds once this is taken (empty for a prompt, which is put in by `promptID`).
  public var insert: String
  /// The prompt this line stands for, when it is one.
  public var promptID: String?

  /// Unique within one list: two lines never insert the same text, and a prompt has its own id.
  public var id: String { promptID.map { "prompt:" + $0 } ?? insert }

  public init(
    label: String,
    hint: String? = nil,
    detail: String = "",
    kind: Kind = .command,
    alias: String? = nil,
    insert: String,
    promptID: String? = nil
  ) {
    self.label = label
    self.hint = hint
    self.detail = detail
    self.kind = kind
    self.alias = alias
    self.insert = insert
    self.promptID = promptID
  }
}

/// What the line under the list says about the command being filled in.
public struct SlashArgumentHint: Sendable, Equatable {
  /// `/model`.
  public var command: String
  /// `[model]`, when the gateway says.
  public var usage: String?
  public var summary: String
  public var mode: SlashArgumentMode?
}

/// `commands.catalog`: every command and skill this bot has, kept per chat.
///
/// Upstream writes every key WITH its slash (`/model`) and the pairs as `[name, description]`, the
/// description ending in `(usage: /model [model])` for a command that takes arguments. A skill is a
/// key of `skills` as well as a pair. Nothing here trusts that: names are read with or without the
/// slash, and a payload with parts missing is a smaller catalogue, not an error.
public struct SlashCatalog: Sendable, Equatable {
  /// Commands in the gateway's order, then skills, the most used first.
  public private(set) var commands: [SlashCommand]
  /// A warning the gateway attached (a skill that failed discovery), for diagnostics.
  public private(set) var warning: String
  /// Every name that runs something, aliases included, to the command's own name.
  private var names: [String: String]

  public init(commands: [SlashCommand], warning: String = "") {
    var ordered = commands.filter { $0.kind == .command }
    ordered += commands.filter { $0.kind == .skill }
    self.commands = ordered
    self.warning = warning
    var names: [String: String] = [:]

    for command in ordered {
      names[command.name] = command.name

      for alias in command.aliases where names[alias] == nil {
        names[alias] = command.name
      }
    }

    self.names = names
  }

  public init(json: JSONValue) {
    func bare(_ raw: String) -> String {
      var name = Substring(raw.trimmingCharacters(in: .whitespacesAndNewlines))

      while name.first == "/" {
        name.removeFirst()
      }

      return name.lowercased()
    }

    let skillRows = json["skills"]?.objectValue ?? [:]
    var skillUsage: [String: Int] = [:]

    for (key, value) in skillRows {
      skillUsage[bare(key)] = value["usage"]?.intValue ?? 0
    }

    var modes: [String: SlashArgumentMode] = [:]

    for (key, value) in json["commands"]?.objectValue ?? [:] {
      if let raw = value["argument_mode"]?.stringValue, let mode = SlashArgumentMode(rawValue: raw) {
        modes[bare(key)] = mode
      }
    }

    // alias → the command's own name; every key that names itself is not an alias.
    var canon: [String: String] = [:]

    for (key, value) in json["canon"]?.objectValue ?? [:] {
      if let target = value.stringValue {
        canon[bare(key)] = bare(target)
      }
    }

    var subcommands: [String: [String]] = [:]

    for (key, value) in json["sub"]?.objectValue ?? [:] {
      subcommands[bare(key)] = (value.arrayValue ?? []).compactMap(\.stringValue)
    }

    // The flat `pairs` first; a gateway that sent only `categories` still lists everything.
    var rows: [[JSONValue]] = (json["pairs"]?.arrayValue ?? []).compactMap(\.arrayValue)

    if rows.isEmpty {
      for category in json["categories"]?.arrayValue ?? [] {
        rows += (category["pairs"]?.arrayValue ?? []).compactMap(\.arrayValue)
      }
    }

    var listed: [SlashCommand] = []
    var seen: Set<String> = []

    func add(name: String, description: String) {
      guard !name.isEmpty, seen.insert(name).inserted else {
        return
      }

      let parts = Self.split(description: description, name: name)
      let isSkill = skillUsage[name] != nil

      listed.append(
        SlashCommand(
          name: name,
          summary: parts.summary,
          usage: parts.usage,
          argumentMode: modes[name],
          subcommands: subcommands[name] ?? [],
          kind: isSkill ? .skill : .command,
          usageCount: skillUsage[name] ?? 0
        ))
    }

    for row in rows {
      add(name: bare(row.first?.stringValue ?? ""), description: row.dropFirst().first?.stringValue ?? "")
    }

    // A command the catalogue lists only under `commands`, and a skill only under `skills`.
    for key in (json["commands"]?.objectValue ?? [:]).keys.sorted() {
      let name = bare(key)

      if canon[name] == nil || canon[name] == name {
        add(name: name, description: "")
      }
    }

    for key in skillRows.keys.sorted() {
      add(name: bare(key), description: "")
    }

    // Aliases, now that every command they could belong to is listed.
    for (alias, target) in canon.sorted(by: { $0.key < $1.key }) where alias != target {
      if let index = listed.firstIndex(where: { $0.name == target }), !listed[index].aliases.contains(alias) {
        listed[index].aliases.append(alias)
      }
    }

    // Skills, the most used first; the gateway's own order breaks a tie.
    let order = Dictionary(uniqueKeysWithValues: listed.enumerated().map { ($1.name, $0) })
    var skills = listed.filter { $0.kind == .skill }
    skills.sort {
      $0.usageCount != $1.usageCount ? $0.usageCount > $1.usageCount : (order[$0.name] ?? 0) < (order[$1.name] ?? 0)
    }

    self.init(
      commands: listed.filter { $0.kind == .command } + skills,
      warning: json["warning"]?.stringValue ?? ""
    )
  }

  /// A description and the usage line the gateway appends to it: `Switch model (usage: /model
  /// [model])` is the summary `Switch model` and the usage `[model]`. A usage that is only the
  /// command's own name says nothing and is dropped.
  static func split(description: String, name: String) -> (summary: String, usage: String?) {
    let marker = "(usage: "
    let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)

    guard trimmed.hasSuffix(")"), let range = trimmed.range(of: marker, options: .backwards) else {
      return (trimmed, nil)
    }

    var usage = trimmed[range.upperBound..<trimmed.index(before: trimmed.endIndex)]
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let summary = trimmed[..<range.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)

    if usage.hasPrefix("/") {
      let head = usage.prefix { !$0.isWhitespace }
      usage = usage.dropFirst(head.count).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    return (summary, usage.isEmpty ? nil : usage)
  }

  // MARK: Reading it

  /// The command by name or alias (case does not matter, a slash is ignored).
  public func command(named raw: String) -> SlashCommand? {
    let name = SlashLine(parsing: raw).name
    guard let own = names[name] else {
      return nil
    }

    return commands.first { $0.name == own }
  }

  /// The road for a name, or nil when the catalogue has no such command.
  public func route(for name: String) -> SlashRoute? {
    guard let command = command(named: name) else {
      return nil
    }

    return command.kind == .skill ? .dispatch : .exec
  }

  /// The commands whose name (or alias) matches what follows the slash, the best first: the exact
  /// name, names that begin with it, aliases that do, and names that contain it. When no name does,
  /// from two letters on, the commands whose description does (`/effort` finds `/reasoning`): a
  /// description is only a fallback, or `/mo` would list every command that mentions a mode.
  /// An empty query is every command.
  public func suggestions(matching query: String, limit: Int = 50) -> [SlashSuggestion] {
    let wanted = query.lowercased()
    var scored: [(score: Int, order: Int, suggestion: SlashSuggestion)] = []

    func suggestion(_ command: SlashCommand, alias: String? = nil) -> SlashSuggestion {
      SlashSuggestion(
        label: "/\(command.name)",
        hint: command.usage,
        detail: command.summary,
        kind: command.kind == .skill ? .skill : .command,
        alias: alias.map { "/\($0)" },
        insert: "/\(command.name) "
      )
    }

    for (order, command) in commands.enumerated() {
      if wanted.isEmpty || command.name == wanted {
        scored.append((0, order, suggestion(command)))
      } else if command.name.hasPrefix(wanted) {
        scored.append((1, order, suggestion(command)))
      } else if let found = command.aliases.first(where: { $0.hasPrefix(wanted) }) {
        scored.append((2, order, suggestion(command, alias: found)))
      } else if command.name.contains(wanted) {
        scored.append((3, order, suggestion(command)))
      }
    }

    if scored.isEmpty, wanted.count >= 2 {
      for (order, command) in commands.enumerated() where command.summary.lowercased().contains(wanted) {
        scored.append((4, order, suggestion(command)))
      }
    }

    scored.sort { $0.score != $1.score ? $0.score < $1.score : $0.order < $1.order }

    return scored.prefix(limit).map(\.suggestion)
  }

  /// What the line under the list says for the command being filled in, or nil when it takes
  /// nothing (or is not one of this catalogue's).
  public func argumentHint(for name: String) -> SlashArgumentHint? {
    guard let command = command(named: name), command.takesArgument else {
      return nil
    }

    return SlashArgumentHint(
      command: "/\(command.name)",
      usage: command.usage,
      summary: command.summary,
      mode: command.argumentMode
    )
  }

  /// The subcommands of `name` that begin with what is typed after it: `/queue l` offers `list`.
  public func subcommandSuggestions(for name: String, argument: String) -> [SlashSuggestion] {
    guard let command = command(named: name) else {
      return []
    }

    let wanted = argument.lowercased()

    return command.subcommands
      .filter { wanted.isEmpty || $0.lowercased().hasPrefix(wanted) }
      .map { SlashSuggestion(label: $0, kind: .argument, insert: "/\(command.name) \($0) ") }
  }
}

// MARK: - What running a command left behind

/// What a slash command left for the composer that ran it.
public struct SlashOutcome: Sendable, Equatable {
  /// A `prefill` directive's text: for the field, not the transcript.
  public var prefill: String?

  public init(prefill: String? = nil) {
    self.prefill = prefill
  }
}

/// A `command.dispatch` answer, which `slash.exec` also gives (upstream reroutes pending-input
/// built-ins and skill bundles into `command.dispatch` itself and hands the directive straight
/// back). The port of `parseCommandDispatch`: a payload with a missing required field, or a type
/// this build does not know, is not a directive, and is read as plain output.
enum SlashDirective: Sendable, Equatable {
  case exec(output: String?)
  case alias(target: String)
  case prefill(message: String)
  case send(message: String, display: String?)
  case skill(message: String?, display: String?)

  init?(json: JSONValue) {
    guard case .object(let row) = json else {
      return nil
    }

    func string(_ key: String) -> String? { row[key]?.stringValue }

    switch row["type"]?.stringValue {
    case "exec", "plugin":
      self = .exec(output: string("output"))
    case "alias":
      guard let target = string("target") else { return nil }
      self = .alias(target: target)
    case "prefill":
      guard let message = string("message") else { return nil }
      self = .prefill(message: message)
    case "send":
      guard let message = string("message") else { return nil }
      self = .send(message: message, display: string("display"))
    case "skill":
      guard string("name") != nil else { return nil }
      self = .skill(message: string("message"), display: string("display"))
    default:
      return nil
    }
  }
}
