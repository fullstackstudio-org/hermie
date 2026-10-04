import Foundation
import Testing

@testable import HermieUI

/// A `Native` table key read in English, Dutch and German, each from its own compiled `.lproj`.
/// A key the table lacks in a language fails the test that asked, naming the key and the language.
func nativeTexts(_ key: String) throws -> [String: String] {
  var texts: [String: String] = [:]

  for language in ["en", "nl", "de"] {
    let path = try #require(HermieStringsLookup.bundle.path(forResource: language, ofType: "lproj"))
    let bundle = try #require(Bundle(path: path))
    let text = bundle.localizedString(forKey: key, value: "MISSING", table: "Native")

    #expect(text != "MISSING", "\(key) is missing in \(language)")
    #expect(!text.isEmpty, "\(key) is empty in \(language)")
    texts[language] = text
  }

  return texts
}

/// Every key is in all three languages, and Dutch and German differ from English unless the key is
/// one of the few that are the same word in a language (`sameIn`).
func expectTranslated(_ key: String, sameIn: Set<String> = []) throws {
  let texts = try nativeTexts(key)

  if !sameIn.contains("nl") {
    #expect(texts["nl"] != texts["en"], "\(key) was not translated into Dutch")
  }

  if !sameIn.contains("de") {
    #expect(texts["de"] != texts["en"], "\(key) was not translated into German")
  }
}
