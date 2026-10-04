import Testing

@testable import HermieMarkdown

/// The tokeniser per language: what is a keyword, a string, a comment, a number, and that the
/// tokens always join back into the listing they came from.
@Suite struct CodeHighlighterTests {
  typealias Pair = (CodeTokenKind, String)

  /// Every token that is not plain text, in order.
  func marks(_ source: String, _ language: String) -> [Pair] {
    CodeHighlighter.tokens(source, language: language).filter { $0.kind != .plain }.map { ($0.kind, $0.text) }
  }

  func expect(_ source: String, _ language: String, _ expected: [Pair], sourceLocation: SourceLocation = #_sourceLocation) {
    let got = marks(source, language)
    #expect(
      got.count == expected.count && zip(got, expected).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 },
      "\(language): \(got) != \(expected)", sourceLocation: sourceLocation)
  }

  // MARK: Swift

  @Test func swiftKeywordsStringsCommentsNumbers() {
    expect(
      "let answer = 42 // the answer\nfunc greet(name: String) -> String { \"Hi \\(name)\" }",
      "swift",
      [
        (.keyword, "let"), (.number, "42"), (.comment, "// the answer"),
        (.keyword, "func"), (.function, "greet"), (.type, "String"), (.type, "String"),
        (.string, "\"Hi \\(name)\"")
      ])
  }

  @Test func swiftAttributesDirectivesAndNestedComments() {
    expect(
      "@MainActor final class Box {}\n#if DEBUG\n/* a /* nested */ still */ var x = nil",
      "swift",
      [
        (.attribute, "@MainActor"), (.keyword, "final"), (.keyword, "class"), (.type, "Box"),
        (.attribute, "#if"), (.comment, "/* a /* nested */ still */"),
        (.keyword, "var"), (.literal, "nil")
      ])
  }

  @Test func swiftMultilineString() {
    let source = "let s = \"\"\"\n  one \"two\"\n  \"\"\"\nlet n = 1"
    let tokens = marks(source, "swift")
    #expect(tokens.contains { $0.0 == .string && $0.1.hasPrefix("\"\"\"") && $0.1.hasSuffix("\"\"\"") && $0.1.contains("one") })
    #expect(tokens.last?.0 == .number)
  }

  // MARK: Python

  @Test func pythonDecoratorsPrefixesAndTripleQuotes() {
    expect(
      "@app.route('/x')\ndef f(a, b=2):\n    \"\"\"doc\"\"\"\n    return f\"{a}\" if a is None else r'\\d'  # tail",
      "python",
      [
        (.attribute, "@app.route"), (.string, "'/x'"), (.keyword, "def"), (.function, "f"), (.number, "2"),
        (.string, "\"\"\"doc\"\"\""), (.keyword, "return"), (.string, "f\"{a}\""), (.keyword, "if"), (.keyword, "is"),
        (.literal, "None"), (.keyword, "else"), (.string, "r'\\d'"), (.comment, "# tail")
      ])
  }

  // MARK: JavaScript and TypeScript

  @Test func javascriptTemplatesAndComments() {
    expect(
      "const x = `a\nb ${y}`; /* c */ if (x === null) return 1.5e3",
      "js",
      [
        (.keyword, "const"), (.string, "`a\nb ${y}`"), (.comment, "/* c */"), (.keyword, "if"), (.literal, "null"),
        (.keyword, "return"), (.number, "1.5e3")
      ])
  }

  @Test func typescriptAddsItsKeywordsAndTypes() {
    expect(
      "interface User { id: number; name?: string }",
      "ts",
      [(.keyword, "interface"), (.type, "User"), (.type, "number"), (.type, "string")])
    #expect(CodeLanguage.named("tsx") == .typescript)
    #expect(CodeLanguage.named("jsx") == .javascript)
  }

  // MARK: JSON

  @Test func jsonKeysAreNotStrings() {
    expect(
      "{\n  \"name\": \"hermie\", \"n\": -12.5, \"ok\": true, \"none\": null, \"list\": [1, 2]\n}",
      "json",
      [
        (.property, "\"name\""), (.string, "\"hermie\""), (.property, "\"n\""), (.number, "-12.5"),
        (.property, "\"ok\""), (.literal, "true"), (.property, "\"none\""), (.literal, "null"),
        (.property, "\"list\""), (.number, "1"), (.number, "2")
      ])
  }

  // MARK: Shell

  @Test func bashCommentsVariablesAndQuoting() {
    expect(
      "if [ -f \"$HOME/x\" ]; then echo '$not' # done\nfi\nexport PATH=${PATH}:/bin",
      "sh",
      [
        (.keyword, "if"), (.string, "\"$HOME/x\""), (.keyword, "then"), (.keyword, "echo"), (.string, "'$not'"),
        (.comment, "# done"), (.keyword, "fi"), (.keyword, "export"), (.variable, "${PATH}")
      ])
  }

  @Test func bashHashInsideAWordIsNotAComment() {
    let tokens = marks("echo a#b $#", "bash")
    #expect(!tokens.contains { $0.0 == .comment })
    #expect(tokens.contains { $0.0 == .variable && $0.1 == "$#" })
  }

  // MARK: Go and Rust

  @Test func goRawStringsAndBuiltinTypes() {
    expect(
      "func main() { var n int = 3; s := `raw\\n`; _ = nil }",
      "go",
      [
        (.keyword, "func"), (.function, "main"), (.keyword, "var"), (.type, "int"), (.number, "3"),
        (.string, "`raw\\n`"), (.literal, "nil")
      ])
  }

  @Test func rustLifetimesCharsAndMacros() {
    expect(
      "fn first<'a>(s: &'a str) -> char { println!(\"{}\", 'x'); 10u8 }",
      "rust",
      [
        (.keyword, "fn"), (.function, "first"), (.type, "'a"), (.type, "'a"), (.type, "str"), (.type, "char"),
        (.function, "println"), (.string, "\"{}\""), (.string, "'x'"), (.number, "10u8")
      ])
  }

  // MARK: HTML, CSS, YAML, SQL, diff

  @Test func htmlTagsAttributesAndComments() {
    expect(
      "<!-- hi --><div class=\"a b\" id='x'>text</div>",
      "html",
      [
        (.comment, "<!-- hi -->"), (.tag, "div"), (.property, "class"), (.string, "\"a b\""), (.property, "id"),
        (.string, "'x'"), (.tag, "div")
      ])
  }

  @Test func cssSelectorsPropertiesAndValues() {
    expect(
      ".card > p { color: #fff; margin: 0 -4px; content: \"x\"; } /* end */ @media (min-width: 10px) {}",
      "css",
      [
        (.tag, ".card"), (.tag, "p"), (.property, "color"), (.number, "#fff"), (.property, "margin"),
        (.number, "0"), (.number, "-4px"), (.property, "content"), (.string, "\"x\""), (.comment, "/* end */"),
        (.keyword, "@media"), (.property, "min-width"), (.number, "10px")
      ])
  }

  @Test func yamlKeysScalarsAndComments() {
    expect(
      "name: hermie # c\nport: 8080\nenabled: true\nurl: http://x.y/z\nlist:\n  - \"a\"\n  - b: null",
      "yaml",
      [
        (.property, "name"), (.comment, "# c"), (.property, "port"), (.number, "8080"), (.property, "enabled"),
        (.literal, "true"), (.property, "url"), (.property, "list"), (.string, "\"a\""), (.property, "b"),
        (.literal, "null")
      ])
  }

  @Test func sqlIsCaseInsensitive() {
    expect(
      "SELECT id, Name FROM users WHERE age >= 18 -- adults\nORDER BY id desc;",
      "sql",
      [
        (.keyword, "SELECT"), (.keyword, "FROM"), (.keyword, "WHERE"), (.number, "18"), (.comment, "-- adults"),
        (.keyword, "ORDER"), (.keyword, "BY"), (.keyword, "desc")
      ])
  }

  @Test func diffLines() {
    expect(
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same",
      "diff",
      [
        (.meta, "--- a/x"), (.meta, "+++ b/x"), (.type, "@@ -1 +1 @@"), (.deletion, "-old"), (.addition, "+new")
      ])
  }

  // MARK: Invariants

  static let samples: [(String, String)] = [
    ("swift", "let s = \"unterminated\nvar x = 1 /* open"),
    ("python", "x = '''never closed\nmore"),
    ("js", "const t = `open ${"),
    ("json", "{\"a\": \"b"),
    ("bash", "echo \"é ü \\\n$("),
    ("go", "`raw"),
    ("rust", "let c = '"),
    ("html", "<div class=\"x"),
    ("css", "a { color: "),
    ("yaml", "key: 'x"),
    ("sql", "select 'x"),
    ("diff", "+"),
    ("c", "int main() { return 0; }"),
    ("swift", "名前 = \"日本語\" // コメント")
  ]

  @Test(arguments: samples)
  func tokensJoinBackIntoTheListing(sample: (String, String)) {
    let joined = CodeHighlighter.tokens(sample.1, language: sample.0).map(\.text).joined()
    #expect(joined == sample.1)
  }

  @Test func everyLanguageJoinsBackIntoAMixedListing() {
    let source = "/* a */ // b\n# c\n-- d\n\"e\" 'f' `g` 12 0xFF 1.5e-3 $x @y #z <t a=\"1\"> { } : , é\t\n"
    for language in CodeLanguage.allCases {
      let joined = CodeHighlighter.tokens(source, language: language).map(\.text).joined()
      #expect(joined == source, "\(language)")
    }
  }

  @Test func adjacentTokensOfOneKindAreOne() {
    let tokens = CodeHighlighter.tokens("a b c", language: "swift")
    #expect(tokens == [CodeToken(.plain, "a b c")])
  }

  @Test func anUnknownLanguageIsPlain() {
    #expect(CodeHighlighter.tokens("let x = 1", language: "brainfuck") == [CodeToken(.plain, "let x = 1")])
    #expect(CodeHighlighter.tokens("let x = 1", language: nil) == [CodeToken(.plain, "let x = 1")])
    #expect(CodeHighlighter.tokens("", language: "swift").isEmpty)
    #expect(!CodeLanguage.isKnown("text"))
  }

  @Test func aliasesResolve() {
    let expected: [(String, CodeLanguage)] = [
      ("Swift", .swift), ("py", .python), ("js", .javascript), ("ts", .typescript), ("json", .json),
      ("zsh", .bash), ("sh", .bash), ("golang", .go), ("rs", .rust), ("xml", .html), ("html", .html),
      ("scss", .css), ("yml", .yaml), ("postgresql", .sql), ("patch", .diff), ("java", .clike)
    ]
    for (name, language) in expected {
      #expect(CodeLanguage.named(name) == language, "\(name)")
    }
  }

  @Test func aHugeListingIsNotHighlighted() {
    let big = String(repeating: "let x = 1\n", count: CodeHighlighter.maximumLength / 10 + 10)
    #expect(CodeHighlighter.tokens(big, language: "swift") == [CodeToken(.plain, big)])
  }

  @Test func cachedTokensAreTheTokens() {
    let source = "let a = 1"
    #expect(CodeHighlighter.cachedTokens(source, language: "swift") == CodeHighlighter.tokens(source, language: "swift"))
    #expect(CodeHighlighter.cachedTokens(source, language: "swift") == CodeHighlighter.tokens(source, language: "swift"))
    // The language is part of the key.
    #expect(CodeHighlighter.cachedTokens(source, language: "python") != CodeHighlighter.cachedTokens(source, language: "swift"))
  }

  @Test func everyTokenKindHasAThemeColourExceptPlain() {
    for kind in CodeTokenKind.allCases {
      #expect((CodeTheme.color(for: kind) == nil) == (kind == .plain), "\(kind)")
    }
  }
}
