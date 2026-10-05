import Foundation
import HermieProtocol

/// Where a prompt is offered: in every chat, or in one bot's.
public enum PromptScope: Sendable, Hashable {
  case global
  case bot(String)

  /// The bot's name for a bot scope, nil for the global one.
  public var botName: String? {
    if case .bot(let name) = self { name } else { nil }
  }
}

/// One reusable prompt: a title, the text with its `{{fields}}`, and the bot it belongs to (none for
/// a global one). `carried` is every other key of the entry as it was read, written back untouched.
public struct Prompt: Sendable, Hashable, Identifiable {
  public var id: String
  public var title: String
  public var text: String
  /// The bot this prompt is for; nil is offered in every chat.
  public var bot: String?
  /// Keys of the entry this build does not know, kept so that editing a prompt leaves them alone.
  public var carried: JSONObject

  public init(id: String, title: String, text: String, bot: String? = nil, carried: JSONObject = [:]) {
    self.id = id
    self.title = title
    self.text = text
    self.bot = bot
    self.carried = carried.filter { !PromptLibrary.knownKeys.contains($0.key) }
  }

  public var scope: PromptScope { bot.map(PromptScope.bot) ?? .global }

  /// The fields the text asks for, in order.
  public var fields: [String] { PromptTemplate.fields(in: text) }

  /// The text sent with `values` put in.
  public func filled(with values: [String: String]) -> String {
    PromptTemplate.fill(text, with: values)
  }
}

/**
 The reusable prompts as the app section carries them, and the pure edits of them (NX-13).

 `prompts` is an array in the person's own app section (`hermie-app:<user>`), in the order the
 person arranged them: one object per prompt, `{ "id", "title", "text", "bot"? }`. It rides the same
 `ui_meta` as the chat list, so it follows the person to every device on the gateway, and it is
 additive in every sense the ADR asks for: a build that does not know it carries it as it came (the frozen Expo app, which rebuilds the section from fixed keys, is the exception), the
 web client (`native/web`) carries it and reads nothing of it, and no `v` is bumped.

 - **Reading is forgiving, writing is careful.** An entry that is not an object, or lacks a text
   `id`, `title` or `text`, or repeats an id, is not offered, but it stays in the array where it
   is, so what a newer build wrote is not lost by this one saving. Every key an entry has beyond the
   four is kept on that entry.
 - **Order.** The array is the order. A scope's own order (the global prompts, one bot's) is the
   order of its entries in the array; moving one inside its scope never moves an entry of another.
 - **Limits** keep the section small: `maxPrompts` entries, a title of `titleLimit` characters, a
   text of `textLimit`. An edit past a limit is cut or refused, never written half.
 - **No prompt is ever empty of words.** A prompt needs a title and a text; the title falls back to
   the first line of the text.
 - **Removing the last one** leaves an empty array and not a missing field: a missing one would
   read, on a device that holds prompts, as "nothing was said", and keep them.
 */
public enum PromptLibrary {
  public static let maxPrompts = 100
  public static let titleLimit = 60
  public static let textLimit = 4000
  public static let idLimit = 64

  /// The keys of an entry this build reads and writes itself.
  static let knownKeys: Set<String> = ["id", "title", "text", "bot"]

  // MARK: Reading

  /// The prompts of an app section, in order, those that read as prompts, within the limits: it came off a
  /// wire another build (or somebody on the gateway) wrote, so only the first `maxPrompts` are offered, a
  /// title longer than `titleLimit` or a text longer than `textLimit` is cut, and an id is at most
  /// `idLimit` long. The raw entries are not touched: they are carried as they came until one is edited.
  public static func prompts(in app: JSONObject?) -> [Prompt] {
    var seen = Set<String>()
    var found: [Prompt] = []

    for entry in entries(app) {
      guard found.count < maxPrompts else {
        break
      }

      guard let prompt = prompt(entry), seen.insert(prompt.id).inserted else {
        continue
      }

      found.append(prompt)
    }

    return found
  }

  /// How many entries the field holds, prompts or not: what the room for a new one is counted in.
  public static func entryCount(in app: JSONObject?) -> Int {
    entries(app).count
  }

  /// One entry as a prompt, or nil when it is not one.
  static func prompt(_ value: JSONValue) -> Prompt? {
    guard case .object(let entry) = value, let id = entry["id"]?.stringValue, !id.isEmpty, id.count <= idLimit,
      let title = entry["title"]?.stringValue, let text = entry["text"]?.stringValue
    else {
      return nil
    }

    let bot = entry["bot"]?.stringValue.flatMap { $0.isEmpty || $0.count > idLimit * 2 ? nil : $0 }

    // Cut by scalars, not characters: one character can be a thousand combining marks. A title is one line.
    let line = title.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""

    return Prompt(
      id: id, title: scalars(line, upTo: titleLimit), text: scalars(text, upTo: textLimit), bot: bot, carried: entry)
  }

  private static func entries(_ app: JSONObject?) -> [JSONValue] {
    if case .array(let entries)? = app?[UIMetaField.prompts] { entries } else { [] }
  }

  // MARK: Cleaning

  /// At most `limit` Unicode scalars of `text`. A character may be any number of scalars (a letter with a
  /// run of combining marks), so a limit counted in characters is no limit on size.
  static func scalars(_ text: String, upTo limit: Int) -> String {
    var view = String.UnicodeScalarView()

    view.append(contentsOf: text.unicodeScalars.prefix(limit))
    return String(view)
  }

  /// A title as it would be stored: trimmed, one line, cut. Empty is "no title".
  public static func cleaned(title: String) -> String {
    let line = title.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""

    return scalars(line.trimmingCharacters(in: .whitespacesAndNewlines), upTo: titleLimit)
  }

  /// A text as it would be stored: the ends trimmed, cut. Empty is "no text".
  public static func cleaned(text: String) -> String {
    scalars(text.trimmingCharacters(in: .whitespacesAndNewlines), upTo: textLimit)
  }

  /// The title and text a prompt would be stored with, or nil when it has no words. A missing title
  /// is the text's first words.
  public static func cleaned(title: String, text: String) -> (title: String, text: String)? {
    let text = cleaned(text: text)

    guard !text.isEmpty else {
      return nil
    }

    var title = cleaned(title: title)

    if title.isEmpty {
      title = cleaned(title: text)
    }

    return (title, text)
  }

  // MARK: Writing

  /// Add a prompt at the end. False, with nothing written, when it has no words, its id is taken, or
  /// the section already holds `maxPrompts`.
  @discardableResult
  public static func add(_ prompt: Prompt, in app: inout JSONObject) -> Bool {
    guard let words = cleaned(title: prompt.title, text: prompt.text), !prompt.id.isEmpty else {
      return false
    }

    var list = entries(app)

    guard list.count < maxPrompts, !list.contains(where: { identifier($0) == prompt.id }) else {
      return false
    }

    var stored = prompt
    stored.title = words.title
    stored.text = words.text
    list.append(.object(entry(of: stored, over: [:])))
    app[UIMetaField.prompts] = .array(list)
    return true
  }

  /// Change a prompt's title, text and bot, leaving every other key of its entry as it is and the
  /// entry where it is. False when there is no such prompt or the new words are empty.
  @discardableResult
  public static func update(_ prompt: Prompt, in app: inout JSONObject) -> Bool {
    guard let words = cleaned(title: prompt.title, text: prompt.text) else {
      return false
    }

    var list = entries(app)

    guard let index = list.firstIndex(where: { identifier($0) == prompt.id }), case .object(let held) = list[index]
    else {
      return false
    }

    var stored = prompt
    stored.title = words.title
    stored.text = words.text
    list[index] = .object(entry(of: stored, over: held))
    app[UIMetaField.prompts] = .array(list)
    return true
  }

  /// Remove a prompt. False when there is none with that id.
  @discardableResult
  public static func remove(id: String, in app: inout JSONObject) -> Bool {
    var list = entries(app)

    guard let index = list.firstIndex(where: { identifier($0) == id }) else {
      return false
    }

    list.remove(at: index)
    app[UIMetaField.prompts] = .array(list)
    return true
  }

  /// Move a prompt to place `index` among the prompts of its scope (0 is first; past the end is
  /// last). The entries of other scopes, and the ones that are not prompts at all, do not move.
  @discardableResult
  public static func move(id: String, toIndex index: Int, in app: inout JSONObject) -> Bool {
    var list = entries(app)
    let readable = readablePrompts(list)

    guard let scope = readable.first(where: { $0.prompt.id == id })?.prompt.scope else {
      return false
    }

    // The slots of the moved prompt's scope, in order, and who holds each now.
    let members = readable.filter { $0.prompt.scope == scope }

    guard let from = members.firstIndex(where: { $0.prompt.id == id }) else {
      return false
    }

    let to = min(max(index, 0), members.count - 1)

    guard from != to else {
      return false
    }

    var order = members
    let moved = order.remove(at: from)
    order.insert(moved, at: to)

    // The same slots, refilled in the new order.
    for (slot, member) in zip(members.map(\.slot), order) {
      list[slot] = member.value
    }

    app[UIMetaField.prompts] = .array(list)
    return true
  }

  /// The entries that read as prompts (the first of an id), with the array slot each is in.
  private static func readablePrompts(_ list: [JSONValue]) -> [(slot: Int, prompt: Prompt, value: JSONValue)] {
    var seen = Set<String>()
    var found: [(slot: Int, prompt: Prompt, value: JSONValue)] = []

    for (slot, value) in list.enumerated() {
      if let prompt = prompt(value), seen.insert(prompt.id).inserted {
        found.append((slot, prompt, value))
      }
    }

    return found
  }

  // MARK: Internals

  private static func identifier(_ value: JSONValue) -> String? {
    value.objectValue?["id"]?.stringValue
  }

  /// The entry for a prompt, over the keys an older write of it already had.
  private static func entry(of prompt: Prompt, over held: JSONObject) -> JSONObject {
    var entry = held.filter { !knownKeys.contains($0.key) }

    for (key, value) in prompt.carried where entry[key] == nil {
      entry[key] = value
    }

    entry["id"] = .string(prompt.id)
    entry["title"] = .string(prompt.title)
    entry["text"] = .string(prompt.text)

    if let bot = prompt.bot, !bot.isEmpty {
      entry["bot"] = .string(bot)
    }

    return entry
  }
}

/// New prompts' ids.
public enum PromptID {
  /// A fresh id: a letter and twelve hex digits.
  public static func make() -> String {
    "p" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12)
  }
}
