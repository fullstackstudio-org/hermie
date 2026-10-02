import HermieProtocol

// A model id, written the way its maker writes it (`model-name.ts`).
//
// A gateway reports wire ids — `claude-haiku-4-5-20251001`,
// `openrouter/anthropic/claude-opus-5`, `qwen3-235b` — and every surface that
// showed one showed it raw: the usage line under a reply, the options sheet's
// Model row, the picker, a cron's detail. They are not wrong, they are just not
// what anybody calls these things, and three of them side by side in a picker is
// a wall of hyphens.
//
// ## What this is NOT
//
// It is not a catalogue. A table of known ids would be out of date by the next
// release and silently wrong for every self-hosted model, so this is a set of
// PATTERNS: a family word gets the spelling its maker uses, a run of version
// numbers joins with dots, a parameter count gets a capital B, a date suffix is
// dropped, and anything it does not recognise is Title-Cased with its numbers
// left alone. An id it has never seen still comes out readable, which is the
// property a table cannot have.
//
// The wire id is never changed and never thrown away: `parseModelID` hands it
// back, and the two places a reader might need to type or paste one — the model
// picker and the connection debug screen — print it underneath the name.
//
// ## The provider is a separate answer
//
// `anthropic/claude-opus-5` and `openrouter/anthropic/claude-opus-5` are the same
// model reached two ways, and the routing is not part of the name. Everything
// before the last `/` is the provider, and GitLab's `duo-chat-` prefix is one too
// — it is a namespace written with a hyphen because that provider has no slash in
// its ids.
//
// The TypeScript patterns here have no `u` flag; all are ASCII, rewritten for ICU
// with `\d` as `[0-9]` and `$` as `\z`.

/// A model id, taken apart. The name is never blank unless the id was. `ParsedModelId`.
public struct ParsedModelID: TranscriptJSONCodable, Hashable {
  /// The id exactly as it arrived.
  public var id: String
  /// What to show a reader.
  public var name: String
  /// The route the id named, or nil: `openai`, `openrouter/anthropic`, `duo-chat`.
  /// Written as `null` when absent, as the TypeScript does.
  public var provider: String?

  public init(id: String, name: String, provider: String?) {
    self.id = id
    self.name = name
    self.provider = provider
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ParsedModelId")
    id = try reader.required("id")
    name = try reader.required("name")
    provider = reader.nullable("provider")
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("id", id)
    writer.set("name", name)
    writer.setNullable("provider", provider)
    return writer.json
  }
}

/// Families, and the spelling each one's maker uses.
///
/// Only entries whose casing cannot be derived are here. `opus`, `sonnet`, `pro`
/// and `flash` are absent on purpose: Title Case already gets them right, and a
/// list that contains what it does not need is a list nobody trusts.
private let families: [String: String] = [
  "anthropic": "Anthropic",
  "chatgpt": "ChatGPT",
  "claude": "Claude",
  "codellama": "CodeLlama",
  "codestral": "Codestral",
  "deepseek": "DeepSeek",
  "doubao": "Doubao",
  "ernie": "ERNIE",
  "gemini": "Gemini",
  "gemma": "Gemma",
  "glm": "GLM",
  "gpt": "GPT",
  "grok": "Grok",
  "hunyuan": "Hunyuan",
  "jamba": "Jamba",
  "kimi": "Kimi",
  "llama": "Llama",
  "minimax": "MiniMax",
  "ministral": "Ministral",
  "mistral": "Mistral",
  "mixtral": "Mixtral",
  "openai": "OpenAI",
  "qwen": "Qwen",
  "qwq": "QwQ",
  "sonar": "Sonar",
  "yi": "Yi"
]

/// Words that are an acronym rather than a word, and are not a family.
private let acronyms: [String: String] = [
  "ai": "AI",
  "api": "API",
  "hd": "HD",
  "moe": "MoE",
  "oss": "OSS",
  "tts": "TTS",
  "vl": "VL"
]

/// Small words that stay small when they are not the first thing said.
private let joiners: Set<String> = ["and", "for", "of", "the", "with"]

/// Families whose version rides on a hyphen rather than a space.
///
/// `GPT-5.5` and `GLM-4.6`, because that is how OpenAI and Zhipu write them —
/// against `Claude Opus 5` and `Gemini 2.5 Pro`, which are spaced. It is two
/// entries rather than a rule because there is no rule: it is a house style per
/// house.
private let hyphenated: Set<String> = ["glm", "gpt"]

/// GitLab's Duo writes its provider as a prefix on the id, with no slash.
private let prefixes: [(String, String)] = [("duo-chat-", "duo-chat")]

enum ModelNamePatterns {
  /// `/[\s\-_:]+/`
  static let separators = JSRegExp("[" + JSPattern.spaceSet + #"\-_:]+"#)
  /// `o1`, `o3`, `o4-mini`: OpenAI's reasoning line is lower case, deliberately. `/^o\d+$/`
  static let oSeries = JSRegExp(#"^o[0-9]+\z"#)
  /// `4`, `4.6`, `2.5`, `4o` — something that reads as a version rather than a word.
  /// `/^\d+(\.\d+)*[a-z]?$/`
  static let versionish = JSRegExp(#"^[0-9]+(\.[0-9]+)*[a-z]?\z"#)
  /// `70b`, `8x7b`, `1.5b` — a parameter count. `/^(\d+(\.\d+)?(x\d+(\.\d+)?)?)b$/`
  static let parameters = JSRegExp(#"^([0-9]+(\.[0-9]+)?(x[0-9]+(\.[0-9]+)?)?)b\z"#)
  /// `32k`, `128k` — a context window. `/^(\d+)k$/`
  static let context = JSRegExp(#"^([0-9]+)k\z"#)
  /// `v3`, `r1`, `k2.5` — a letter and a number that belong together.
  /// `/^([a-z]+)(\d+(\.\d+)*)$/`
  static let letterVersion = JSRegExp(#"^([a-z]+)([0-9]+(\.[0-9]+)*)\z"#)
  /// A whole number, or a dotted one. `/^\d+(\.\d+)*$/`
  static let number = JSRegExp(#"^[0-9]+(\.[0-9]+)*\z"#)
  /// `20251001`, and only in this century — `2411` is a Mistral version, not a date.
  /// `/^(19|20)\d{6}$/`
  static let dateStamp = JSRegExp(#"^(19|20)[0-9]{6}\z"#)
  /// `/^(19|20)\d{2}$/`
  static let year = JSRegExp(#"^(19|20)[0-9]{2}\z"#)
  /// `/^\d{2}$/`
  static let twoDigits = JSRegExp(#"^[0-9]{2}\z"#)
}

/// The whole point, in one call: what to show for this id.
public func prettyModelName(_ id: String) -> String {
  parseModelID(id).name
}

/// `parseModelId`.
public func parseModelID(_ id: String) -> ParsedModelID {
  let trimmed = JS.trim(id)

  if trimmed.isEmpty {
    return ParsedModelID(id: id, name: "", provider: nil)
  }

  let route = JS.split(trimmed, "/")
  var model = route.last ?? trimmed
  var providers = Array(route.dropLast())

  for (prefix, provider) in prefixes where JS.hasPrefix(JS.lower(model), prefix) {
    model = JS.slice(model, JS.length(prefix))
    providers.append(provider)
    break
  }

  let tokens = dropDateSuffix(ModelNamePatterns.separators.split(model).filter { !$0.isEmpty })
  let joined = joinVersionRuns(tokens)
  let name = assemble(joined)

  return ParsedModelID(
    id: id,
    // A name is never empty: an id made of nothing but separators still has to
    // say something, and the only honest thing left to say is the id itself.
    name: name.isEmpty ? trimmed : name,
    provider: providers.isEmpty ? nil : providers.joined(separator: "/")
  )
}

/// Drop the release date a provider pins a snapshot with.
///
/// Both spellings: `-20251001` in one token, and `-2025-10-01` in three. What is
/// NOT dropped is a bare four-digit number — `mistral-large-2411` is a version,
/// and a rule that cannot tell them apart would eat it.
private func dropDateSuffix(_ tokens: [String]) -> [String] {
  var rest = tokens
  let last = rest.last ?? ""

  if rest.count > 1 && ModelNamePatterns.dateStamp.test(last) {
    rest.removeLast()

    return rest
  }

  if rest.count > 3 && ModelNamePatterns.twoDigits.test(last)
    && ModelNamePatterns.twoDigits.test(rest[rest.count - 2])
    && ModelNamePatterns.year.test(rest[rest.count - 3])
  {
    rest.removeLast(3)
  }

  return rest
}

/// `4`, `6` → `4.6`.
///
/// A maker who writes `claude-sonnet-4-6` and a maker who writes
/// `claude-sonnet-4.6` mean the same model, and a reader should not have to know
/// which gateway they are on to recognise it. Only a RUN of bare numbers joins,
/// so `grok-code-fast-1` keeps its single one and `llama-3.1-70b` is left alone.
private func joinVersionRuns(_ tokens: [String]) -> [String] {
  var out: [String] = []

  for token in tokens {
    if let previous = out.last, ModelNamePatterns.number.test(token), ModelNamePatterns.number.test(previous) {
      out[out.count - 1] = "\(previous).\(token)"

      continue
    }

    out.append(token)
  }

  return out
}

private func assemble(_ tokens: [String]) -> String {
  if tokens.isEmpty {
    return ""
  }

  let words = tokens.enumerated().map { displayWord($0.element, $0.offset) }
  let family = JS.lower(tokens[0])
  let second = tokens.count > 1 ? tokens[1] : ""

  if hyphenated.contains(family) && words.count > 1 && ModelNamePatterns.versionish.test(second) {
    return (["\(words[0])-\(words[1])"] + words.dropFirst(2)).joined(separator: " ")
  }

  return words.joined(separator: " ")
}

private func displayWord(_ token: String, _ index: Int) -> String {
  let lower = JS.lower(token)

  if ModelNamePatterns.oSeries.test(lower) {
    return lower
  }

  if let family = families[lower] {
    return family
  }

  if let acronym = acronyms[lower] {
    return acronym
  }

  if index > 0 && joiners.contains(lower) {
    return lower
  }

  if let parameters = ModelNamePatterns.parameters.exec(lower) {
    return "\(parameters[1] ?? "")B"
  }

  if let context = ModelNamePatterns.context.exec(lower) {
    return "\(context[1] ?? "")K"
  }

  if ModelNamePatterns.number.test(lower) {
    return lower
  }

  if let letterVersion = ModelNamePatterns.letterVersion.exec(lower) {
    let letters = letterVersion[1] ?? ""
    let digits = letterVersion[2] ?? ""
    // `qwen3` is a family that has grown a number; `k3` and `v3` are a letter
    // standing for one. Both keep the number welded on, which is how they are
    // written, and only the letters differ in how they are spelled.
    let head = families[letters] ?? (JS.length(letters) == 1 ? JS.upper(letters) : capitalise(letters))

    return "\(head)\(digits)"
  }

  return capitalise(token)
}

/// First letter up, everything after it left exactly as the id wrote it.
private func capitalise(_ word: String) -> String {
  JS.capitaliseFirstUnit(word)
}

extension ParsedModelID: JSONField {}
