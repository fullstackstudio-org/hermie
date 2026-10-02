import HermieProtocol

// Cron-delivery wire conventions (`cron-delivery.ts`).
//
// A cron job that reports into a bot's chat does NOT arrive as its own event and
// carries NO `display_kind`, no `source_label`, no metadata of any kind: it is
// injected as a real inbound turn and persists as an ordinary `role: "user"`
// row. The only thing that distinguishes it from the owner typing is the header
// the scheduler splices in front of the report, so that header is the whole
// signal. See `docs/adr/0013-cron-deliveries-in-the-transcript.md`.
//
// Two headers exist, both from `cron/scheduler_delivery.py` at upstream
// b9c2660:
//
//   `bot_chat` — `_deliver_to_bot_chat` (defined line 771, header built lines 798–801):
//     [Cronjob "<name>" output — scheduled job, not the user. Review it, act on
//     anything that needs action, and summarize for the chat.]
//     <blank line>
//     <content>
//
//   `mirror` — `_cron_mirror_message` (line 197), mirrored with `role="user"`:
//     [Cron delivery: <name>]
//     <text>
//
// Because there is no wire marker, this is a HEURISTIC, and it is deliberately
// the narrowest one that still matches what the gateway writes:
//
// - the header is anchored at the start of the row, with only whitespace allowed
//   in front of it — a bot quoting the header in prose is not a cron delivery;
// - the header must occupy its own single line, closing bracket last;
// - the `bot_chat` instruction sentence is matched WORD FOR WORD rather than
//   loosely on `[Cronjob`, because the sentence is fixed text and the job name
//   is the only variable in it.
//
// What breaks it, in rough order of likelihood:
//
// - an upstream wording change to either header — the strings are load-bearing;
// - a gateway that localises the header, which no current build does;
// - a user who types a line matching a header as their own first line, which is
//   indistinguishable from the real thing and will be drawn as a cron card;
// - a job whose NAME happens to contain the literal closing fragment of the
//   `bot_chat` header, which would cut the name short.
//
// Nothing here is lossy: the shape that matched is reported, so a caller can
// always rebuild the original row text if it has to.

/// `ParsedCronDelivery`.
public struct ParsedCronDelivery: TranscriptJSONCodable, Hashable {
  /// The job name exactly as the header spelled it, never empty.
  public var jobName: String
  /// The report, header and its separator removed; empty when none arrived yet.
  public var body: String
  public var shape: CronDeliveryShape
  /// The gateway's redactor threw and replaced the name wholesale
  /// (`_redact_cron_payload`), so `jobName` names no job. A card should say so
  /// rather than print it as a title.
  public var nameRedacted: Bool

  public init(jobName: String, body: String, shape: CronDeliveryShape, nameRedacted: Bool) {
    self.jobName = jobName
    self.body = body
    self.shape = shape
    self.nameRedacted = nameRedacted
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ParsedCronDelivery")
    jobName = try reader.required("jobName")
    body = try reader.required("body")
    shape = try reader.required("shape")
    nameRedacted = try reader.required("nameRedacted")
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("jobName", jobName)
    writer.set("body", body)
    writer.set("shape", shape)
    writer.set("nameRedacted", nameRedacted)
    return writer.json
  }
}

enum CronDeliveryPatterns {
  /// `_deliver_to_bot_chat`'s header. The name is greedy up to the last closing
  /// fragment on the line, so a name containing `"` or `]` survives intact.
  ///
  /// `/^\s*\[Cronjob "([^\r\n]*)" output — scheduled job, not the user\. Review it, act on anything that needs action, and summarize for the chat\.\](?:\r?\n\r?\n|\r?\n|$)/u`
  static let botChatHeader = JSRegExp(
    "^" + JSPattern.s
      + #"*\[Cronjob "([^\r\n]*)" output — scheduled job, not the user\. Review it, act on anything that needs action, and summarize for the chat\.\](?:\r?\n\r?\n|\r?\n|"#
      + JSPattern.end + ")"
  )

  /// `_cron_mirror_message`'s header: one line, one newline, then the text.
  ///
  /// `/^\s*\[Cron delivery: ([^\r\n]*)\](?:\r?\n|$)/u`
  static let mirrorHeader = JSRegExp(
    "^" + JSPattern.s + #"*\[Cron delivery: ([^\r\n]*)\](?:\r?\n|"# + JSPattern.end + ")"
  )
}

/// `_redact_cron_payload`'s fail-closed replacement, used for the name too.
private let redactionFailed = "[REDACTED - redaction failed]"

/// Read a transcript row's text as a cron delivery, or `nil` when it is not one.
///
/// Pure and total: any string is a legal argument. The body is trimmed at both
/// ends because both headers end in a hard line break the report never means to
/// keep, and because an empty body has to come back as `''` rather than as
/// leftover whitespace.
///
/// The TypeScript takes `unknown`; anything but a non-empty string is `nil` here too.
public func parseCronDelivery(_ text: String?) -> ParsedCronDelivery? {
  guard let text, !text.isEmpty else {
    return nil
  }

  if let botChat = CronDeliveryPatterns.botChatHeader.exec(text) {
    return built(botChat[1] ?? "", JS.slice(text, botChat.length), .botChat)
  }

  if let mirror = CronDeliveryPatterns.mirrorHeader.exec(text) {
    return built(mirror[1] ?? "", JS.slice(text, mirror.length), .mirror)
  }

  return nil
}

private func built(_ rawName: String, _ rest: String, _ shape: CronDeliveryShape) -> ParsedCronDelivery {
  let jobName = JS.trim(rawName)

  return ParsedCronDelivery(
    // An empty name is not something upstream can write — `_cron_display_name`
    // falls back to the job id — but a header with nothing between the quotes
    // would otherwise produce a nameless card, so it is labelled as unknown.
    jobName: jobName.isEmpty ? "unknown job" : jobName,
    body: JS.trim(rest),
    shape: shape,
    nameRedacted: JS.same(jobName, redactionFailed)
  )
}

/// Is this row text a cron delivery? The predicate, when the parts are not needed.
public func isCronDelivery(_ text: String?) -> Bool {
  parseCronDelivery(text) != nil
}

extension ParsedCronDelivery: JSONField {}
