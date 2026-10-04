import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// `review.diff` (`contract/requests/README.md` §7), read strictly: every valid frame of the contract's
/// examples is shown, every invalid one is refused whole, and a frame the examples do not list but the
/// contract rules out is refused too.
private let contractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract", isDirectory: true)
}()

private func section(_ key: String) throws -> [JSONValue] {
  let data = try Data(contentsOf: contractDirectory.appendingPathComponent("requests/examples.json"))
  let root = try JSONValue(parsing: data)
  return try #require(root["methods"]?["review.diff"]?[key]?.arrayValue, "review.diff.\(key)")
}

private func params(_ raw: JSONValue) throws -> ReviewDiffParams {
  try #require(ReviewDiffParams(jsonValue: raw))
}

/// A diff request around `hunks`, one file.
private func diff(
  kind: String = "modify", path: String = "a.txt", oldPath: String? = nil, hunks: [JSONValue]
) -> ReviewDiffParams {
  var json: JSONObject = [
    "session_id": "s", "v": 1, "title": "t", "summary": "s", "expires_at": 1, "optional": false,
    "kind": .string(kind), "path": .string(path), "hunks": .array(hunks)
  ]

  if let oldPath {
    json["old_path"] = .string(oldPath)
  }

  return ReviewDiffParams(json: json)
}

/// A hunk in the middle of a file: unchanged lines either side of one changed line, so it is pinned nowhere.
private func hunk(
  _ id: String = "h1", header: String = "@@ -10,3 +10,3 @@",
  lines: [String] = [" a", "-b", "+B", " c"], anchor: String? = nil
) -> JSONValue {
  var object: JSONObject = ["id": .string(id), "header": .string(header), "lines": .array(lines.map(JSONValue.string))]

  if let anchor {
    object["anchor"] = .string(anchor)
  }

  return .object(object)
}

private func read(_ params: ReviewDiffParams) throws -> ReviewDiff {
  switch ReviewDiff.read(params) {
  case .success(let diff): return diff
  case .failure(let problem):
    Issue.record("refused: \(problem)")
    throw problem
  }
}

private func problem(_ params: ReviewDiffParams) -> ReviewDiff.Problem? {
  if case .failure(let problem) = ReviewDiff.read(params) {
    return problem
  }

  return nil
}

@Suite("Review diff: reading")
struct ReviewDiffReadingTests {
  @Test("every valid frame of the contract is read, with the file, the hunks and where each lands")
  func validFrames() throws {
    let frames = try section("frames")
    #expect(frames.count == 6)

    var seen: [String: ReviewDiff] = [:]

    for frame in frames {
      let id = frame["id"]?.stringValue ?? "?"
      seen[id] = try read(try params(try #require(frame["params"], "\(id)")))
    }

    let settings = try #require(seen["req_diff_settings"])
    #expect(settings.kind == .modify && settings.path == "app/settings.py" && settings.oldPath == nil)
    #expect(settings.hunkIDs == ["h1", "h2"])
    #expect(settings.hunks.map(\.anchor) == [nil, nil])
    #expect(settings.hasUnanchoredHunks)
    #expect(settings.hunks[0].section == "class Settings:")
    #expect(settings.hunks[0].old == ReviewDiff.Span(start: 3, count: 4))
    #expect(settings.hunks[0].new == ReviewDiff.Span(start: 3, count: 4))
    #expect(settings.hunks[1].added == 2 && settings.hunks[1].removed == 1)
    #expect(settings.hunks[0].lines.map(\.mark) == [.context, .removed, .added, .context, .context])
    #expect(settings.hunks[0].lines[1].text == "    currency = \"USD\"", "verbatim, the marker off")

    let created = try #require(seen["req_diff_new_file"])
    #expect(created.kind == .new && created.hunks[0].anchor == .both)
    #expect(created.hunks[0].lines.map(\.mark) == [.added, .added, .noNewline])
    #expect(created.hunks[0].lines.last?.text == "\\ No newline at end of file")

    let go = try #require(seen["req_diff_go"])
    #expect(go.hunks[0].lines[1].text == "\tfor i := 0; i < 3; i++ {", "a tab is part of the line")
    #expect(go.hunks[0].anchor == nil)

    let rename = try #require(seen["req_diff_rename"])
    #expect(rename.kind == .rename && rename.path == "app/accounts.py" && rename.oldPath == "app/users.py")
    #expect(rename.hunks[0].anchor == .start)
    #expect(rename.hunks[0].lines.last == ReviewDiff.Line(mark: .context, text: ""), "a blank context line is a single space")

    let deleted = try #require(seen["req_diff_delete"])
    #expect(deleted.kind == .delete && deleted.hunks[0].anchor == .both)

    let appended = try #require(seen["req_diff_append"])
    #expect(appended.hunks[0].anchor == .end)
    #expect(appended.hunks[0].old == ReviewDiff.Span(start: 3, count: 1))
  }

  @Test("every invalid frame of the contract is refused whole")
  func invalidFrames() throws {
    let frames = try section("invalid_frames")
    #expect(frames.count == 21)

    for frame in frames {
      let name = frame["name"]?.stringValue ?? "?"
      let invalid = try params(try #require(frame["params"], "\(name)"))
      #expect(problem(invalid) != nil, "\(name) must not be shown")
    }
  }

  @Test("each invalid frame is refused for the rule it breaks")
  func invalidFrameReasons() throws {
    var byName: [String: ReviewDiffParams] = [:]

    for frame in try section("invalid_frames") {
      byName[frame["name"]?.stringValue ?? "?"] = try params(try #require(frame["params"]))
    }

    func reason(_ name: String) -> ReviewDiff.Problem? { byName[name].flatMap(problem) }

    #expect(reason("hunk_id_not_numbered") == .hunkIDInvalid)
    #expect(reason("hunk_id_zero") == .hunkIDInvalid)
    #expect(reason("header_is_not_a_hunk_header") == .headerInvalid("h1"))
    #expect(reason("header_with_a_line_break") == .headerInvalid("h1"))
    #expect(reason("line_without_a_marker") == .lineInvalid(hunk: "h1", index: 0))
    #expect(reason("line_with_a_line_break") == .lineInvalid(hunk: "h1", index: 0))
    #expect(reason("line_with_a_paragraph_separator") == .lineInvalid(hunk: "h1", index: 0))
    #expect(reason("line_with_a_vertical_tab") == .lineInvalid(hunk: "h1", index: 0))
    #expect(reason("hunk_without_lines") == .linesInvalid("h1"))
    #expect(reason("no_hunks") == .noHunks)
    #expect(reason("path_with_a_line_break") == .pathInvalid)
    #expect(reason("path_that_is_empty") == .pathInvalid)
    #expect(reason("no_path") == .pathInvalid)
    #expect(reason("unknown_key_on_a_hunk") == .hunkKeyUnknown("approved"))
    #expect(reason("two_hunks_with_one_id") == .hunkIDRepeated("h1"))
    #expect(reason("no_kind") == .kindMissingOrUnknown)
    #expect(reason("unknown_kind") == .kindMissingOrUnknown)
    #expect(reason("rename_without_old_path") == .oldPathInvalid)
    #expect(reason("old_path_on_a_modify") == .oldPathInvalid)
    #expect(reason("anchor_that_is_unknown") == .anchorUnknown("h1"))
    #expect(reason("anchor_end_on_a_hunk_that_is_not_last") != nil)
  }

  // MARK: What the examples do not list

  @Test("a hunk that is not an object is a refusal; the typed view would have dropped it silently")
  func hunkNotAnObject() throws {
    let request = diff(hunks: [hunk("h1"), "not a hunk", hunk("h2")])
    #expect(problem(request) == .hunkNotAnObject)
    #expect(request.hunks?.count == 2, "the typed view drops it: a review of less than the agent asked")
  }

  @Test("a hunk with a key this build does not know is not shown")
  func unknownHunkKey() {
    var object = hunk().objectValue ?? [:]
    object["context"] = 5
    #expect(problem(diff(hunks: [.object(object)])) == .hunkKeyUnknown("context"))
  }

  @Test("1 to 200 hunks, 1 to 400 lines in a hunk")
  func bounds() throws {
    let many = (1...200).map { hunk("h\($0)") }
    #expect(try read(diff(hunks: many)).hunks.count == 200)
    #expect(problem(diff(hunks: many + [hunk("h201")])) == .tooManyHunks)
    #expect(problem(diff(hunks: [])) == .noHunks)

    let tall = [" a"] + Array(repeating: "+x", count: 398) + [" b"]
    #expect(try read(diff(hunks: [hunk(header: "@@ -10,2 +10,400 @@", lines: tall)])).hunks[0].lines.count == 400)
    #expect(problem(diff(hunks: [hunk(header: "@@ -10,2 +10,401 @@", lines: tall + ["+x"])])) == .linesInvalid("h1"))
  }

  @Test("hunk ids are h followed by 1 to 3 digits, no leading zero")
  func hunkIDs() {
    for good in ["h1", "h9", "h10", "h99", "h100", "h999"] {
      #expect(ReviewDiff.isHunkID(good), "\(good)")
    }

    for bad in ["", "h", "h0", "h01", "h1000", "H1", "1", "hh1", "h1 ", "h-1", "h١"] {
      #expect(!ReviewDiff.isHunkID(bad), "\(bad)")
    }
  }

  // MARK: Headers

  @Test("the header is @@ -a[,b] +c[,d] @@ and, after a space, the section; a count left out is 1")
  func headers() throws {
    let plain = try #require(ReviewDiff.parseHeader("@@ -3,4 +5,6 @@"))
    #expect(plain.old == ReviewDiff.Span(start: 3, count: 4) && plain.new == ReviewDiff.Span(start: 5, count: 6))
    #expect(plain.section == nil)

    let short = try #require(ReviewDiff.parseHeader("@@ -7 +8 @@ func main() {"))
    #expect(short.old == ReviewDiff.Span(start: 7, count: 1) && short.new == ReviewDiff.Span(start: 8, count: 1))
    #expect(short.section == "func main() {")

    #expect(ReviewDiff.parseHeader("@@ -0,0 +1,2 @@")?.old == ReviewDiff.Span(start: 0, count: 0))
    #expect(ReviewDiff.parseHeader("@@ -123456789,1 +1 @@") != nil, "nine digits")
    #expect(ReviewDiff.parseHeader("@@ -1234567890,1 +1 @@") == nil, "ten digits")
    #expect(ReviewDiff.parseHeader("@@ -1,2 +1,2 @@\tx") == nil, "the section starts after one space")

    for bad in ["", "@@", "@@ nonsense @@", "@@ -1,2 +1,2", "@@ -a +1 @@", "@@ -1, +1 @@", "@@ -1 +1 @@x", "@ -1 +1 @@", "@@ +1 -1 @@"] {
      #expect(ReviewDiff.parseHeader(bad) == nil, "\(bad)")
    }
  }

  @Test("a header whose counts disagree with its lines is refused")
  func countsAgree() throws {
    #expect(problem(diff(hunks: [hunk(header: "@@ -10,3 +10,4 @@")])) == .countsDisagree("h1"))
    #expect(problem(diff(hunks: [hunk(header: "@@ -10,4 +10,3 @@")])) == .countsDisagree("h1"))
    #expect(problem(diff(hunks: [hunk(header: "@@ -10 +10 @@")])) == .countsDisagree("h1"), "a count left out is 1")
    #expect(try read(diff(hunks: [hunk(header: "@@ -10,3 +10,3 @@")])).hunks.count == 1)

    // The no-newline note is no line of either side.
    let note = hunk(header: "@@ -10,3 +10,3 @@", lines: [" a", " c", "-b", "\\ No newline at end of file", "+B", "\\ No newline at end of file"])
    #expect(try read(diff(hunks: [note])).hunks[0].lines.count == 6)
  }

  @Test("git's no-newline note follows a changed line in the last hunk, and nowhere else")
  func noNewlineNote() {
    let note = "\\ No newline at end of file"
    let afterContext = hunk(header: "@@ -10,3 +10,3 @@", lines: [" a", note, "-b", "+B", " c"])
    #expect(problem(diff(hunks: [afterContext])) == .noNewlineMisplaced("h1"), "after a context line")

    let first = hunk(header: "@@ -10,3 +10,3 @@", lines: [note, " a", "-b", "+B", " c"])
    #expect(problem(diff(hunks: [first])) == .noNewlineMisplaced("h1"), "as the first line")

    let early = hunk("h1", header: "@@ -10,3 +10,3 @@", lines: [" a", "-b", note, "+B", " c"])
    #expect(problem(diff(hunks: [early, hunk("h2")])) == .noNewlineMisplaced("h1"), "not in the last hunk")

    // Directly after the LAST added line only: another added line follows the note.
    let notLastAdded = hunk(header: "@@ -10,1 +10,3 @@", lines: [" a", "+b", note, "+c"])
    #expect(problem(diff(hunks: [notLastAdded])) == .noNewlineMisplaced("h1"), "a line of the note's side follows")

    // And no context line after a note.
    let contextAfter = hunk(header: "@@ -10,3 +10,3 @@", lines: [" a", "-b", note, "+B", note, " c"])
    #expect(problem(diff(hunks: [contextAfter])) == .noNewlineMisplaced("h1"), "a context line follows")

    let twice = hunk(header: "@@ -10,2 +10,2 @@", lines: [" a", "-b", note, note, "+B"])
    #expect(problem(diff(hunks: [twice])) == .noNewlineMisplaced("h1"), "a note after a note")

    let afterRemovedNotLast = hunk(header: "@@ -10,3 +10,1 @@", lines: [" a", "-b", note, "-c"])
    #expect(problem(diff(hunks: [afterRemovedNotLast])) == .noNewlineMisplaced("h1"), "not the last removed line")

    // The allowed shapes: after the last removed line, the last added line, or both.
    let both = hunk(header: "@@ -10,2 +10,2 @@", lines: [" a", "-b", note, "+B", note])
    #expect(problem(diff(hunks: [both])) == nil)
    let addedOnly = hunk(header: "@@ -10,1 +10,2 @@", lines: [" a", "+b", note])
    #expect(problem(diff(hunks: [addedOnly])) == nil)
    let removedOnly = hunk(header: "@@ -10,2 +10,1 @@", lines: [" a", "-b", note])
    #expect(problem(diff(hunks: [removedOnly])) == nil)
    let afterBothBlocks = hunk(header: "@@ -10,2 +10,2 @@", lines: [" a", "-b", "+B", note])
    #expect(problem(diff(hunks: [afterBothBlocks])) == nil, "the note of the new side only")
    let moreAddedAfterRemovedNote = hunk(header: "@@ -10,2 +10,3 @@", lines: [" a", "-b", note, "+c", "+d", note])
    #expect(problem(diff(hunks: [moreAddedAfterRemovedNote])) == nil)
  }

  // MARK: Anchors

  @Test("a hunk is pinned to the start when its old start is 0 or 1, to the end when no context follows its last change")
  func anchors() throws {
    // Declared and earned: the same.
    let start = hunk(header: "@@ -1,3 +1,3 @@", anchor: "start")
    #expect(try read(diff(hunks: [start])).hunks[0].anchor == .start)

    let end = hunk(header: "@@ -9,2 +9,3 @@", lines: [" a", " b", "+c"], anchor: "end")
    #expect(try read(diff(hunks: [end])).hunks[0].anchor == .end)

    let both = hunk(header: "@@ -1,1 +1,2 @@", lines: [" a", "+b"], anchor: "both")
    #expect(try read(diff(hunks: [both])).hunks[0].anchor == .both)

    // The no-newline note after the last change is not context.
    let note = hunk(
      header: "@@ -9,2 +9,3 @@", lines: [" a", " b", "+c", "\\ No newline at end of file"], anchor: "end")
    #expect(try read(diff(hunks: [note])).hunks[0].anchor == .end)

    // Earned and not declared: still labelled (the frame left the label out), never presented as a line.
    let unlabelled = hunk(header: "@@ -9,2 +9,3 @@", lines: [" a", " b", "+c"])
    #expect(try read(diff(hunks: [unlabelled])).hunks[0].anchor == .end)
    let unlabelledStart = hunk(header: "@@ -1,3 +1,3 @@")
    #expect(try read(diff(hunks: [unlabelledStart])).hunks[0].anchor == .start)

    // Declared and not earned: the frame says something the lines do not bear out.
    #expect(problem(diff(hunks: [hunk(anchor: "end")])) == .anchorFalse("h1"))
    #expect(problem(diff(hunks: [hunk(anchor: "start")])) == .anchorFalse("h1"))
    #expect(problem(diff(hunks: [hunk(header: "@@ -1,3 +1,3 @@", anchor: "both")])) == .anchorFalse("h1"))
    #expect(problem(diff(hunks: [hunk(anchor: "middle")])) == .anchorUnknown("h1"))
  }

  @Test("only the last hunk can be pinned to the end of the file")
  func endOnlyOnTheLast() throws {
    let pinned = hunk("h1", header: "@@ -9,2 +9,3 @@", lines: [" a", " b", "+c"], anchor: "end")
    #expect(problem(diff(hunks: [pinned, hunk("h2")])) == .anchorNotOnLastHunk("h1"))
    #expect(try read(diff(hunks: [hunk("h1"), pinned.withID("h2")])).hunks.map(\.anchor) == [nil, .end])

    // A start-pinned first hunk is fine with others after it.
    let first = hunk("h1", header: "@@ -1,3 +1,3 @@", anchor: "start")
    #expect(try read(diff(hunks: [first, hunk("h2")])).hunks.map(\.anchor) == [.start, nil])
  }

  // MARK: The file

  @Test("a rename names its old path, and nothing else does; a new file holds only added lines, a deleted one only removed")
  func kinds() throws {
    let renamed = diff(kind: "rename", path: "b.txt", oldPath: "a.txt", hunks: [hunk()])
    #expect(try read(renamed).oldPath == "a.txt")
    #expect(problem(diff(kind: "rename", path: "b.txt", hunks: [hunk()])) == .oldPathInvalid)
    #expect(problem(diff(kind: "rename", path: "b.txt", oldPath: "", hunks: [hunk()])) == .oldPathInvalid)
    #expect(problem(diff(kind: "modify", oldPath: "a.txt", hunks: [hunk()])) == .oldPathInvalid)
    #expect(problem(diff(kind: "new", oldPath: "a.txt", hunks: [hunk()])) != nil)

    let added = hunk(header: "@@ -0,0 +1,2 @@", lines: ["+a", "+b"], anchor: "both")
    #expect(try read(diff(kind: "new", hunks: [added])).kind == .new)
    #expect(problem(diff(kind: "new", hunks: [hunk()])) == .kindAndLinesDisagree("h1"))

    // The header says it too: `-0,0` for a new file, `+0,0` for a deleted one.
    let newWithOldLines = hunk(header: "@@ -1,2 +1,2 @@", lines: ["+a", "+b"])
    #expect(problem(diff(kind: "new", hunks: [newWithOldLines])) == .countsDisagree("h1"))
    let newAtLineOne = hunk(header: "@@ -1,0 +1,2 @@", lines: ["+a", "+b"])
    #expect(problem(diff(kind: "new", hunks: [newAtLineOne])) == .kindAndHeaderDisagree("h1"))
    let deleteAtZero = hunk(header: "@@ -1,2 +1,0 @@", lines: ["-a", "-b"])
    #expect(problem(diff(kind: "delete", hunks: [deleteAtZero])) == .kindAndHeaderDisagree("h1"))

    let removed = hunk(header: "@@ -1,2 +0,0 @@", lines: ["-a", "-b"], anchor: "both")
    #expect(try read(diff(kind: "delete", hunks: [removed])).kind == .delete)
    #expect(problem(diff(kind: "delete", hunks: [added])) != nil)
    #expect(problem(diff(kind: "delete", hunks: [hunk()])) == .kindAndLinesDisagree("h1"))
  }

  @Test("a path is 1 to 300 code points of one line; an old path too")
  func paths() throws {
    #expect(try read(diff(path: String(repeating: "a", count: 300), hunks: [hunk()])).path.count == 300)
    #expect(problem(diff(path: String(repeating: "a", count: 301), hunks: [hunk()])) == .pathInvalid)
    #expect(problem(diff(path: "a\nb", hunks: [hunk()])) == .pathInvalid)
    #expect(problem(diff(path: "a\u{2028}b", hunks: [hunk()])) == .pathInvalid)
    #expect(problem(diff(path: "a\rb", hunks: [hunk()])) == .pathInvalid)
    #expect(problem(diff(kind: "rename", path: "b", oldPath: "x\ny", hunks: [hunk()])) == .oldPathInvalid)

    // Never absolute, never a `..` or `.git` segment (§7).
    for bad in [
      "/etc/passwd", "../x", "a/../b", "a/..", "..", ".git/config", "a/.git/hooks", "a/.GIT", ".git", ".Git/x",
      "a//b", "a/", "/", "./a", "a/./b", ".", " a", "a /b", "a/ b", "a ", "a/b.", "a./b", "dir\\file", "a\\b/c",
      "a\u{0007}b", "a\tb", "a\u{202E}b", "a\u{200B}b", "a\u{16FE4}b"
    ] {
      #expect(problem(diff(path: bad, hunks: [hunk()])) == .pathInvalid, "\(bad)")
      #expect(problem(diff(kind: "rename", path: "b", oldPath: bad, hunks: [hunk()])) == .oldPathInvalid, "\(bad)")
    }

    for good in ["a.txt", "a/b/c.go", ".gitignore", "a/.github/x.yml", "a..b", "dir/..hidden", "x/.gitkeep"] {
      #expect(try read(diff(path: good, hunks: [hunk()])).path == good, "\(good)")
    }

    // At most four combining marks in a row, as the gateway holds a verbatim line to; five are refused,
    // in a path and in an old path, and a base letter in between starts the count again.
    let marks = String(repeating: "\u{0301}", count: 4)
    #expect(try read(diff(path: "a" + marks + ".txt", hunks: [hunk()])).path == "a" + marks + ".txt")
    #expect(try read(diff(path: "a" + marks + "b" + marks, hunks: [hunk()])).path == "a" + marks + "b" + marks)

    for bad in ["a" + marks + "\u{0301}", "dir/a" + marks + "\u{20DD}.txt"] {
      #expect(problem(diff(path: bad, hunks: [hunk()])) == .pathInvalid, "\(bad)")
      #expect(problem(diff(kind: "rename", path: "b", oldPath: bad, hunks: [hunk()])) == .oldPathInvalid, "\(bad)")
      #expect(ReviewDiff.isPath(bad) == false)
    }

    // Inner spaces and dots are fine.
    #expect(try read(diff(path: "my docs/a.b.txt", hunks: [hunk()])).path == "my docs/a.b.txt")
  }

  @Test("U+16FE4, the Khitan filler, is refused in a diff line (4041) and in a confirm field (4040)")
  func khitanFiller() throws {
    let filler = "\u{16FE4}"
    #expect(!DiffTextRules.isShowable("a" + filler + "b"))
    #expect(ReviewDiff.parseLine("+a" + filler) == nil)
    #expect(problem(diff(hunks: [hunk(lines: [" a", "-b" + filler, "+B", " c"])])) == .lineInvalid(hunk: "h1", index: 1))
    #expect(DraftText.isNotVerbatim(Unicode.Scalar(0x16FE4)!))
    #expect(!ConfirmFieldRules.isLine("pay" + filler, max: 40))
    #expect(ConfirmFieldRules.isLine("pay", max: 40))
  }

  @Test("an unknown kind is not shown; nor is a missing hunks list or a hunks list that is not a list")
  func shape() {
    #expect(problem(diff(kind: "copy", hunks: [hunk()])) == .kindMissingOrUnknown)

    var json = diff(hunks: [hunk()]).json
    json["hunks"] = "h1"
    #expect(problem(ReviewDiffParams(json: json)) == .noHunks)
    json["hunks"] = nil
    #expect(problem(ReviewDiffParams(json: json)) == .noHunks)
    json = diff(hunks: [hunk()]).json
    json["kind"] = nil
    #expect(problem(ReviewDiffParams(json: json)) == .kindMissingOrUnknown)
  }

  // MARK: Lines

  @Test("a line is a marker and its text, or exactly git's no-newline note; at most 500 code points")
  func lines() throws {
    #expect(ReviewDiff.parseLine(" ctx") == ReviewDiff.Line(mark: .context, text: "ctx"))
    #expect(ReviewDiff.parseLine("+add") == ReviewDiff.Line(mark: .added, text: "add"))
    #expect(ReviewDiff.parseLine("-del") == ReviewDiff.Line(mark: .removed, text: "del"))
    #expect(ReviewDiff.parseLine(" ") == ReviewDiff.Line(mark: .context, text: ""))
    #expect(ReviewDiff.parseLine("+") == ReviewDiff.Line(mark: .added, text: ""))
    #expect(ReviewDiff.parseLine("\\ No newline at end of file")?.mark == .noNewline)

    #expect(ReviewDiff.parseLine("") == nil)
    #expect(ReviewDiff.parseLine("x") == nil)
    #expect(ReviewDiff.parseLine("\\ No newline at end of file ") == nil, "only exactly the note")
    #expect(ReviewDiff.parseLine("\\ No newline") == nil)
    #expect(ReviewDiff.parseLine("@@ -1 +1 @@") == nil)

    #expect(ReviewDiff.parseLine("+" + String(repeating: "x", count: 499)) != nil, "500 with the marker")
    #expect(ReviewDiff.parseLine("+" + String(repeating: "x", count: 500)) == nil)
    #expect(ReviewDiff.parseLine("+" + String(repeating: "😀", count: 499)) != nil, "code points, not UTF-16 units")
    #expect(ReviewDiff.parseLine("+" + String(repeating: "😀", count: 500)) == nil)
    #expect(ReviewDiff.parseLine("+" + String(repeating: "\t", count: 11) + "x") != nil, "a tab counts as one code point")
  }

  @Test("a line that shows something other than itself refuses the frame")
  func hiddenInLines() {
    for text in ["a\u{202E}b", "a\u{200B}b", "a\u{2066}b", "a\u{00A0}b", "a\u{FEFF}b", "a\u{0007}b", "a\u{0000}b", "a\rb", "a\u{0085}b", "a\u{3164}b"] {
      #expect(problem(diff(hunks: [hunk(lines: [" a", "-\(text)", "+B", " c"])])) == .lineInvalid(hunk: "h1", index: 1), "\(text.unicodeScalars.map(\.value))")
    }

    // Visible, ordinary text is fine, in any script.
    #expect(problem(diff(hunks: [hunk(lines: [" naïve café", "-日本語 Ωmega 😀", "+B", " c"])])) == nil)
  }

  @Test("a hunk header passes the same rules as a line")
  func headerCharacters() {
    #expect(problem(diff(hunks: [hunk(header: "@@ -10,3 +10,3 @@ f\u{202E}x")])) == .headerInvalid("h1"))
    #expect(problem(diff(hunks: [hunk(header: "@@ -10,3 +10,3 @@ f ")])) == .headerInvalid("h1"), "no whitespace at the end")
    #expect(problem(diff(hunks: [hunk(header: "@@ -10,3 +10,3 @@ \tfunc")])) == nil, "a tab in the section text is allowed")
    #expect(problem(diff(hunks: [hunk(header: "@@ -10,3 +10,3 @@ " + String(repeating: "x", count: 200))])) == .headerInvalid("h1"), "over 200")
  }
}

private extension JSONValue {
  /// A hunk with another id.
  func withID(_ id: String) -> JSONValue {
    var object = objectValue ?? [:]
    object["id"] = .string(id)
    return .object(object)
  }
}
