import Foundation
import Testing

/// The App Shortcuts' phrases (`HermieAppShortcuts.swift`) against the tables the system reads them from
/// (`AppShortcuts.strings` per language). A phrase without a translation is silently never matched by Siri
/// in that language, and one without the app's name is never matched at all, so both are held here, for
/// every phrase in the provider rather than for a list this test keeps.
@Suite("App Shortcut phrases")
struct AppShortcutPhraseTests {
  private static let languages = ["en", "nl", "de"]

  private static let root: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("native/apple/Extensions/Intents", isDirectory: true)
  }()

  /// Every phrase and short title the provider declares, as the tables key them: `\(\.$bot)` is `${bot}`
  /// and `\(.applicationName)` is `${applicationName}`.
  private static func declared() throws -> (phrases: [String], titles: [String]) {
    let source = try String(contentsOf: root.appendingPathComponent("HermieAppShortcuts.swift"), encoding: .utf8)
    // Only the code: the doc comment quotes phrases too.
    let code = source.components(separatedBy: "struct HermieAppShortcuts").last ?? ""
    let literal = #""((?:[^"\\]|\\.)*)""#

    var phrases: [String] = []
    var titles: [String] = []

    for block in code.components(separatedBy: "AppShortcut(").dropFirst() {
      if let open = block.range(of: "phrases: ["), let close = block.range(of: "]", range: open.upperBound..<block.endIndex) {
        let list = String(block[open.upperBound..<close.lowerBound])

        for match in try NSRegularExpression(pattern: literal).matches(in: list, range: NSRange(list.startIndex..., in: list)) {
          phrases.append(String(list[Range(match.range(at: 1), in: list)!]))
        }
      }

      if let title = block.range(of: #"shortTitle: ""#) {
        let rest = block[title.upperBound...]

        titles.append(String(rest[..<rest.firstIndex(of: "\"")!]))
      }
    }

    return (
      phrases.map {
        $0.replacingOccurrences(of: #"\(\.$bot)"#, with: "${bot}")
          .replacingOccurrences(of: #"\(.applicationName)"#, with: "${applicationName}")
      },
      titles
    )
  }

  private static func table(_ name: String, language: String) throws -> [String: String] {
    let url = root.appendingPathComponent("Resources/\(language).lproj/\(name).strings")
    let data = try Data(contentsOf: url)

    return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String])
  }

  @Test("the provider's phrases and titles are found in the source")
  func found() throws {
    let declared = try Self.declared()

    // "Write to a bot" among them: the shortcut this card added.
    #expect(declared.phrases.contains("Write to ${bot} in ${applicationName}"))
    #expect(declared.phrases.contains("Write to a bot in ${applicationName}"))
    #expect(declared.titles.contains("Write to a bot"))
    #expect(declared.phrases.count >= 12)
  }

  @Test("every phrase carries the app's name, which is how Siri matches it")
  func applicationName() throws {
    for phrase in try Self.declared().phrases {
      #expect(phrase.contains("${applicationName}"), "\(phrase)")
    }
  }

  @Test("every phrase is translated into English, Dutch and German, with the same placeholders")
  func translated() throws {
    let phrases = try Self.declared().phrases

    for language in Self.languages {
      let table = try Self.table("AppShortcuts", language: language)

      for phrase in phrases {
        let value = try #require(table[phrase], "\(language): no entry for “\(phrase)”")
        let placeholders = { (text: String) in ["${applicationName}", "${bot}"].filter(text.contains) }

        #expect(!value.isEmpty, "\(language): “\(phrase)”")
        #expect(placeholders(value) == placeholders(phrase), "\(language): “\(phrase)” became “\(value)”")
      }
    }
  }

  @Test("Dutch and German phrases are not the English ones left as they were, except where a phrase is the same word")
  func notLeftInEnglish() throws {
    let phrases = try Self.declared().phrases
    let english = try Self.table("AppShortcuts", language: "en")

    for language in ["nl", "de"] {
      let table = try Self.table("AppShortcuts", language: language)
      let same = phrases.filter { table[$0] == english[$0] }

      // "Open ${bot} in ${applicationName}" is the same in Dutch; nothing else may be.
      #expect(same.allSatisfy { $0.hasPrefix("Open ") }, "\(language): still English: \(same)")
    }
  }

  @Test("every short title is translated into the three languages")
  func titles() throws {
    let titles = try Self.declared().titles

    for language in Self.languages {
      let table = try Self.table("Localizable", language: language)

      for title in titles {
        #expect(table[title]?.isEmpty == false, "\(language): no entry for “\(title)”")
      }
    }
  }
}
