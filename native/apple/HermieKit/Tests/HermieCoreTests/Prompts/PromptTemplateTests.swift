import Foundation
import Testing

@testable import HermieCore

/// The fill-in fields of a reusable prompt (NX-13): which `{{name}}` is a field, and how one is filled.
@Suite("Prompt templates")
struct PromptTemplateTests {
  // MARK: Reading the fields

  @Test("fields are listed in the order they first appear, each once")
  func order() {
    #expect(PromptTemplate.fields(in: "Write about {{topic}} for {{audience}}, then {{topic}} again") == ["topic", "audience"])
    #expect(PromptTemplate.fields(in: "") == [])
    #expect(PromptTemplate.fields(in: "no fields at all") == [])
  }

  @Test("spaces inside the braces are allowed and are not part of the name")
  func spaces() {
    #expect(PromptTemplate.fields(in: "{{ topic }} and {{  tone}} and {{audience  }}") == ["topic", "tone", "audience"])
    #expect(PromptTemplate.fields(in: "{{first name}}") == ["first name"])
  }

  @Test("names may use letters of any alphabet, digits, underscore, dash and dot")
  func names() {
    #expect(PromptTemplate.fields(in: "{{naam}} {{Größe}} {{名前}} {{a_b-c.d}} {{item2}}") == ["naam", "Größe", "名前", "a_b-c.d", "item2"])
    #expect(PromptTemplate.fields(in: "{{Topic}} {{topic}}") == ["Topic", "topic"], "case counts")
  }

  @Test(
    "what is not a field name is ordinary text",
    arguments: [
      "{{}}", "{{ }}", "{{a{b}}", "{{a}b}}", "{{a\nb}}", "{{a/b}}", "{{a|b}}", "{{a:b}}", "{ {a}}", "{a}", "{{a}", "{{",
      "}}", "{{{{a", "{{" + String(repeating: "x", count: 41) + "}}"
    ]
  )
  func notFields(text: String) {
    #expect(PromptTemplate.fields(in: text).isEmpty, "\(text)")
    #expect(PromptTemplate.fill(text, with: ["a": "X", "b": "X"]) == text, "and it is filled as it is")
  }

  @Test("a name of the longest length is a field")
  func longest() {
    let name = String(repeating: "x", count: PromptTemplate.maxNameLength)

    #expect(PromptTemplate.fields(in: "{{\(name)}}") == [name])
  }

  @Test("a backslash before the braces keeps them as text")
  func escaped() {
    #expect(PromptTemplate.fields(in: #"use \{{name}} literally"#).isEmpty)
    #expect(PromptTemplate.fill(#"use \{{name}} literally"#, with: ["name": "X"]) == "use {{name}} literally")
    #expect(PromptTemplate.fill(#"\{{a}} and {{a}}"#, with: ["a": "X"]) == "{{a}} and X")
    #expect(PromptTemplate.fill(#"a\b"#, with: [:]) == #"a\b"#, "a backslash elsewhere is a backslash")
  }

  @Test("braces around a field are kept as text")
  func surrounding() {
    #expect(PromptTemplate.fill("{{{a}}}", with: ["a": "X"]) == "{X}")
    #expect(PromptTemplate.fill("{ {{a}} }", with: ["a": "X"]) == "{ X }")
  }

  @Test("a prompt asks for at most twenty different fields, and the rest of the braces stay as written")
  func fieldCap() {
    let text = (0..<30).map { "{{f\($0)}}" }.joined(separator: " ") + " {{f0}}"
    let fields = PromptTemplate.fields(in: text)

    #expect(fields.count == PromptTemplate.maxFields)
    #expect(fields.first == "f0" && fields.last == "f19")

    let values = Dictionary(uniqueKeysWithValues: fields.map { ($0, "V") })
    let filled = PromptTemplate.fill(text, with: values)

    #expect(filled.hasPrefix("V V"))
    #expect(filled.contains("{{f20}}") && filled.contains("{{f29}}"))
    #expect(filled.hasSuffix(" V"), "a field already known is filled wherever it is")
  }

  // MARK: Filling

  @Test("every place of a field is filled with its value, and the rest is untouched")
  func fills() {
    let text = "Hi {{name}},\n\nThanks for {{topic}}. Regards, {{name}}"

    #expect(PromptTemplate.fill(text, with: ["name": "Sam", "topic": "the call"]) == "Hi Sam,\n\nThanks for the call. Regards, Sam")
  }

  @Test("an empty or missing value fills in as nothing")
  func missing() {
    #expect(PromptTemplate.fill("a{{x}}b{{y}}c", with: ["x": ""]) == "abc")
    #expect(PromptTemplate.fill("{{x}}", with: [:]) == "")
  }

  @Test("a value is text: braces in it are not read again, and neither is an escape")
  func valuesAreNotReread() {
    #expect(PromptTemplate.fill("{{a}} {{b}}", with: ["a": "{{b}}", "b": "B"]) == "{{b}} B")
    #expect(PromptTemplate.fill("{{a}}", with: ["a": #"\{{b}}"#]) == #"\{{b}}"#)
  }

  @Test("a text without fields is returned as it is, whatever is passed")
  func noFields() {
    #expect(PromptTemplate.fill("Summarise this.", with: ["x": "y"]) == "Summarise this.")
  }

  @Test("a prompt knows its fields and fills its own text")
  func promptConvenience() {
    let prompt = Prompt(id: "p1", title: "Mail", text: "Dear {{who}}, {{what}}")

    #expect(prompt.fields == ["who", "what"])
    #expect(prompt.filled(with: ["who": "Sam", "what": "hello"]) == "Dear Sam, hello")
  }
}
