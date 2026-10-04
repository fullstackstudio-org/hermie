import Foundation
import HermieProtocol

/// What one interactive request asks, by method (`contract/requests/README.md` §4 to §6): the
/// params as the gateway built them, for the sheet to draw.
public enum InteractiveBody: Sendable, Equatable {
  /// `input.form`: typed fields.
  case form(InputFormParams)
  /// `input.file`: one or more files, uploaded.
  case file(InputFileParams)
  /// `review.draft`: approval of a draft, optionally edited.
  case draft(ReviewDraftParams)

  /// The wire method.
  public var method: String {
    switch self {
    case .form: ServerRequestBody.Method.inputForm
    case .file: ServerRequestBody.Method.inputFile
    case .draft: ServerRequestBody.Method.reviewDraft
    }
  }
}

/// What a person answers an interactive request with. The values live here only as long as the
/// call that sends them: nothing keeps them.
public enum InteractiveAnswer: Sendable, Equatable {
  /// `input.form`: the values by field id; a field without a value is left out.
  case form([String: FormValue])
  /// `input.file`: the references to the files already uploaded, and a transcript for audio.
  case files([UploadedFile], text: String?)
  /// `review.draft`: approved, with the text as approved.
  case approve(text: String)
  /// `review.draft`: rejected, with a comment for the agent.
  case reject(comment: String?)
  /// `input.*` with `optional`: Skip.
  case skip
}

/// The result a request is answered with, and the summary the transcript's card keeps of how it
/// ended (`RequestAnswerSummary`'s keys only, never a value).
struct InteractiveReply: Sendable, Equatable {
  var result: JSONObject
  var summary: JSONObject
}

/// A request read once, off the main actor: what it asks with every text cleaned and bounded.
struct InteractiveContent: Sendable, Equatable {
  var body: InteractiveBody
  var title: String
  var summary: String
  var detail: String?
  var offersSkip: Bool
  var actingUser: String?
  /// `expires_at`, Unix seconds, when the gateway named one.
  var expiresAt: Int?
}

/// What the center makes of a server request.
enum InteractiveReading: Sendable, Equatable {
  /// An interactive request this build can show.
  case content(InteractiveContent)
  /// An interactive request this build cannot show: answered `4041 cannot_show` with this reason.
  case cannotShow(reason: String)
  /// Not an interactive request.
  case other
}

/// One open interactive request, as the sheet shows it. It holds what was asked, never what is
/// answered.
public struct InteractivePrompt: Sendable, Equatable, Identifiable {
  /// The server request's id (`srq-…`).
  public let id: String
  public let method: String
  /// What it asks: the gateway's params.
  public let body: InteractiveBody
  /// The agent's heading, one line, cleaned and at most `titleLimit` characters.
  public let title: String
  /// The agent's words: what it asks and why, cleaned and at most `summaryLimit` characters.
  public let summary: String
  /// Extra context, shown monospaced, cleaned and at most `detailLimit` characters.
  public let detail: String?
  /// Skip is offered (`optional`; `input.*` unless the agent says otherwise, `review.*` never).
  public let offersSkip: Bool
  /// The person the turn acts for, when the gateway named them (informative only).
  public let actingUser: String?
  /// The chat it belongs to (the bot's name).
  public var chatKey: String
  /// The runtime session the request names.
  public let sessionID: String
  /// When this client stops showing it, on the session's clock: the gateway's `expires_at`, so a
  /// re-delivered copy has one too. A request that names none is shown for the longest the gateway
  /// waits (`InteractivePrompt.defaultTimeout`).
  public var deadline: Duration?
  /// The gateway asks again because an answer sent from here never reached it (it re-delivered the
  /// request after a reconnect): the sheet says so.
  public var earlierAnswerLost: Bool

  init(
    id: String,
    content: InteractiveContent,
    chatKey: String,
    sessionID: String,
    deadline: Duration?,
    earlierAnswerLost: Bool = false
  ) {
    self.id = id
    self.method = content.body.method
    self.body = content.body
    self.title = content.title
    self.summary = content.summary
    self.detail = content.detail
    self.offersSkip = content.offersSkip
    self.actingUser = content.actingUser
    self.chatKey = chatKey
    self.sessionID = sessionID
    self.deadline = deadline
    self.earlierAnswerLost = earlierAnswerLost
  }

  /// The longest heading shown (the contract bounds it at 80).
  public static let titleLimit = 80
  /// The longest summary shown (the contract bounds it at 500).
  public static let summaryLimit = 500
  /// The longest detail shown (the contract bounds it at 2,000).
  public static let detailLimit = 2_000
  /// The longest label, hint, option, subject or recipient shown.
  public static let labelLimit = 200
  /// The longest name of the person the turn acts for.
  public static let nameLimit = 80
  /// How long a request that names no `expires_at` is shown. The gateway's own wait is bounded the
  /// same way.
  public static let defaultTimeout: Duration = .seconds(300)
  /// The contract's bound on a comment that rejects a draft, in code points.
  public static let commentLimit = 1_000
  /// The contract's bound on an approved draft, in code points.
  public static let draftLimit = 20_000

  /// `raw` as one line of display text: cleaned and bounded like every text of the request
  /// (`SecurePrompt.displayText`), line breaks becoming spaces.
  public static func line(_ raw: String?, limit: Int) -> String {
    SecurePrompt.displayText(raw, limit: limit).replacingOccurrences(of: "\n", with: " ")
  }

  /// `raw` as display text of several lines.
  public static func text(_ raw: String?, limit: Int) -> String {
    SecurePrompt.displayText(raw, limit: limit)
  }

  // MARK: - Reading a request

  /// What a server request asks, or why this build cannot show it. Every string of the envelope
  /// is plain text: cleaned, bounded and never styled by the request.
  static func read(_ request: ServerRequestBody) -> InteractiveReading {
    switch request {
    case .inputForm(let params):
      guard params.v == 1 else {
        return .cannotShow(reason: CannotShowReason.unsupportedVersion)
      }

      // A field this build does not know cannot be shown, and one without an id cannot be answered.
      guard let fields = params.fields, !fields.isEmpty, fields.count <= 12, params.firstUnknownField == nil,
        fields.allSatisfy({ ($0.id ?? "").isEmpty == false })
      else {
        return .cannotShow(reason: CannotShowReason.notSupportedOnDevice)
      }

      // A zone this device does not know: the answer could not be in the zone the field names, and
      // the offset would be wrong, so the form is declined rather than answered in another zone.
      guard fields.allSatisfy({ $0.hasKnownZone }) else {
        return .cannotShow(reason: CannotShowReason.notSupportedOnDevice)
      }

      return .content(content(.form(params), params))
    case .inputFile(let params):
      guard params.v == 1 else {
        return .cannotShow(reason: CannotShowReason.unsupportedVersion)
      }

      // Without a place to upload to there is nothing the person's files could be sent to.
      guard let dir = params.upload?.dir, dir.hasPrefix("/") else {
        return .cannotShow(reason: CannotShowReason.notSupportedOnDevice)
      }

      return .content(content(.file(params), params))
    case .reviewDraft(let params):
      guard params.v == 1 else {
        return .cannotShow(reason: CannotShowReason.unsupportedVersion)
      }

      guard let text = params.text, !text.isEmpty else {
        return .cannotShow(reason: CannotShowReason.notSupportedOnDevice)
      }

      return .content(content(.draft(params), params))
    default:
      return .other
    }
  }

  private static func content(_ body: InteractiveBody, _ params: some InteractiveRequestParams) -> InteractiveContent {
    InteractiveContent(
      body: body,
      title: line(params.title, limit: titleLimit),
      summary: text(params.summary, limit: summaryLimit),
      detail: params.detail.map { text($0, limit: detailLimit) }.flatMap { $0.isEmpty ? nil : $0 },
      offersSkip: params.offersSkip,
      actingUser: params.actingUser?.name.map { line($0, limit: nameLimit) }.flatMap { $0.isEmpty ? nil : $0 },
      expiresAt: params.expiresAt
    )
  }

  // MARK: - Answering

  /// The reply that answers this prompt with `answer`, or nil when `answer` cannot answer it: it
  /// is for another method, skips a request that is not optional, names more files than the
  /// request allows, approves nothing, or changes a draft that is not editable. The values are
  /// checked by the gateway field by field; this keeps only what could never be a valid answer.
  func reply(to answer: InteractiveAnswer) -> InteractiveReply? {
    switch (body, answer) {
    case (.form, .skip), (.file, .skip):
      guard offersSkip else {
        return nil
      }

      return InteractiveReply(
        result: ["status": .string("skipped")],
        summary: ["status": .string("skipped")]
      )
    case (.form(let params), .form(let values)):
      let ids = Set((params.fields ?? []).compactMap(\.id))

      // A value for a field the form does not have is refused by the gateway; it never goes out.
      guard values.keys.allSatisfy(ids.contains) else {
        return nil
      }

      return InteractiveReply(
        result: InputFormResult.answered(values: values).json,
        summary: ["status": .string("answered")]
      )
    case (.file(let params), .files(let files, let text)):
      let most = params.upload?.maxFiles ?? 10

      guard !files.isEmpty, files.count <= most, files.count == 1 || params.isMultiple else {
        return nil
      }

      return InteractiveReply(
        result: InputFileResult.answered(files: files, text: text.flatMap { $0.isEmpty ? nil : $0 }).json,
        summary: ["status": .string("answered"), "count": .number(Double(files.count))]
      )
    case (.draft(let params), .approve(let text)):
      // Counted in code points, as the gateway counts.
      guard !text.isEmpty, text.unicodeScalars.count <= Self.draftLimit else {
        return nil
      }

      let edited = Self.trimmed(text) != Self.trimmed(params.text ?? "")

      // The gateway refuses a change to a draft that is not editable; it never goes out.
      guard params.isEditable || !edited else {
        return nil
      }

      return InteractiveReply(
        result: ReviewDraftResult.approved(text: text).json,
        summary: ["decision": .string("approved"), "edited": .bool(edited)]
      )
    case (.draft, .reject(let comment)):
      let kept = comment.map {
        Self.prefix($0.trimmingCharacters(in: .whitespacesAndNewlines), scalars: Self.commentLimit)
      }

      return InteractiveReply(
        result: ReviewDraftResult.rejected(comment: kept.flatMap { $0.isEmpty ? nil : $0 }).json,
        summary: ["decision": .string("rejected")]
      )
    default:
      return nil
    }
  }

  /// At most `limit` code points of `text` (the gateway's bounds count code points, not what a
  /// person sees as one character).
  static func prefix(_ text: String, scalars limit: Int) -> String {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: text.unicodeScalars.prefix(limit))
    return String(view)
  }

  /// A draft as the gateway compares it: the whitespace at the end of each line and of the whole
  /// text removed (`DraftText.gatewayTrimmed`).
  static func trimmed(_ text: String) -> String {
    DraftText.gatewayTrimmed(text)
  }
}

extension FormField {
  /// The field names no `tz`, or one this device knows (an IANA zone name).
  var hasKnownZone: Bool {
    let name: String? =
      switch self {
      case .date(let field): field.tz
      case .time(let field): field.tz
      case .datetime(let field): field.tz
      case .daterange(let field): field.tz
      default: nil
      }

    guard let name else {
      return true
    }

    return TimeZone(identifier: name) != nil
  }
}
