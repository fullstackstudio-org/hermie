import HermieProtocol

// Server→client requests: `applyServerRequest`, `answerRequest`, and the
// `request.cancel` event.

/// What the user answered: one string, or answers keyed by question id
/// (`string | Record<string, string>`), the record in JavaScript key order —
/// `Object.values(answer)[0]` and `Object.assign` both walk it.
public enum RequestAnswer: TranscriptJSONCodable, Hashable {
  case text(String)
  case byQuestion(JSRecord<String>)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    switch json {
    case .string(let text):
      self = .text(text)
    case .object:
      guard let record = JSRecord<String>.read(json, at: path) else {
        throw TranscriptDecodingError(path: path, message: "expected answers keyed by question id, all strings")
      }
      self = .byQuestion(record)
    default:
      throw TranscriptDecodingError(path: path, message: "expected an answer string or an object of answers")
    }
  }

  public var jsonValue: JSONValue {
    switch self {
    case .text(let text): .string(text)
    case .byQuestion(let record): record.json
    }
  }
}

extension TranscriptReducer {
  static let defaultApprovalChoices = ["once", "session", "always", "deny"]

  /// The id of the still-open approval card carrying this queue entry, if there is
  /// one. An answered or cancelled card does not block a fresh question that the
  /// queue happened to give the same id.
  ///
  /// `openApprovalIdOf`.
  static func openApprovalIDOf(_ state: ChatState, _ approvalID: String) -> String? {
    if approvalID.isEmpty {
      return nil
    }

    let id = state.byApprovalID[approvalID]

    guard case .approval(let item)? = itemAt(state, id), item.state == .open else { return nil }

    return id
  }

  /// The id of the still-open card standing at this transport id, if there is one.
  ///
  /// The same rule `openApprovalIdOf` states, applied to the other id a question
  /// carries — and it was missing here, which is the bug. A resume re-delivers an
  /// OPEN request under the id it already has, and that replay must not draw a
  /// second card; an ANSWERED card must not swallow a new question that happens to
  /// arrive under the same id.
  ///
  /// Which is not hypothetical. `srq-N` is a per-process counter, and the gateway
  /// restarts it at 1 for every process — the same fact `cache.ts` already carries
  /// `lastSeqSessionId` for. So a cached "Allowed once" from before a restart sat
  /// on `srq-1`, the first question of the new session arrived as `srq-1`, and the
  /// guard dropped it: no sheet, no card, and a turn parked on an answer the
  /// reader was never asked for.
  ///
  /// `addItem` gives the new card a free item id of its own, so the two coexist
  /// and `byRequestId` points at the live one.
  ///
  /// `openRequestIdOf`.
  static func openRequestIDOf(_ state: ChatState, _ requestID: String) -> String? {
    let id = state.byRequestID[requestID]

    switch itemAt(state, id) {
    case .approval(let item)?: return item.state == .open ? id : nil
    case .clarify(let item)?: return item.state == .open ? id : nil
    default: return nil
    }
  }

  /// `request.id`: typed `string`; a number the transport might carry is spelled
  /// the way a template literal would.
  static func requestID(_ request: ServerRequest) -> String {
    switch request.json["id"] {
    case .string(let id)?: id
    case .number(let id)?: JS.string(id)
    default: ""
    }
  }

  /// `case 'request.cancel'`.
  static func requestCancel(_ next: inout ChatState, _ payload: JSONObject) {
    // The gateway withdraws a question under whichever id it knows it by: the
    // transport's request id for a live one, the approval queue's own id for
    // one the client only ever saw as a snapshot entry.
    let cancelID = str(payload["id"])

    if let id = JS.nonEmpty(next.byRequestID[cancelID] ?? next.byApprovalID[cancelID]) {
      patchRequest(&next, id, state: .cancelled, cancelReason: str(payload["reason"]))
    }
  }

  /// `params.choices` when it is an array (its strings only), else `nil`.
  static func stringChoices(_ value: JSONValue?) -> [String]? {
    guard case .array(let values)? = value else { return nil }

    return values.compactMap(\.stringValue)
  }
}

/// Turn an `approval` / `clarify` server request into a transcript item.
///
/// `applyServerRequest`. The store's form is `applyServerRequest(into:_:_:)`.
public func applyServerRequest(_ state: ChatState, _ request: ServerRequest, _ now: Double) -> ChatState {
  var next = state
  applyServerRequest(into: &next, request, now)
  return next
}

/// `applyServerRequest`, in place.
public func applyServerRequest(into next: inout ChatState, _ request: ServerRequest, _ now: Double) {
  typealias R = TranscriptReducer

  let requestID = R.requestID(request)

  if R.openRequestIDOf(next, requestID) != nil {
    return
  }

  let params = R.rec(request.json["params"])
  let method = request.json["method"]?.stringValue

  if method == "approval" && R.openApprovalIDOf(next, JS.nonEmpty(R.str(params["request_id"])) ?? requestID) != nil {
    // The same queue entry under a second transport id. One question, one card.
    return
  }

  if method == "approval" {
    let choices = R.stringChoices(params["choices"]) ?? R.defaultApprovalChoices
    let description = R.str(params["description"])
    let toolName = R.str(params["tool_name"])

    R.addItem(&next, id: "req:\(requestID)", ts: now / 1000) { base in
      .approval(
        ApprovalItem(
          base: base,
          requestID: requestID,
          approvalID: JS.nonEmpty(R.str(params["request_id"])) ?? requestID,
          command: R.str(params["command"]),
          description: JS.nonEmpty(description),
          toolName: JS.nonEmpty(toolName),
          choices: choices.isEmpty ? R.defaultApprovalChoices : choices,
          allowPermanent: R.isFalse(params["allow_permanent"]) ? false : true,
          allowSession: R.isFalse(params["allow_session"]) ? false : true,
          smartDenied: R.isTrue(params["smart_denied"]) ? true : nil,
          state: .open
        )
      )
    }

    return
  }

  if method == "clarify" {
    var answers = JSRecord<String>()
    let given = R.rec(params["answers"])

    // `Object.entries(rec(params.answers))`, in the order `JSON.parse` would give.
    for qid in given.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
      if case .string(let value)? = given[qid] {
        answers[qid] = value
      }
    }

    let batch: Bool
    let questions: [ClarifyQuestionItem]

    if case .array(let raws)? = params["questions"] {
      batch = true
      questions = raws.enumerated().map { index, raw in
        let question = R.rec(raw)

        return ClarifyQuestionItem(
          qid: JS.nonEmpty(R.str(question["qid"])) ?? "q\(index + 1)",
          question: R.str(question["question"]),
          choices: R.stringChoices(question["choices"]),
          multiSelect: R.isTrue(question["multi_select"])
        )
      }
    } else {
      batch = false
      questions = [
        ClarifyQuestionItem(
          qid: JS.nonEmpty(R.str(params["request_id"])) ?? "q1",
          question: R.str(params["question"]),
          choices: R.stringChoices(params["choices"]),
          multiSelect: R.isTrue(params["multi_select"])
        )
      ]
    }

    let answered = !questions.isEmpty && questions.allSatisfy { answers[$0.qid] != nil }

    R.addItem(&next, id: "req:\(requestID)", ts: now / 1000) { base in
      .clarify(
        ClarifyItem(
          base: base,
          requestID: requestID,
          questions: questions,
          batch: batch ? true : nil,
          answers: answers,
          locked: answers.keys,
          state: answered ? .answered : .open
        )
      )
    }
  }
}

/// Record the user's answer locally; the transport still owns the RPC reply.
///
/// `answerRequest`.
public func answerRequest(_ state: ChatState, _ requestID: String, _ answer: RequestAnswer) -> ChatState {
  var next = state
  answerRequest(into: &next, requestID, answer)
  return next
}

/// `answerRequest`, in place.
public func answerRequest(into next: inout ChatState, _ requestID: String, _ answer: RequestAnswer) {
  typealias R = TranscriptReducer

  guard let id = JS.nonEmpty(next.byRequestID[requestID]) else { return }

  switch next.items[id] {
  case .approval?:
    R.patchApproval(&next, id) { draft in
      switch answer {
      case .text(let text): draft.answer = text
      case .byQuestion(let record): draft.answer = record.values.first ?? ""
      }
      draft.state = .answered
    }

  case .clarify?:
    R.patchClarify(&next, id) { draft in
      var merged = draft.answers

      switch answer {
      case .text(let text):
        if let open = draft.questions.first(where: { merged[$0.qid] == nil }) {
          merged[open.qid] = text
        }
      case .byQuestion(let record):
        // `Object.assign(merged, answer)`: a key already there keeps its place.
        for (qid, value) in record.entries {
          merged[qid] = value
        }
      }

      draft.answers = merged
      draft.locked = merged.keys
      draft.state = draft.questions.allSatisfy { merged[$0.qid] != nil } ? .answered : .open
    }

  default:
    return
  }
}
