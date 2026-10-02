import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

// Inputs the TypeScript engine is never handed in its tests and the native app
// must survive anyway: a state restored from a cache someone else wrote, a
// prompt pasted from a file listing. None of them is in the golden corpus, so
// each is pinned here.

@Suite struct SubagentTreeLimitTests {
  static func subagent(_ id: String, parent: String?, startedAt: Double = 1) -> Subagent {
    Subagent(
      id: id,
      parentID: parent,
      goal: "goal \(id)",
      taskIndex: 0,
      taskCount: 1,
      status: .running,
      startedAt: startedAt,
      updatedAt: startedAt,
      filesRead: [],
      filesWritten: [],
      stream: []
    )
  }

  static func state(_ subagents: [Subagent]) -> ChatState {
    var state = createChatState("bot", "stored", "resolved")
    state.subagents = JSRecord(subagents.map { ($0.id, $0) })
    return state
  }

  /// The deepest a tree is, counted in nodes, without recursing.
  static func height(_ roots: [SubagentNode]) -> Int {
    var height = 0
    var level = roots
    while !level.isEmpty {
      height += 1
      level = level.flatMap(\.children)
    }
    return height
  }

  static func count(_ roots: [SubagentNode]) -> Int {
    var total = 0
    var level = roots
    while !level.isEmpty {
      total += level.count
      level = level.flatMap(\.children)
    }
    return total
  }

  @Test func aLongChainIsCutIntoTreesOfBoundedDepth() throws {
    let links = 5_000
    let chain = (0..<links).map { index in
      Self.subagent("s\(index)", parent: index == 0 ? nil : "s\(index - 1)", startedAt: Double(index))
    }
    let tree = subagentTree(Self.state(chain))

    // Every node is kept; none is more than `subagentTreeMaxDepth` levels below a root.
    #expect(Self.count(tree) == links)
    #expect(Self.height(tree) == subagentTreeMaxDepth + 1)
    let perTree = subagentTreeMaxDepth + 1
    #expect(tree.count == (links + perTree - 1) / perTree)
    // The chain keeps its order: each promoted root starts where the last tree ended.
    #expect(tree.map(\.subagent.id).prefix(3) == ["s0", "s\(perTree)", "s\(2 * perTree)"])

    // Hashing, encoding and freeing the result stay shallow.
    var hasher = Hasher()
    hasher.combine(tree)
    _ = hasher.finalize()
    let encoded = JSONValue.array(tree.map(\.jsonValue))
    #expect(try encoded.canonicalString().isEmpty == false)
  }

  @Test func aShallowTreeIsTheTypeScriptTree() {
    let tree = subagentTree(
      Self.state([
        Self.subagent("root", parent: nil, startedAt: 1),
        Self.subagent("b", parent: "root", startedAt: 3),
        Self.subagent("a", parent: "root", startedAt: 2),
        Self.subagent("leaf", parent: "a", startedAt: 4),
        Self.subagent("orphan", parent: "gone", startedAt: 0)
      ])
    )
    #expect(tree.map(\.subagent.id) == ["orphan", "root"])
    #expect(tree[1].children.map(\.subagent.id) == ["a", "b"])
    #expect(tree[1].children[0].children.map(\.subagent.id) == ["leaf"])
  }

  /// Parents in a cycle hang under no root, and the TypeScript's walk drops them.
  @Test func aCycleOfParentsIsDroppedNotFollowed() {
    let tree = subagentTree(
      Self.state([
        Self.subagent("a", parent: "b"),
        Self.subagent("b", parent: "a"),
        Self.subagent("c", parent: "a"),
        Self.subagent("self", parent: "self"),
        Self.subagent("root", parent: nil)
      ])
    )
    #expect(tree.map(\.subagent.id) == ["root"])
    #expect(tree[0].children.isEmpty)
  }
}

@Suite struct CounterOverflowTests {
  static func assistant(_ id: String, version: Int, seq: Int = 0, rowID: Int? = nil) -> TranscriptItem {
    .assistant(
      AssistantItem(
        base: ItemBase(id: id, seq: seq, rowID: rowID, origin: .live, version: version),
        text: "hi",
        streaming: false,
        interim: false
      )
    )
  }

  @Test func countersNearIntMaxWrapInsteadOfTrapping() {
    var state = createChatState("bot", "stored", "resolved")
    state.items["a"] = Self.assistant("a", version: .max)
    state.order = ["a"]
    state.turn.nextSeq = .max - 1

    TranscriptReducer.patchItem(&state, "a") { (item: inout AssistantItem) in item.text += "!" }
    #expect(state.items["a"]?.version == .min)
    TranscriptReducer.patchAnyItem(&state, "a") { _ in }
    #expect(state.items["a"]?.version == .min + 1)

    TranscriptReducer.addItem(&state, id: "b", ts: nil) { base in
      .status(StatusItem(base: base, statusKind: "thinking", text: "x"))
    }
    #expect(state.items["b"]?.seq == .max - 1)
    #expect(state.turn.nextSeq == .max - 1 &+ seqStep)

    state.items["a"] = Self.assistant("a", version: .max)
    #expect(itemsVersion(state) == 2 &+ .max &+ 0)
  }

  @Test func reconcilingOntoAnItemAtIntMaxDoesNotTrap() {
    var state = createChatState("bot", "stored", "resolved")
    state.items["r:1"] = Self.assistant("r:1", version: .max, rowID: 1)
    state.order = ["r:1"]
    state.byRowID["1"] = "r:1"

    let next = reconcile(state, [Self.assistant("r:1", version: 0, rowID: 1)])
    #expect(next.items["r:1"]?.version == .min)
  }
}

@Suite struct JavaScriptTextLimitTests {
  /// `toLowerCase` applies the final-sigma rule; recorded from Node.
  @Test func lowerIsJavaScriptsToLowerCase() {
    #expect(JS.lower("ΟΔΟΣ") == "οδος")
    #expect(JS.lower("ΟΔΟΣ ΤΟΥ") == "οδος του")
    #expect(JS.lower("ΑΣ.") == "ας.")
    #expect(JS.lower("Σ") == "σ")
    #expect(JS.lower("İstanbul") == "i\u{307}stanbul")
    #expect(JS.lower("ẞ") == "ß")
  }

  @Test func allMatchesIsGlobalMatchAll() {
    let ref = JSRegExp("@(?:file|image):" + JSPattern.S + "+")
    #expect(ref.allMatches(in: "a @file:x.md b @image:y.png @file:x.md") == ["@file:x.md", "@image:y.png", "@file:x.md"])
    #expect(ref.allMatches(in: "nothing here").isEmpty)
    // Offsets are UTF-16: a reference after an astral character is found whole.
    #expect(ref.allMatches(in: "😀@file:é.txt") == ["@file:é.txt"])
  }
}

/// A pasted file listing can carry thousands of references; finding them must be
/// linear in the text, not in the text times the references.
@Suite(.serialized) struct ReferenceScanBenchmarkTests {
  static let references = 10_000

  static var prompt: String {
    (0..<references).map { "@file:/srv/work/uploads/file-\($0).txt" }.joined(separator: " ")
  }

  @Test func tenThousandReferencesAreFoundInOnePass() {
    let prompt = Self.prompt
    var found: [String] = []
    let scan = StateCopyBenchmarkTests.seconds {
      found = RowPatterns.attachmentRef.allMatches(in: prompt)
    }
    var stripped = StrippedUserText(text: "")
    let strip = StateCopyBenchmarkTests.seconds {
      stripped = stripUserText(prompt)
    }
    print(
      String(
        format: "reference scan: %d references, allMatches %.1f ms, stripUserText %.1f ms",
        Self.references,
        scan * 1_000,
        strip * 1_000
      )
    )

    #expect(found.count == Self.references)
    #expect(stripped.attachments?.count == Self.references)
    #expect(scan < 0.1, "allMatches over \(Self.references) references took \(scan) s")
    #expect(strip < 0.5, "stripUserText over \(Self.references) references took \(strip) s")
  }
}
