import Foundation

// Server→client questions (`approval`, `clarify`) and the methods that answer or poll them.

/// `ApprovalChoice`.
public enum ApprovalChoice: OpenStringEnum {
  case once, session, always, deny
  case unknown(String)

  public static let knownCases: [ApprovalChoice] = [.once, .session, .always, .deny]

  public var rawValue: String {
    switch self {
    case .once: "once"
    case .session: "session"
    case .always: "always"
    case .deny: "deny"
    case .unknown(let raw): raw
    }
  }
}

/// The `approval` server request's params (`_approval_request_payload`).
public struct ApprovalRequestParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  /// The approval queue's own id, which `approval.respond` addresses.
  public var requestID: String? { get { json[field: "request_id"] } set { json[field: "request_id"] = newValue } }
  public var command: String? { get { json[field: "command"] } set { json[field: "command"] = newValue } }
  /// The `description` field (`description` itself is the canonical text, as on every view).
  public var commandDescription: String? {
    get { json[field: "description"] }
    set { json[field: "description"] = newValue }
  }
  public var choices: [ApprovalChoice]? { get { json[field: "choices"] } set { json[field: "choices"] = newValue } }
  public var allowPermanent: Bool? { get { json[field: "allow_permanent"] } set { json[field: "allow_permanent"] = newValue } }
  public var allowSession: Bool? { get { json[field: "allow_session"] } set { json[field: "allow_session"] = newValue } }
  public var smartDenied: Bool? { get { json[field: "smart_denied"] } set { json[field: "smart_denied"] = newValue } }
  public var toolName: String? { get { json[field: "tool_name"] } set { json[field: "tool_name"] = newValue } }
  public var gatewaySessionID: String? {
    get { json[field: "gateway_session_id"] }
    set { json[field: "gateway_session_id"] = newValue }
  }
}

/// The answer to an `approval` server request.
public struct ApprovalResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(choice: ApprovalChoice, all: Bool? = nil) {
    self.init()
    self.choice = choice
    self.all = all
  }

  public var choice: ApprovalChoice? { get { json[field: "choice"] } set { json[field: "choice"] = newValue } }
  public var all: Bool? { get { json[field: "all"] } set { json[field: "all"] = newValue } }
}

/// One question of a batch clarify.
public struct ClarifyQuestion: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var qid: String? { get { json[field: "qid"] } set { json[field: "qid"] = newValue } }
  public var question: String? { get { json[field: "question"] } set { json[field: "question"] = newValue } }
  public var choices: [String]? { get { json[field: "choices"] } set { json[field: "choices"] = newValue } }
  public var multiSelect: Bool? { get { json[field: "multi_select"] } set { json[field: "multi_select"] = newValue } }
}

/// The `clarify` server request's params: one `question` (+ `choices`) or a `questions` batch.
/// `answers` rides only on a reconnect replay (the locks the server already accepted).
public struct ClarifyRequestParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var question: String? { get { json[field: "question"] } set { json[field: "question"] = newValue } }
  public var choices: [String]? { get { json[field: "choices"] } set { json[field: "choices"] = newValue } }
  public var multiSelect: Bool? { get { json[field: "multi_select"] } set { json[field: "multi_select"] = newValue } }
  public var questions: [ClarifyQuestion]? { get { json[field: "questions"] } set { json[field: "questions"] = newValue } }
  public var answers: [String: String]? { get { json[field: "answers"] } set { json[field: "answers"] = newValue } }
}

/// The answer to a `clarify` server request: `answer` for one question (`""` skips),
/// `answers` (qid → answer) for a batch, neither to cancel.
public struct ClarifyResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var answer: String? { get { json[field: "answer"] } set { json[field: "answer"] = newValue } }
  public var answers: [String: String]? { get { json[field: "answers"] } set { json[field: "answers"] = newValue } }
}

/// `ClarifyLockStatus`, also `request.answer`'s status.
public enum ClarifyLockStatus: OpenStringEnum {
  case ok, expired
  case unknown(String)

  public static let knownCases: [ClarifyLockStatus] = [.ok, .expired]

  public var rawValue: String {
    switch self {
    case .ok: "ok"
    case .expired: "expired"
    case .unknown(let raw): raw
    }
  }
}

/// `clarify.lock` params: lock one answer of a batch early.
public struct ClarifyLockParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(requestID: String, questionID: String, answer: JSONValue) {
    self.init()
    self.requestID = requestID
    self.questionID = questionID
    self.answer = answer
  }

  public var requestID: String? { get { json[field: "request_id"] } set { json[field: "request_id"] = newValue } }
  public var questionID: String? { get { json[field: "question_id"] } set { json[field: "question_id"] = newValue } }
  public var answer: JSONValue? { get { json["answer"] } set { json["answer"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
}

public struct ClarifyLockResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var status: ClarifyLockStatus? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
  public var remaining: [String]? { get { json[field: "remaining"] } set { json[field: "remaining"] = newValue } }
}

/// `request.answer` params: answer an open server request by id over a fresh socket.
public struct RequestAnswerParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(id: String, result: JSONObject) {
    self.init()
    self.id = id
    self.result = result
  }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var result: JSONObject? { get { json[field: "result"] } set { json[field: "result"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
}

public struct RequestAnswerResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var status: ClarifyLockStatus? { get { json[field: "status"] } set { json[field: "status"] = newValue } }
}

/// One approval still waiting (`approval.pending`, and a resume's `pending_approval`).
public struct PendingApproval: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var requestID: String? { get { json[field: "request_id"] } set { json[field: "request_id"] = newValue } }
  public var command: String? { get { json[field: "command"] } set { json[field: "command"] = newValue } }
  /// The `description` field (`description` itself is the canonical text, as on every view).
  public var commandDescription: String? {
    get { json[field: "description"] }
    set { json[field: "description"] = newValue }
  }
  public var patternKey: String? { get { json[field: "pattern_key"] } set { json[field: "pattern_key"] = newValue } }
  public var patternKeys: [String]? { get { json[field: "pattern_keys"] } set { json[field: "pattern_keys"] = newValue } }
  public var allowPermanent: Bool? { get { json[field: "allow_permanent"] } set { json[field: "allow_permanent"] = newValue } }
  public var allowSession: Bool? { get { json[field: "allow_session"] } set { json[field: "allow_session"] = newValue } }
  public var smartDenied: Bool? { get { json[field: "smart_denied"] } set { json[field: "smart_denied"] = newValue } }
  public var choices: [String]? { get { json[field: "choices"] } set { json[field: "choices"] = newValue } }
  public var toolName: String? { get { json[field: "tool_name"] } set { json[field: "tool_name"] = newValue } }
}

/// `approval.pending` params and `session.*` calls that name only a session.
public struct SessionParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(sessionID: String, profile: String? = nil) {
    self.init()
    self.sessionID = sessionID
    self.profile = profile
  }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
}

public struct ApprovalPendingResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var approvals: [PendingApproval]? { get { json[field: "approvals"] } set { json[field: "approvals"] = newValue } }
}

/// `approval.respond` params.
public struct ApprovalRespondParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(sessionID: String, choice: ApprovalChoice, requestID: String? = nil, all: Bool? = nil) {
    self.init()
    self.sessionID = sessionID
    self.choice = choice
    self.requestID = requestID
    self.all = all
  }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var choice: ApprovalChoice? { get { json[field: "choice"] } set { json[field: "choice"] = newValue } }
  public var all: Bool? { get { json[field: "all"] } set { json[field: "all"] = newValue } }
  public var requestID: String? { get { json[field: "request_id"] } set { json[field: "request_id"] = newValue } }
}

public struct ApprovalRespondResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var resolved: Int? { get { json[field: "resolved"] } set { json[field: "resolved"] = newValue } }
}

/// `approval.received` params: the card is on screen, so the backend's timeout clock starts.
public struct ApprovalReceivedParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var requestID: String? { get { json[field: "request_id"] } set { json[field: "request_id"] = newValue } }
}

public struct ApprovalReceivedResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var acknowledged: Bool? { get { json[field: "acknowledged"] } set { json[field: "acknowledged"] = newValue } }
}
