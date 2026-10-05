import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The reusable prompts in the app section (NX-13): reading, adding, editing, deleting and ordering them,
/// and carrying what this build does not know.
@Suite("Prompt library")
struct PromptLibraryTests {
  private func app(_ prompts: [JSONValue]) -> JSONObject {
    ["v": 1, "labels": ["writer": "W"], "prompts": .array(prompts)]
  }

  private func entry(_ id: String, _ title: String, _ text: String = "text", bot: String? = nil, extra: JSONObject = [:]) -> JSONValue {
    var object: JSONObject = ["id": .string(id), "title": .string(title), "text": .string(text)]

    if let bot { object["bot"] = .string(bot) }
    for (key, value) in extra { object[key] = value }
    return .object(object)
  }

  private func ids(_ app: JSONObject, scope: PromptScope? = nil) -> [String] {
    PromptLibrary.prompts(in: app).filter { scope == nil || $0.scope == scope }.map(\.id)
  }

  // MARK: Reading

  @Test("the prompts of a section are read in their order, with their scope")
  func reads() {
    let section = app([entry("a", "A"), entry("b", "B", bot: "writer"), entry("c", "C", "hello {{x}}")])
    let prompts = PromptLibrary.prompts(in: section)

    #expect(prompts.map(\.id) == ["a", "b", "c"])
    #expect(prompts.map(\.scope) == [.global, .bot("writer"), .global])
    #expect(prompts[2].fields == ["x"])
  }

  @Test("an entry that is not a prompt, or repeats an id, is not offered")
  func foreignEntries() {
    let section = app([
      entry("a", "A"), "text", 4, .null, ["id": "no-title", "text": "x"], ["id": 7, "title": "T", "text": "x"],
      ["id": "", "title": "T", "text": "x"], entry("a", "Again"), entry("b", "B"), ["id": "c", "title": "T", "text": 4]
    ])

    #expect(ids(section) == ["a", "b"])
    #expect(PromptLibrary.prompts(in: section).first?.title == "A", "the first of an id counts")
  }

  @Test("no section, no field and a field of the wrong type read as no prompts")
  func nothing() {
    #expect(PromptLibrary.prompts(in: nil).isEmpty)
    #expect(PromptLibrary.prompts(in: ["v": 1]).isEmpty)
    #expect(PromptLibrary.prompts(in: ["prompts": "x"]).isEmpty)
    #expect(PromptLibrary.prompts(in: ["prompts": ["a": 1]]).isEmpty)
  }

  @Test("an empty bot name is a global prompt")
  func emptyBot() {
    let section = app([["id": "a", "title": "A", "text": "x", "bot": ""]])

    #expect(PromptLibrary.prompts(in: section).first?.bot == nil)
  }

  // MARK: Limits on what arrives

  @Test("only the first hundred prompts of a section are offered, and the rest are carried untouched")
  func readLimit() {
    let many = (0..<150).map { entry("p\($0)", "P\($0)") }
    var section = app(many)

    #expect(PromptLibrary.prompts(in: section).count == PromptLibrary.maxPrompts)
    #expect(ids(section).last == "p99")
    #expect(PromptLibrary.entryCount(in: section) == 150, "what is not offered is still there to carry")
    #expect(section["prompts"]?.arrayValue?.count == 150)
    #expect(!PromptLibrary.add(Prompt(id: "new", title: "T", text: "x"), in: &section), "and there is no room")
  }

  @Test("a title or a text longer than the limits is cut on read, in the model only")
  func readCuts() throws {
    let longTitle = String(repeating: "t", count: PromptLibrary.titleLimit * 5)
    let longText = String(repeating: "x", count: PromptLibrary.textLimit * 5)
    let section = app([entry("a", longTitle, longText)])
    let prompt = try #require(PromptLibrary.prompts(in: section).first)

    #expect(prompt.title.count == PromptLibrary.titleLimit)
    #expect(prompt.text.count == PromptLibrary.textLimit)
    #expect(section["prompts"]?.arrayValue?.first?.objectValue?["text"]?.stringValue?.count == longText.count)
  }

  @Test("a limit is on scalars, not characters: a letter with a thousand combining marks is cut")
  func scalarLimits() throws {
    let marks = String(repeating: "\u{0301}", count: 5_000)
    let title = "e" + marks
    let text = "x" + marks + marks
    let section = app([entry("a", title, text)])
    let prompt = try #require(PromptLibrary.prompts(in: section).first)

    #expect(title.count == 1, "one character to Swift")
    #expect(prompt.title.unicodeScalars.count == PromptLibrary.titleLimit)
    #expect(prompt.text.unicodeScalars.count == PromptLibrary.textLimit)

    var written: JSONObject = [:]

    #expect(PromptLibrary.add(Prompt(id: "b", title: title, text: text), in: &written))

    let stored = try #require(PromptLibrary.prompts(in: written).first)

    #expect(stored.title.unicodeScalars.count <= PromptLibrary.titleLimit)
    #expect(stored.text.unicodeScalars.count <= PromptLibrary.textLimit)
  }

  @Test("only the first line of a title is read")
  func titleIsOneLine() throws {
    let section = app([entry("a", "First line\nsecond line that is not part of the title")])

    #expect(try #require(PromptLibrary.prompts(in: section).first).title == "First line")
  }

  @Test("an id or a bot name that is absurdly long is not a prompt")
  func longIdentifiers() {
    let section = app([
      entry("a" + String(repeating: "x", count: PromptLibrary.idLimit), "T"), entry("ok", "T", bot: String(repeating: "b", count: 500))
    ])
    let prompts = PromptLibrary.prompts(in: section)

    #expect(prompts.map(\.id) == ["ok"])
    #expect(prompts.first?.bot == nil)
  }

  // MARK: Adding

  @Test("a prompt is added at the end, cleaned, and the rest of the section is left alone")
  func adds() {
    var section: JSONObject = ["v": 1, "labels": ["writer": "W"], "futureField": [1, 2]]

    #expect(PromptLibrary.add(Prompt(id: "a", title: "  First \n second ", text: "  Hello {{x}}  "), in: &section))
    #expect(PromptLibrary.add(Prompt(id: "b", title: "B", text: "Bee", bot: "writer"), in: &section))
    #expect(section["labels"] == ["writer": "W"])
    #expect(section["futureField"] == [1, 2])

    let prompts = PromptLibrary.prompts(in: section)

    #expect(prompts.map(\.title) == ["First", "B"])
    #expect(prompts.map(\.text) == ["Hello {{x}}", "Bee"])
    #expect(section["prompts"] == [
      ["id": "a", "title": "First", "text": "Hello {{x}}"],
      ["id": "b", "title": "B", "text": "Bee", "bot": "writer"]
    ])
  }

  @Test("a prompt with no title is called by its first words, and one with no text is not added")
  func titleFallback() {
    var section: JSONObject = [:]

    #expect(PromptLibrary.add(Prompt(id: "a", title: "  ", text: "Summarise the thread\nin three lines"), in: &section))
    #expect(PromptLibrary.prompts(in: section).first?.title == "Summarise the thread")
    #expect(!PromptLibrary.add(Prompt(id: "b", title: "T", text: " \n "), in: &section))
    #expect(!PromptLibrary.add(Prompt(id: "", title: "T", text: "x"), in: &section))
    #expect(ids(section) == ["a"])
  }

  @Test("the lengths are capped")
  func caps() {
    var section: JSONObject = [:]
    let long = String(repeating: "x", count: PromptLibrary.textLimit + 500)

    PromptLibrary.add(Prompt(id: "a", title: String(repeating: "t", count: 200), text: long), in: &section)

    let stored = PromptLibrary.prompts(in: section).first
    #expect(stored?.title.count == PromptLibrary.titleLimit)
    #expect(stored?.text.count == PromptLibrary.textLimit)
  }

  @Test("an id that is taken is refused, and so is a hundred and first prompt")
  func limits() {
    var section: JSONObject = [:]

    #expect(PromptLibrary.add(Prompt(id: "a", title: "A", text: "x"), in: &section))
    #expect(!PromptLibrary.add(Prompt(id: "a", title: "Other", text: "y"), in: &section))

    for index in 1..<PromptLibrary.maxPrompts {
      #expect(PromptLibrary.add(Prompt(id: "p\(index)", title: "P", text: "x"), in: &section))
    }

    #expect(PromptLibrary.prompts(in: section).count == PromptLibrary.maxPrompts)
    #expect(!PromptLibrary.add(Prompt(id: "one-more", title: "P", text: "x"), in: &section))
  }

  // MARK: Editing

  @Test("editing changes the title, text and bot, keeps the place, and keeps every key this build does not know")
  func updates() throws {
    var section = app([
      entry("a", "A"), entry("b", "B", "old", bot: "writer", extra: ["emoji": "x", "colour": ["r": 1]]), entry("c", "C")
    ])

    var prompt = try #require(PromptLibrary.prompts(in: section).first { $0.id == "b" })
    #expect(prompt.carried == ["emoji": "x", "colour": ["r": 1]])

    prompt.title = " New "
    prompt.text = "new {{x}}"
    prompt.bot = "researcher"
    #expect(PromptLibrary.update(prompt, in: &section))

    #expect(ids(section) == ["a", "b", "c"])
    #expect(section["prompts"]?.arrayValue?[1] == [
      "id": "b", "title": "New", "text": "new {{x}}", "bot": "researcher", "emoji": "x", "colour": ["r": 1]
    ])

    prompt.bot = nil
    #expect(PromptLibrary.update(prompt, in: &section))
    #expect(section["prompts"]?.arrayValue?[1].objectValue?["bot"] == nil, "a global prompt has no bot key")
  }

  @Test("an edit to a prompt that is gone, or to no words, changes nothing")
  func updateRefusals() {
    var section = app([entry("a", "A")])
    let before = section

    #expect(!PromptLibrary.update(Prompt(id: "zzz", title: "Z", text: "x"), in: &section))
    #expect(!PromptLibrary.update(Prompt(id: "a", title: "A", text: "  "), in: &section))
    #expect(section == before)
  }

  // MARK: Deleting

  @Test("deleting removes that prompt only, and the last one leaves an empty list, not a missing one")
  func removes() {
    var section = app([entry("a", "A"), entry("b", "B")])

    #expect(PromptLibrary.remove(id: "a", in: &section))
    #expect(ids(section) == ["b"])
    #expect(!PromptLibrary.remove(id: "a", in: &section))
    #expect(PromptLibrary.remove(id: "b", in: &section))
    #expect(section["prompts"] == [], "an absent field would read as nothing said")
    #expect(section["labels"] == ["writer": "W"])
  }

  // MARK: Ordering

  @Test("a prompt moves inside its own scope and the entries of other scopes stay where they are")
  func movesInScope() {
    var section = app([
      entry("g1", "G1"), entry("w1", "W1", bot: "writer"), entry("g2", "G2"), entry("w2", "W2", bot: "writer"),
      entry("g3", "G3"), entry("r1", "R1", bot: "researcher")
    ])

    // g3 to the front of the global prompts.
    #expect(PromptLibrary.move(id: "g3", toIndex: 0, in: &section))
    #expect(ids(section, scope: .global) == ["g3", "g1", "g2"])
    #expect(ids(section) == ["g3", "w1", "g1", "w2", "g2", "r1"], "the writer's and the researcher's did not move")

    // w1 below w2.
    #expect(PromptLibrary.move(id: "w1", toIndex: 1, in: &section))
    #expect(ids(section, scope: .bot("writer")) == ["w2", "w1"])
    #expect(ids(section, scope: .global) == ["g3", "g1", "g2"])
  }

  @Test("a place past either end is the end, and a move to where it is, or of nothing, changes nothing")
  func moveEdges() {
    var section = app([entry("a", "A"), entry("b", "B"), entry("c", "C")])

    #expect(PromptLibrary.move(id: "a", toIndex: 99, in: &section))
    #expect(ids(section) == ["b", "c", "a"])
    #expect(PromptLibrary.move(id: "a", toIndex: -5, in: &section))
    #expect(ids(section) == ["a", "b", "c"])

    let before = section
    #expect(!PromptLibrary.move(id: "b", toIndex: 1, in: &section))
    #expect(!PromptLibrary.move(id: "zzz", toIndex: 0, in: &section))
    #expect(section == before)
  }

  @Test("entries that are not prompts keep their slots when prompts are moved around them")
  func foreignSlotsStay() {
    var section = app([entry("a", "A"), "unknown", entry("b", "B"), ["future": true], entry("c", "C")])

    #expect(PromptLibrary.move(id: "c", toIndex: 0, in: &section))

    let list = section["prompts"]?.arrayValue ?? []
    #expect(list[1] == "unknown" && list[3] == ["future": true])
    #expect(ids(section) == ["c", "a", "b"])
  }

  @Test("new ids are a letter and twelve hex digits, and differ")
  func newIDs() {
    let first = PromptID.make()
    let second = PromptID.make()

    #expect(first.count == 13 && first.hasPrefix("p"))
    #expect(first != second)
    #expect(first.dropFirst().allSatisfy { $0.isHexDigit && !$0.isUppercase })
  }
}
