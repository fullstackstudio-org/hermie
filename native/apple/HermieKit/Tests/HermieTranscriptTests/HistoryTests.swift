import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// Task 12's acceptance and what the golden corpus cannot show about the history
/// side of the engine (`rowsToItems`, `reconcile`, `prependHistory`,
/// `reconcileTail`, the cache).
@Suite struct HistoryTests {
  static let historyOperations = GoldenRegistry.owners.filter { $0.value.hasPrefix("task 12") }.map(\.key).sorted()

  /// Every recorded history call passes, and the suites that are only history and
  /// helpers pass in full.
  ///
  /// `reconcile` and `cache` also record reducer calls (`applyEvent`,
  /// `beginLocalTurn`, …) that Task 11 ports, so until those are registered they
  /// are pinned on their history calls and on having no failure at all; once the
  /// reducer lands they can be pinned at 100 % like the others.
  @Test func historySuitesPassInFull() throws {
    let report = GoldenReport.shared

    for op in Self.historyOperations {
      report.expectCoverage(op: op, atLeast: 1.0)
    }

    for suite in ["rows-to-items", "cron-delivery", "bot-dm"] {
      report.expectCoverage(suite: suite, atLeast: 1.0)
    }

    for name in ["reconcile", "cache"] where report.filter.includes(suite: name) {
      let suite = try #require(report.suites[name])
      #expect(suite.failures.isEmpty, "suite \(name): \(suite.failures.count) calls fail")
      for op in Self.historyOperations {
        guard let stats = suite.ops[op] else { continue }
        #expect(stats.passed == stats.calls, "suite \(name), \(op): \(stats.passed)/\(stats.calls) pass")
      }
    }

    if !report.filter.isActive {
      let calls = Self.historyOperations.compactMap { report.operations[$0] }.reduce(OpStats(), +)
      print("history operations: \(calls.passed)/\(calls.calls) recorded calls pass")
      #expect(calls.calls == 1_237, "the corpus records 1,237 history calls")
      #expect(calls.passed == calls.calls)
    }
  }

  /// The branches the corpus never reaches, against results the TypeScript engine
  /// produced for the same inputs (`HistoryBranchCases`).
  @Test func unrecordedBranchesMatchTheReference() throws {
    guard case .array(let cases) = try JSONValue(parsing: HistoryBranchCases.json) else {
      Issue.record("the reference cases are not an array")
      return
    }
    #expect(cases.count == 39)

    for (index, json) in cases.enumerated() {
      let name = json["name"]?.stringValue ?? "case \(index)"
      let call = try GoldenCall(index: index, json: json)

      switch GoldenRunner.check(call) {
      case .passed(let moduloNull):
        #expect(!moduloNull, "\(name): passed only with null and absent treated as equal")
      case .failed(let lines):
        Issue.record(Comment(rawValue: "\(call.op) — \(name):\n  " + lines.joined(separator: "\n  ")))
      case .pending:
        Issue.record("\(call.op) is not registered")
      }
    }
  }

  /// `reconcile` asks one question where the TypeScript asked two
  /// (`isMatchable(item) ? matchKeyOf(item) : undefined`); for every item the corpus
  /// projects, and a few made to sit on the edges, the answers are the same.
  @Test func theFusedMatchKeyAgreesWithItsParts() throws {
    var items: [TranscriptItem] = []
    for name in GoldenCorpus.suiteNames {
      for call in try GoldenCorpus.loadSuite(name).tests.flatMap(\.calls) where call.op == "rowsToItems" {
        if case .array(let result)? = call.result {
          items += try result.map { try TranscriptItem(decoding: $0) }
        }
      }
    }
    let base = ItemBase(id: "x", seq: 0, origin: .live, version: 0)
    func dispatch(_ message: String) -> TranscriptItem {
      .botDmOut(
        BotDmOutItem(base: base, toolID: "m", target: "Writer", targetHandle: "", message: message, dispatch: BotDmDispatch(status: .unknown))
      )
    }
    items += [
      dispatch(""),
      dispatch("go"),
      .user(UserItem(base: base, text: " ", attachments: ["@image:/a.png"])),
      .user(UserItem(base: base, text: "", attachments: [])),
      .notice(NoticeItem(base: base, noticeKind: .notice, title: "", body: " ")),
      .unknown(UnknownItem(kindName: "hologram", base: base))
    ]
    #expect(items.count > 500)

    for item in items {
      let expected = isMatchable(item) ? "\(item.kind.rawValue)\n\(itemMatchKey(item))" : nil
      #expect(matchKeyIfMatchable(item) == expected, "\(item.jsonValue)")
    }
  }

  /// `snapshotForCache` keeps the LAST 200 cacheable items, and the row id it
  /// remembers is the last one among those.
  @Test func theCacheKeepsTheLastTwoHundredSettledItems() {
    let rows = (0..<260).map { index -> TranscriptRow in
      TranscriptRow(json: [
        "role": .string(index % 2 == 0 ? "user" : "assistant"), "row_id": .number(Double(index)), "text": .string("m\(index)")
      ])
    }
    var state = reconcile(createChatState("bot", "s", "s"), rowsToItems(rows, .rpc))
    let optimistic = ItemBase(id: "o:1", seq: 999_000, origin: .optimistic, version: 0)
    state.items["o:1"] = .user(UserItem(base: optimistic, text: "unsent", pending: true))
    state.order.append("o:1")

    let snapshot = snapshotForCache(state, now: 7)
    #expect(snapshot.items.count == cacheItemLimit)
    #expect(snapshot.items.first?.id == "r:60")
    #expect(snapshot.items.last?.id == "r:259")
    #expect(snapshot.lastRowID == 259)
    #expect(snapshot.updatedAt == 7)

    let restored = stateFromCache("bot", SessionIDs(storedSessionID: "s", resolvedSessionID: "s"), snapshot)
    #expect(restored.order == snapshot.items.map(\.id))
    #expect(restored.turn.nextSeq == cacheItemLimit * seqStep)
    #expect(restored.lastSeenRowID == 259)
    #expect(restored.hydration == .cached)
    // No session id on the watermark: read cold.
    #expect(restored.lastSeq == 0)

    var future = snapshot
    future.format = cacheFormat + 1
    #expect(stateFromCache("bot", SessionIDs(storedSessionID: "s", resolvedSessionID: "s"), future).order.isEmpty)
  }

  /// The cache shape round-trips through `Codable`, unknown keys included.
  @Test func theCachedTranscriptRoundTrips() throws {
    let json: JSONValue = [
      "format": 1, "items": [["id": "r:1", "kind": "user", "seq": 0, "origin": "history", "version": 0, "text": "hi", "rowId": 1]],
      "subagents": [], "lastRowId": 1, "lastSeq": 3, "lastSeqSessionId": "rt", "epoch": "e", "updatedAt": 1790000000000,
      "writtenBy": "a newer build"
    ]
    let snapshot = try CachedTranscript(decoding: json)
    #expect(snapshot.jsonValue == json)
    let data = try JSONEncoder().encode(snapshot)
    #expect(try JSONDecoder().decode(CachedTranscript.self, from: data) == snapshot)

    let classified = classifyUserRow("[Cron delivery: Brief]\nAll green.")
    let encoded = try JSONEncoder().encode(classified)
    #expect(try JSONDecoder().decode(UserRowClass.self, from: encoded) == classified)
    #expect(try UserRowClass(decoding: ["kind": "bot_dm_reply"]) == .botDmReply)
    #expect(throws: TranscriptDecodingError.self) { try UserRowClass(decoding: ["kind": "shrug"]) }
  }

  /// Reproduced as the TypeScript answers it: when an older page and the held
  /// transcript both carry a POSITIONAL id, `rebuild` frees the later of the two,
  /// and in `prependHistory` the later one is the item already on screen — so it is
  /// the one renamed (and remounted), not the page's.
  @Test func prependHistoryRenamesTheHeldItemOnAPositionalCollision() {
    let held = reconcile(createChatState("bot", "s", "s"), rowsToItems([TranscriptRow(json: ["role": "user", "content": "new"])], .rest))
    #expect(held.order == ["user:0"])

    let older = rowsToItems([TranscriptRow(json: ["role": "user", "content": "old"])], .rest)
    let next = prependHistory(held, older)
    #expect(next.order == ["user:0", "user:0#2"])
    #expect(next.items["user:0"]?.asUser?.text == "old")
    #expect(next.items["user:0#2"]?.asUser?.text == "new")
  }

  /// JavaScript truthiness, which decides whether a tool row keeps odd `args`.
  @Test func truthinessIsJavaScripts() {
    func truthy(_ value: JSONValue?) -> Bool { JS.truthy(value) }
    #expect(!truthy(nil) && !truthy(.null) && !truthy(false) && !truthy(0) && !truthy(""))
    #expect(truthy(true) && truthy(-1) && truthy("0") && truthy([]) && truthy([:]))
  }
}

/// How long the history side takes on a long chat, in the debug build the tests
/// use. Each operation must stay well under a second on 5,000 rows; the numbers
/// are printed.
@Suite(.serialized) struct HistoryBenchmarkTests {
  static let rowCount = 5_000

  /// A long, mixed history: prompts (some with files), replies with reasoning, tool
  /// calls, dispatches to a teammate, their deliveries, and the teammate's own
  /// messages.
  static func rows(_ count: Int) -> [TranscriptRow] {
    let delivery = #"/usr/bin/python3 /opt/hermes/tools/bot_mode_dm.py --run-delivery query-file /root/.hermes/dm/x.json hermes -p writer chat -c "Bot Chat" -Q -q @/root/.hermes/dm/x.json"#
    var out: [TranscriptRow] = []
    out.reserveCapacity(count)
    var row = 0

    while out.count < count {
      let turn = row / 10
      func add(_ json: JSONObject) {
        guard out.count < count else { return }
        var json = json
        json["row_id"] = .number(Double(row))
        json["timestamp"] = .number(1_700_000_000 + Double(row))
        out.append(TranscriptRow(json: json))
        row += 1
      }

      add(["role": "user", "text": .string(turn % 7 == 0 ? "Look at @file:/srv/f\(turn).ts please" : "Question number \(turn): what changed in the build?")])
      add(["role": "assistant", "text": "Let me check.", "reasoning": .string("Thinking about turn \(turn).")])
      add(["role": "tool", "name": "read_file", "tool_id": .string("call-\(turn)"), "context": "read_file(CHANGELOG.md)", "args": ["path": "CHANGELOG.md"]])
      add(["role": "assistant", "text": .string("The build for turn \(turn) is green; three tests were added and one flaky test was fixed.")])
      if turn % 5 == 0 {
        add(["role": "tool", "name": "message_agent", "tool_id": .string("dm-\(turn)"), "args": ["target": "writer", "message": .string("Draft notes \(turn)")]])
        add([
          "role": "user", "display_kind": "process_complete",
          "text": .string("[IMPORTANT: Background process proc-\(turn) completed (exit code 0).\nCommand: \(delivery)\nOutput:\nMessage from Writer (@writer): drafted \(turn)]")
        ])
        add(["role": "user", "text": .string("Message from 🤖 Writer (@writer): follow-up \(turn)")])
        add(["role": "assistant", "text": "Thanks, noted."])
      }
      add(["role": "user", "text": "[System: The active model for this chat has changed to k3.]", "display_kind": "model_switch"])
      add(["role": "assistant", "text": "Anything else?"])
    }

    return out
  }

  static func timed<T>(_ label: String, _ body: () -> T) -> (T, Double) {
    let start = ContinuousClock.now
    let value = body()
    let seconds = GoldenRunner.seconds(since: start)
    print(String(format: "history benchmark: %@ %.1f ms", label, seconds * 1000))
    return (value, seconds)
  }

  @Test func fiveThousandRowsConvertAndReconcileWellUnderASecond() {
    let rows = Self.rows(Self.rowCount)
    let empty = createChatState("bench", "stored", "stored")
    let limit = 1.0

    let (items, convert) = Self.timed("rowsToItems(5000 rows)") { rowsToItems(rows, .rpc) }
    let (hydrated, first) = Self.timed("reconcile, first hydration") { reconcile(empty, items) }
    let (_, again) = Self.timed("reconcile, re-hydration by row id") { reconcile(hydrated, items) }

    // Every live item without a row id: the re-hydration pairs all of them on what
    // they say, the slowest path.
    var unpersisted = hydrated
    for id in unpersisted.order {
      unpersisted.items[id]?.rowID = nil
      unpersisted.items[id]?.origin = .live
    }
    let (byKey, matched) = Self.timed("reconcile, re-hydration by match key") { reconcile(unpersisted, items) }

    let tailRows = Array(rows.suffix(20)) + Self.rows(25).suffix(5).map { row in
      var json = row.json
      json["row_id"] = .number(Double(Self.rowCount + (json["row_id"]?.intValue ?? 0)))
      return TranscriptRow(json: json)
    }
    let tailItems = rowsToItems(tailRows, .rpc)
    let (_, tail) = Self.timed("reconcileTail(25 rows)") { reconcileTail(hydrated, tailItems) }

    let half = items.count / 2
    let newer = reconcile(empty, Array(items[half...]))
    let (_, prepend) = Self.timed("prependHistory(half)") { prependHistory(newer, Array(items[..<half])) }

    let (snapshot, snap) = Self.timed("snapshotForCache") { snapshotForCache(hydrated, now: 0) }
    let (_, restore) = Self.timed("stateFromCache") {
      stateFromCache("bench", SessionIDs(storedSessionID: "stored", resolvedSessionID: "stored"), snapshot)
    }

    #expect(items.count > 4_000)
    #expect(hydrated.order.count == items.count)
    #expect(byKey.order == hydrated.order, "every item paired on its key kept its id")
    for (label, seconds) in [
      ("rowsToItems", convert), ("first reconcile", first), ("reconcile by row id", again),
      ("reconcile by key", matched), ("reconcileTail", tail), ("prependHistory", prepend),
      ("snapshotForCache", snap), ("stateFromCache", restore)
    ] {
      #expect(seconds < limit, "\(label) took \(seconds) s")
    }
  }
}
