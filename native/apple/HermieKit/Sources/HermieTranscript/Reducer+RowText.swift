import Foundation
import HermieProtocol

// The `rows-to-items.ts` helpers the reducer calls
// ================================================
//
// `applyResumeSnapshot`, `beginLocalTurn`, `beginSteer` and `dropSteer` read
// prompts through the same projection a persisted row goes through
// (`stripUserText`, `classifyUserRow`) and compare them by the same keys
// (`normalizeMatchText`, `attachmentsMatchKey`, `normalizedItemText`). Those live
// in `rows-to-items.ts`, which Task 12 ports; until that port lands, these are the
// reducer's own transliterations of them, namespaced so the two cannot collide.
// When Task 12's versions exist, the calls should move to them and this file go.
//
// Only the paths the reducer takes are here: `classifyUserRow` without the
// `labelled` option (a resume's `inflight.user` carries no `display_kind`).

enum ReducerRowText {
  // `DISCORD_TRIGGERING_NOTE_RE`:
  // /(^|\n)\[Triggering message id: `[^`\n]*` — use as `message_id` for reply\/react\/pin via the discord tools\.\]\n*/u
  static let discordTriggeringNote = JSRegExp(
    #"(^|\n)\[Triggering message id: `[^`\n]*` — use as `message_id` for reply/react/pin via the discord tools\.\]\n*"#
  )

  // `ATTACHED_CONTEXT_MARKER_RE`: /(?:^|\n)--- Attached Context ---\s*\n/u
  static let attachedContextMarker = JSRegExp(#"(?:^|\n)--- Attached Context ---"# + JSPattern.s + #"*\n"#)

  // `CONTEXT_WARNINGS_MARKER_RE`: /(?:^|\n)--- Context Warnings ---[\s\S]*$/u
  // (`[\s\S]` is every code point in either engine.)
  static let contextWarningsMarker = JSRegExp(#"(?:^|\n)--- Context Warnings ---[\s\S]*"# + JSPattern.end)

  /// The quoted-or-bare tail every reference shares:
  /// (?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)
  static let referenceTail = #"(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|"# + JSPattern.S + "+)"

  // `CONTEXT_REF_RE`: /@(?:file|folder|url|image|tool|terminal):(?:…)/gu
  static let contextReference = JSRegExp("@(?:file|folder|url|image|tool|terminal):" + referenceTail)

  // `ATTACHMENT_REF_RE`: /@(?:file|image):(?:…)/gu
  static let attachmentReference = JSRegExp("@(?:file|image):" + referenceTail)

  // `ATTACHMENT_SCHEME_RE`: /^@(file|image):/u
  static let attachmentScheme = JSRegExp("^@(file|image):")

  // /[ \t]{2,}/gu
  static let runOfBlanks = JSRegExp(#"[ \t]{2,}"#)

  // /^[`"']|[`"']$/gu
  static let edgeQuote = JSRegExp(#"^[`"']|[`"']"# + JSPattern.end)

  // /[/\\]/u
  static let pathSeparator = JSRegExp(#"[/\\]"#)

  // /\s+/gu
  static let whitespaceRun = JSRegExp(JSPattern.s + "+")

  /// `Array.from(text.matchAll(re)).map(match => match[0])` for a pattern with no
  /// anchor or lookbehind that never matches empty: each search resumes where the
  /// last match ended, as a global regular expression's `lastIndex` does.
  static func allMatches(_ regex: JSRegExp, _ text: String) -> [String] {
    var out: [String] = []
    var rest = text

    while let match = regex.exec(rest), match.length > 0 {
      out.append(match[0] ?? "")
      rest = JS.substring(rest, match.index + match.length)
    }

    return out
  }

  /// `[...new Set(values)]`: first occurrence wins, compared code unit for code unit.
  static func unique(_ values: [String]) -> [String] {
    var out: [String] = []

    for value in values where !out.contains(where: { JS.same($0, value) }) {
      out.append(value)
    }

    return out
  }

  /// `haystack.includes(needle)`, code unit for code unit.
  static func includes(_ haystack: String, _ needle: String) -> Bool {
    needle.isEmpty || (haystack as NSString).range(of: needle, options: .literal).location != NSNotFound
  }

  /// `StrippedUserText`.
  struct Stripped {
    var text: String
    var attachments: [String]?
  }

  /// Drop the model-facing scaffolding from a persisted user turn: the attached
  /// context block, the context-warnings tail, and the `@image:` / `@file:`
  /// directive lines the gateway rewrites in at persist time.
  ///
  /// `stripUserText`.
  static func stripUserText(_ raw: String) -> Stripped {
    var textContent = raw

    if let note = discordTriggeringNote.exec(raw) {
      // `raw.replace(DISCORD_TRIGGERING_NOTE_RE, '$1')`
      textContent = JS.substring(raw, 0, note.index) + (note[1] ?? "") + JS.substring(raw, note.index + note.length)
    }

    var visible: String

    if let marker = attachedContextMarker.exec(textContent) {
      visible = JS.trim(contextWarningsMarker.replaceFirst(in: JS.substring(textContent, 0, marker.index), with: ""))

      let attachedContext = JS.substring(textContent, marker.index + marker.length)
      let refs = unique(allMatches(contextReference, attachedContext))
      // The prose keeps the `@file:` token the user typed, so it already chips in
      // place. Only hoist a ref the prose is missing.
      let missing = refs.filter { !includes(visible, $0) }
      let joined = [missing.joined(separator: "\n"), visible].filter { !$0.isEmpty }.joined(separator: "\n\n")

      visible = joined.isEmpty ? visible : joined
    } else {
      visible = JS.trim(contextWarningsMarker.replaceFirst(in: textContent, with: ""))
    }

    let attachments = unique(allMatches(attachmentReference, visible))

    if attachments.isEmpty {
      return Stripped(text: visible)
    }

    let lines = JS.split(attachmentReference.replaceAll(in: visible, with: ""), "\n")
      .map { JS.trim(runOfBlanks.replaceAll(in: $0, with: " ")) }
    // A directive line that held nothing but refs leaves a hole; collapse runs
    // of blank lines rather than opening a gap in the bubble.
    let kept = lines.indices
      .filter { index in !lines[index].isEmpty || (index > 0 && !JS.trim(lines[index - 1]).isEmpty) }
      .map { lines[$0] }
    let cleaned = JS.trim(kept.joined(separator: "\n"))

    return Stripped(text: cleaned, attachments: attachments)
  }

  /// What a `role: "user"` row turns out to be (`UserRowClass`).
  enum UserRowClass {
    case cronDelivery(ParsedCronDelivery)
    case botDmIn(IncomingBotMessage)
    case botDmReply
    case notice(InjectedRow)
    case user(text: String, attachments: [String]?, steered: Bool)
  }

  /// The ONE place a `role: "user"` row is classified — `classifyUserRow` without
  /// `labelled`. The order is the order of certainty, narrowest convention first.
  static func classifyUserRow(_ text: String) -> UserRowClass {
    if let cron = parseCronDelivery(text) {
      return .cronDelivery(cron)
    }

    if let incoming = parseIncomingBotMessage(text) {
      return .botDmIn(incoming)
    }

    // Before the injected-notice parser, which refuses a text carrying a delivery
    // block rather than guessing at its body — and, refusing, used to hand the row
    // on to the speech branch below.
    if isBotDmDeliveryReport(text) {
      return .botDmReply
    }

    if let injected = parseInjectedRow(text) {
      return .notice(injected)
    }

    // A steer IS the user speaking, so it keeps its bubble — but the wrapper the
    // gateway delivers it in is addressed to the model, not to the reader.
    let unwrapped = stripSteerWrapper(text)
    let stripped = stripUserText(unwrapped ?? text)

    return .user(text: stripped.text, attachments: stripped.attachments, steered: unwrapped != nil)
  }

  /// The comparison form of a piece of message text: whitespace runs collapsed,
  /// the ends trimmed, NFC. `normalizeMatchText`.
  static func normalizeMatchText(_ text: String) -> String {
    JS.trim(whitespaceRun.replaceAll(in: text, with: " ")).precomposedStringWithCanonicalMapping
  }

  /// The name at the end of an attachment reference. `attachmentRefName`.
  static func attachmentRefName(_ reference: String) -> String {
    let raw = edgeQuote.replaceAll(in: attachmentScheme.replaceFirst(in: reference, with: ""), with: "")
    let last = pathSeparator.split(raw).last ?? ""

    return last.isEmpty ? raw : last
  }

  /// `file` or `image`. `attachmentRefKind`.
  static func attachmentRefKind(_ reference: String) -> String {
    attachmentScheme.exec(reference)?[1] ?? "file"
  }

  /// The comparison form of what a turn carries: sorted, joined by U+001F, empty
  /// for a turn that carries nothing. `attachmentsMatchKey`.
  static func attachmentsMatchKey(_ references: [String]?) -> String {
    guard let references, !references.isEmpty else { return "" }

    let keys = unique(references.map { "\(attachmentRefKind($0)):\(attachmentRefName($0))" })

    return keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.joined(separator: "\u{1F}")
  }

  /// The text two transports agree on. `normalizedItemText`.
  static func normalizedItemText(_ item: TranscriptItem) -> String {
    let text: String

    switch item {
    case .user(let user): text = user.text
    case .assistant(let assistant): text = assistant.text
    case .botDmIn(let incoming): text = incoming.text
    // The BODY, and the title only when there is no body.
    case .notice(let notice): text = JS.trim(notice.body ?? "").isEmpty ? notice.title : notice.body ?? ""
    case .status(let status): text = status.text
    case .cronDelivery(let cron): text = "\(cron.jobName)\n\(cron.body)"
    case .botDmOut(let dispatch): text = dispatch.message
    default: text = ""
    }

    return normalizeMatchText(text)
  }
}
