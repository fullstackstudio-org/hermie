import HermieProtocol

// A conversation → a file somebody can keep (`export.ts`)
// =======================================================
//
// ## What is exported is what is on screen
//
// The input is the VISIBLE items — whatever the verbosity filter, the
// bot-to-bot toggle and the thinking toggle left standing — rather than the
// chat's full state. That is the contract and it is the reason this takes a
// list instead of a `ChatState`: a reader who has a chat set to Quiet and
// exports it expects the quiet conversation, and an export that silently
// carried the rows the screen is hiding would be handing them something they
// have not read.
//
// ## Markdown and plain text are one walk, not two strippers
//
// They differ in exactly two ways — whether a speaker's name is bold, and
// whether a reply's own markdown is kept or left as the characters it is — so
// one walk emits both rather than a second formatter that agrees with the first
// until it does not. That is the same argument `plain-text.ts` makes about the
// preview and the block stripper sharing a pass.
//
// A reply's markdown is deliberately NOT stripped for the plain-text file
// either. It is the text the model wrote; a `#` and a `**` in a `.txt` are the
// author's characters, while a stripped version is this app's opinion about
// them, and the one thing an export must not do is quietly edit what it is
// preserving.
//
// ## Pure, and total
//
// No UI, no theme, no platform, no locale or time zone beyond what the caller
// hands in. A timestamp is formatted by a function the caller supplies, because
// a file saved on a phone should carry that phone's idea of a clock and this
// package has no business knowing what it is.
//
// The fixed labels (`You`, `Bot`, `Permission request — …`, `Exported …`) are
// English in the TypeScript too, written into the file rather than passed in;
// `selfName` is the one a caller can replace.

public struct TranscriptExportOptions {
  /// The bot's display name, as the header and its replies are labelled.
  public var botName: String
  /// What the reader's own turns are labelled. Defaults to `You`.
  public var selfName: String?
  /// One item's timestamp, as the reader should see it.
  ///
  /// Supplied rather than formatted here: a file saved on a phone carries that
  /// phone's clock and locale, and this package cannot know either. Returning an
  /// empty string drops the stamp from that line.
  public var formatTime: ((Double) -> String)?
  /// When the export was taken, for the header. Same formatter.
  public var exportedAt: Double?
  /// HERM-83, D6 gate 1: only the canonical GROUP chat may put somebody else's
  /// name on a `user` row. Absent — every export before `author` existed —
  /// every `user` row stays `selfName`, exactly as today.
  public var groupChat: Bool?
  /// The reader's own identity, D3's own/foreign gate, compared against
  /// `item.author.id`. Absent is the safe default: `selfName` for every row.
  public var ownAuthorID: String?
  /// Names a foreign author — D4's rungs 2 and 3, or rung 1 when the host has
  /// one. This package cannot sanitise a name itself (see the chat kit's
  /// `fallbackSenderName`); a caller with no resolver leaves every `user` row
  /// `selfName` rather than printing a raw, untrusted id.
  public var resolveSenderName: ((MessageAuthor) -> String)?

  public init(
    botName: String,
    selfName: String? = nil,
    formatTime: ((Double) -> String)? = nil,
    exportedAt: Double? = nil,
    groupChat: Bool? = nil,
    ownAuthorID: String? = nil,
    resolveSenderName: ((MessageAuthor) -> String)? = nil
  ) {
    self.botName = botName
    self.selfName = selfName
    self.formatTime = formatTime
    self.exportedAt = exportedAt
    self.groupChat = groupChat
    self.ownAuthorID = ownAuthorID
    self.resolveSenderName = resolveSenderName
  }
}

public struct TranscriptExport: Sendable, Hashable {
  public var markdown: String
  public var text: String

  public init(markdown: String, text: String) {
    self.markdown = markdown
    self.text = text
  }

  public var jsonValue: JSONValue {
    .object(["markdown": .string(markdown), "text": .string(text)])
  }
}

/// The label a tool row carries, which is the call preview when there is one.
private func toolLine(_ item: ToolItem) -> String {
  let detail = JS.nonEmpty(item.context) ?? JS.nonEmpty(item.summary) ?? ""
  let status = item.isError == true ? " — failed" : item.status == .running ? " — running" : ""

  return detail.isEmpty ? "\(item.name)\(status)" : "\(item.name): \(detail)\(status)"
}

/// One request's outcome in a line, which is all a file can carry of a sheet.
private func requestLine(_ approval: ApprovalItem) -> String {
  let answered: String
  if approval.state == .answered, let answer = JS.nonEmpty(approval.answer) {
    answered = "answered \(answer)"
  } else {
    answered = approval.state.rawValue
  }
  let subject = JS.nonEmpty(approval.command) ?? JS.nonEmpty(approval.toolName) ?? "a permission request"

  return "Permission request — \(subject) (\(answered))"
}

private func requestLine(_ clarify: ClarifyItem) -> String {
  let questions = clarify.questions.map(\.question).filter { !$0.isEmpty }
  let answered = clarify.answers.entries
    .map { qid, answer in
      if let question = clarify.questions.first(where: { JS.same($0.qid, qid) }) {
        return "\(question.question) → \(answer)"
      }
      return answer
    }
    .filter { !$0.isEmpty }

  if !answered.isEmpty {
    return "Question — \(answered.joined(separator: "; "))"
  }

  return "Question — \(JS.nonEmpty(questions.joined(separator: "; ")) ?? clarify.state.rawValue)"
}

private func requestLine(_ request: RequestItem) -> String {
  // How it ended, never what was answered: the item holds no value to print.
  let ended: String
  if let summary = request.answerSummary {
    ended = [
      summary.status ?? summary.decision ?? "",
      summary.edited == true ? "edited" : "",
      (summary.count ?? 0) != 0 ? String(summary.count ?? 0) : "",
    ].filter { !$0.isEmpty }.joined(separator: ", ")
  } else {
    ended = request.state.rawValue
  }

  return "Request — \(JS.nonEmpty(request.title) ?? request.method) (\(JS.nonEmpty(ended) ?? request.state.rawValue))"
}

/// The name a `user` row is exported under, when it is somebody else's
/// (HERM-83, D3/D6) — the same gate `attributedSenderName` in `Preview.swift`
/// applies, restated here because an export walks a plain item list rather
/// than a `ChatState`. `nil` for the reader's own row, an unattributed one,
/// anywhere the caller has not said is the group chat, or a caller with no
/// resolver — every one of those keeps today's `selfName`.
private func foreignSenderWho(_ author: MessageAuthor?, _ options: TranscriptExportOptions) -> String? {
  guard options.groupChat == true, let ownAuthorID = JS.nonEmpty(options.ownAuthorID),
    let resolveSenderName = options.resolveSenderName, let author
  else {
    return nil
  }

  if JS.same(author.id, ownAuthorID) {
    return nil
  }

  return JS.nonEmpty(resolveSenderName(author))
}

/// `/\s+/gu`
private let whitespaceRun = JSRegExp(JSPattern.s + "+")
/// `/\n{3,}/gu`
private let blankLineRun = JSRegExp(#"\n{3,}"#)

/// A speaker's name, safe inside the `**…**` the Markdown file wraps it in.
///
/// A name is somebody else's text — a colleague's, an identity provider's, a
/// bot's — and unescaped a `*` closes the bold early, `[x](y)` becomes a link and
/// `<b>` becomes markup wherever the file is rendered with HTML allowed. Each
/// character that can open or close inline Markdown gets a backslash, which
/// CommonMark defines for every ASCII punctuation character, and the name is
/// held to one line. The `.txt` file is plain text and keeps the name as is.
private func markdownName(_ name: String) -> String {
  // `.replace(/[\\`*_[\]()<>#~|]/gu, '\\$&')`: every character in the set is
  // ASCII, so a walk over scalars escapes exactly what the expression does.
  var out = String.UnicodeScalarView()
  for scalar in whitespaceRun.replaceAll(in: name, with: " ").unicodeScalars {
    switch scalar {
    case "\\", "`", "*", "_", "[", "]", "(", ")", "<", ">", "#", "~", "|":
      out.append("\\")
    default:
      break
    }
    out.append(scalar)
  }
  return String(out)
}

/// One line of a row: who spoke, and the body under it. `nil` drops the row.
private struct Entry {
  /// The speaker or the row's label. Empty for a row that is not speech.
  var who: String
  var body: String
  var ts: Double?
  /// A row that is about the conversation rather than in it: a notice, a tool.
  var aside: Bool
}

private func entryFor(_ item: TranscriptItem, _ options: TranscriptExportOptions) -> Entry? {
  let selfLabel = JS.nonEmpty(JS.trim(options.selfName ?? "")) ?? "You"
  let bot = JS.nonEmpty(JS.trim(options.botName)) ?? "Bot"
  let ts = item.ts

  switch item {
  case .user(let user):
    let text = JS.trim(user.text)
    let attachments = user.attachments ?? []
    guard !text.isEmpty || !attachments.isEmpty else { return nil }
    let body = ([text] + attachments.map { "[\($0)]" }).filter { !$0.isEmpty }.joined(separator: "\n")
    // An agent's turn carries its marker everywhere: `<name> via <client>`, the name being the
    // person's own label (`selfName`, or the resolved name of a colleague in the group chat).
    let who = authorLabel(user.author, foreignSenderWho(user.author, options) ?? selfLabel)
    return Entry(who: who, body: body, ts: ts, aside: false)

  case .assistant(let assistant):
    // An empty reply is a turn that failed or was interrupted; the error line
    // under it is the whole of what happened, so the row is kept for that and
    // dropped when there is neither.
    let text = JS.trim(assistant.text)
    if text.isEmpty && assistant.error == nil {
      return nil
    }

    let body = text.isEmpty ? "(\(assistant.error!.message))" : text
    return Entry(who: bot, body: body, ts: ts, aside: false)

  case .botDmIn(let dm):
    let text = JS.trim(dm.text)
    guard !text.isEmpty else { return nil }
    let who = JS.nonEmpty(dm.senderName) ?? JS.nonEmpty(dm.senderHandle) ?? "another bot"
    return Entry(who: who, body: text, ts: ts, aside: false)

  case .botDmOut(let dm):
    let reply = dm.reply.map { JS.trim($0.text) } ?? ""
    let message = "Message to @\(dm.targetHandle): \(JS.trim(dm.message))"
    return Entry(who: "", body: reply.isEmpty ? message : "\(message)\nReply: \(reply)", ts: ts, aside: true)

  case .cronDelivery(let cron):
    let who = cron.nameRedacted == true ? "Scheduled job" : "Scheduled job “\(cron.jobName)”"
    return Entry(who: who, body: JS.trim(cron.body), ts: ts, aside: false)

  case .tool(let tool):
    return Entry(who: "", body: toolLine(tool), ts: ts, aside: true)

  case .subagentGroup(let group):
    let count = group.goals.count
    let goals = count == 0 ? "" : ": \(group.goals.joined(separator: "; "))"
    let body = "Delegated \(count) task\(count == 1 ? "" : "s") (\(group.status.rawValue))\(goals)"
    return Entry(who: "", body: body, ts: ts, aside: true)

  case .notice(let notice):
    let body = [notice.title, notice.body ?? ""].filter { !$0.isEmpty }.joined(separator: " — ")
    return Entry(who: "", body: body, ts: ts, aside: true)

  case .approval(let approval):
    return Entry(who: "", body: requestLine(approval), ts: ts, aside: true)

  case .clarify(let clarify):
    return Entry(who: "", body: requestLine(clarify), ts: ts, aside: true)

  case .request(let request):
    return Entry(who: "", body: requestLine(request), ts: ts, aside: true)

  case .status:
    // Transient by definition — "Compacting…", "Thinking…" — and gone from the
    // screen a second later. A file that carried them would be a file of
    // things that are no longer true.
    return nil

  case .unknown:
    // The TypeScript `switch` falls out with `undefined` for a kind it does not
    // know, which drops the row.
    return nil
  }
}

/// `2026-09-22 14:05 · ` or nothing, for the start of a line.
private func stamp(_ entry: Entry, _ options: TranscriptExportOptions) -> String {
  guard let ts = entry.ts, let formatTime = options.formatTime else {
    return ""
  }

  let formatted = JS.trim(formatTime(ts))

  return formatted.isEmpty ? "" : "\(formatted) · "
}

/// Serialize a visible transcript into both formats at once.
///
/// Both always end with a newline, so appending to the file or piping it into
/// anything behaves.
public func exportTranscript(_ items: [TranscriptItem], _ options: TranscriptExportOptions) -> TranscriptExport {
  let bot = JS.nonEmpty(JS.trim(options.botName)) ?? "Bot"
  var taken = ""
  if let exportedAt = options.exportedAt, let formatTime = options.formatTime {
    taken = JS.trim(formatTime(exportedAt))
  }

  // `'='.repeat(bot.length)`: one per UTF-16 code unit, as JavaScript counts.
  var markdown: [String] = ["# \(bot)"]
  var text: [String] = [bot, String(repeating: "=", count: JS.length(bot))]

  if !taken.isEmpty {
    markdown += ["", "_Exported \(taken)_"]
    text.append("Exported \(taken)")
  }

  for item in items {
    guard let entry = entryFor(item, options), !JS.trimsToEmpty(entry.body) else {
      continue
    }

    let prefix = stamp(entry, options)

    if entry.aside {
      // An aside is a blockquote in Markdown and a bulleted line in the text
      // file: both say "this is about the conversation" without pretending
      // somebody said it.
      //
      // The stamp goes on the FIRST line only. A dispatch and the reply that
      // came back are two lines of one row, and repeating the time on the second
      // would say the reply landed at the moment the message left.
      let lines = JS.split(entry.body, "\n")

      markdown.append("")
      text.append("")
      for (index, line) in lines.enumerated() {
        markdown.append("> \(index == 0 ? prefix : "")\(line)")
        text.append("  \(index == 0 ? "· \(prefix)" : "  ")\(line)")
      }

      continue
    }

    // `prefix.replace(/ · $/u, '')`: the stamp without its separator.
    let stampOnly = JS.hasSuffix(prefix, " · ") ? JS.slice(prefix, 0, JS.length(prefix) - 3) : prefix
    markdown += [
      "",
      JS.trimEnd("**\(markdownName(entry.who))** \(prefix.isEmpty ? "" : "· \(stampOnly)")"),
      "",
      entry.body
    ]
    text += ["", "\(prefix)\(entry.who):", entry.body]
  }

  func finish(_ lines: [String]) -> String {
    JS.trimEnd(blankLineRun.replaceAll(in: lines.joined(separator: "\n"), with: "\n\n")) + "\n"
  }

  return TranscriptExport(markdown: finish(markdown), text: finish(text))
}

/// The file's extension (`'md' | 'txt'`).
public enum TranscriptFileExtension: String, Sendable, Hashable, CaseIterable {
  case md
  case txt
}

/// `/[^A-Za-z0-9-]+/gu`
private let unsafeFileNameRun = JSRegExp(#"[^A-Za-z0-9\-]+"#)
/// `/^-+|-+$/gu`
private let edgeHyphens = JSRegExp(#"\A-+|-+\z"#)

/// A file name for the export: the bot, the day, and the extension.
///
/// Everything outside `[A-Za-z0-9-]` becomes a hyphen. Not tidiness: this string
/// reaches a file system, a share sheet and — on the web — a `download`
/// attribute, and a bot called `ops/deploy` would otherwise be a path.
///
/// `isoDay` is the caller's: which day it is depends on a time zone this package
/// does not pick.
public func transcriptFileName(_ botName: String, _ fileExtension: TranscriptFileExtension, _ isoDay: String) -> String {
  let replaced = edgeHyphens.replaceAll(in: unsafeFileNameRun.replaceAll(in: JS.trim(botName), with: "-"), with: "")
  // Only `[A-Za-z0-9-]` is left, so code units and characters are the same here.
  let slug = JS.nonEmpty(JS.slice(replaced, 0, 40)) ?? "chat"

  return "\(slug)-\(isoDay).\(fileExtension.rawValue)"
}
