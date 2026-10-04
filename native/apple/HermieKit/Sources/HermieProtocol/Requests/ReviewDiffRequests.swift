import Foundation

// `review.diff` (contract/requests/README.md §7): the agent shows the changes it wants to make to ONE
// file, hunk by hunk, and the person approves or rejects each hunk.
//
// These are the wire views, read as tolerantly as every wire type here. The strict reading, the one
// that decides whether this app can show the request at all, is `ReviewDiff.read` in HermieCore: it
// walks the raw JSON (a typed array drops an element that does not convert, and a diff with a hunk
// silently left out would be a review of less than the agent asked).

/// What the diff does to its file, as the gateway read it from the diff's header.
public enum DiffKind: OpenStringEnum {
  case modify, new, delete, rename
  case unknown(String)

  public static let knownCases: [DiffKind] = [.modify, .new, .delete, .rename]

  public var rawValue: String {
    switch self {
    case .modify: "modify"
    case .new: "new"
    case .delete: "delete"
    case .rename: "rename"
    case .unknown(let raw): raw
    }
  }
}

/// Where `git apply` pins a hunk whatever the header's line numbers say: `start` (it must match at the
/// beginning of the file), `end` (no context line after its last change: it must match at the END of
/// the file) or `both` (a whole-file hunk).
public enum DiffAnchor: OpenStringEnum {
  case start, end, both
  case unknown(String)

  public static let knownCases: [DiffAnchor] = [.start, .end, .both]

  public var rawValue: String {
    switch self {
    case .start: "start"
    case .end: "end"
    case .both: "both"
    case .unknown(let raw): raw
    }
  }
}

/// What the person decided about one hunk. There is no skip: a hunk is approved or rejected.
public enum HunkDecision: OpenStringEnum {
  case approved, rejected
  case unknown(String)

  public static let knownCases: [HunkDecision] = [.approved, .rejected]

  public var rawValue: String {
    switch self {
    case .approved: "approved"
    case .rejected: "rejected"
    case .unknown(let raw): raw
    }
  }
}

/// One hunk of the diff: `id` (`h1`, `h2`, … as the gateway numbered them), the `@@ -a,b +c,d @@`
/// line, the hunk's lines each with its marker, and `anchor` when the hunk is pinned to the start
/// and/or the end of the file.
public struct DiffHunk: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The keys the contract gives a hunk. Another key is a hunk this build does not understand.
  public static let knownKeys: Set<String> = ["id", "header", "lines", "anchor"]

  /// `^h[1-9][0-9]{0,2}$`, unique within the request.
  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  /// `@@ -a,b +c,d @@`, optionally followed by a space and the section text. At most 200 characters.
  public var header: String? { get { json[field: "header"] } set { json[field: "header"] = newValue } }
  /// 1 to 400 lines of at most 500 code points: a marker (space, `+` or `-`) and the line's text, or
  /// exactly `\ No newline at end of file`.
  public var lines: [String]? { get { json[field: "lines"] } set { json[field: "lines"] = newValue } }
  public var anchor: DiffAnchor? { get { json[field: "anchor"] } set { json[field: "anchor"] = newValue } }
}

/// `review.diff` params: the envelope plus the file's `kind` and `path`, a rename's `old_path` and the
/// hunks. `optional` is false: there is no skip, the person decides every hunk.
public struct ReviewDiffParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = false

  public var kind: DiffKind? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  /// 1 to 300 characters, one line: the file's relative path, display only. For a rename the new path.
  public var path: String? { get { json[field: "path"] } set { json[field: "path"] = newValue } }
  /// A rename's previous path; present for `rename` and only then.
  public var oldPath: String? { get { json[field: "old_path"] } set { json[field: "old_path"] = newValue } }
  /// 1 to 200 hunks. Elements that are not objects are dropped here; `ReviewDiff.read` refuses the
  /// request instead.
  public var hunks: [DiffHunk]? { get { json[field: "hunks"] } set { json[field: "hunks"] = newValue } }
}

/// `review.diff` result: `{decision, hunks: {<id>: approved | rejected}}` with an entry for EVERY hunk
/// of the request. There is no skip and no comment.
public struct ReviewDiffResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `decision` is `approved` when some hunk is approved and `rejected` when none is: the gateway
  /// refuses the other pairings (`decision:inconsistent`).
  public static func decided(_ hunks: [String: HunkDecision]) -> ReviewDiffResult {
    let decision: ReviewDecision = hunks.values.contains(.approved) ? .approved : .rejected
    return ReviewDiffResult(json: ["decision": decision.jsonValue, "hunks": hunks.jsonValue])
  }

  public var decision: ReviewDecision? { json[field: "decision"] }
  public var hunks: [String: HunkDecision]? { json[field: "hunks"] }
}
