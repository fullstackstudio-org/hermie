import SwiftUI

/// One piece of software whose licence the apps carry.
struct LicenceEntry: Identifiable, Equatable {
  var id: String
  /// A name, not translated: these are the projects' own.
  var name: String
  /// The licence's identifier.
  var licence: String
  var copyright: String
  /// Where it comes from, when it has a page.
  var source: URL?
  /// The resource that holds the licence text, in the bundle.
  var resource: String
}

/**
 What the Apple apps owe to others, and the texts that say so (`LicencesScreen` in the Expo app and
 `THIRD_PARTY_NOTICES.md`).

 The Expo app lists every npm package that ships inside it, because it does ship them. The Apple apps
 ship none: `HermieKit` has no third-party package (docs/native.md), only Apple's own frameworks. What
 they do carry is Hermie's own licence and the licence of Hermes Agent, whose Desktop app and gateway
 the protocol, the transcript engine and the bot-to-bot conventions were written from
 (`THIRD_PARTY_NOTICES.md`). Those two texts are bundled as they are in the repository
 (`LICENSE` and `packages/hermes-shared/LICENSE`), and a test holds the copies to the originals.

 A new third-party package, or a new port, adds an entry here and its text to `Resources`.
 */
enum LicenceCatalogue {
  static let entries: [LicenceEntry] = [
    LicenceEntry(
      id: "hermie", name: "Hermie", licence: "MIT", copyright: "Copyright (c) 2026 FullStack Studio",
      source: nil, resource: "Licence-Hermie"),
    LicenceEntry(
      id: "hermes-agent", name: "Hermes Agent", licence: "MIT", copyright: "Copyright (c) 2025 Nous Research",
      source: URL(string: "https://github.com/NousResearch/Hermes-Agent"), resource: "Licence-HermesAgent")
  ]

  /// What an entry is, in the reader's language.
  static func note(of entry: LicenceEntry) -> String {
    switch entry.id {
    case "hermie": NativeStrings.Licences.hermie
    default: NativeStrings.Licences.hermesAgent
    }
  }

  /// The licence text of an entry, as the bundle holds it; nil when the resource is missing or not
  /// text.
  static func text(of entry: LicenceEntry, in bundle: Bundle = .module) -> String? {
    guard let url = bundle.url(forResource: entry.resource, withExtension: "txt"),
      let text = try? String(contentsOf: url, encoding: .utf8)
    else {
      return nil
    }

    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

extension NativeStrings {
  enum Licences {
    /// Hermie is open source under the MIT licence. The Apple apps use no third-party packages …
    static var summary: String { String(localized: "native.licences.summary", table: "Native", bundle: .module) }
    /// Hermie itself …
    static var hermie: String { String(localized: "native.licences.hermie", table: "Native", bundle: .module) }
    /// Parts of the gateway protocol, the transcript engine … are written from Hermes Agent
    static var hermesAgent: String {
      String(localized: "native.licences.hermesAgent", table: "Native", bundle: .module)
    }
    /// The licence text could not be read.
    static var unreadable: String {
      String(localized: "native.licences.unreadable", table: "Native", bundle: .module)
    }
    /// Licence: {licence}
    static func licence(_ licence: String) -> String {
      String(
        localized: "native.licences.licence", defaultValue: "Licence: \(licence)", table: "Native", bundle: .module)
    }
  }
}

/// Settings → About → Licences: each entry opens its licence text, which can be selected and copied.
struct LicencesPage: View {
  var entries = LicenceCatalogue.entries

  var body: some View {
    Form {
      Section {
        ForEach(entries) { entry in
          LicenceRow(entry: entry)
        }
      } header: {
        Text(Strings.App.Settings.licencesHint)
      } footer: {
        SettingsNote(NativeStrings.Licences.summary)
      }
    }
    .formStyle(.grouped)
    .navigationTitle(Strings.App.Settings.licences)
    .accessibilityIdentifier("hermie.settings.licences")
  }
}

private struct LicenceRow: View {
  let entry: LicenceEntry

  @State private var open = false

  var body: some View {
    DisclosureGroup(isExpanded: $open) {
      VStack(alignment: .leading, spacing: 8) {
        Text(verbatim: LicenceCatalogue.note(of: entry))
          .font(.footnote)

        if let source = entry.source {
          Link(source.absoluteString, destination: source)
            .font(.footnote)
        }

        // Read when the row is opened: two texts of a screenful each, not worth keeping in memory.
        Text(verbatim: LicenceCatalogue.text(of: entry) ?? NativeStrings.Licences.unreadable)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("hermie.settings.licences.text.\(entry.id)")
      }
      .padding(.vertical, 4)
    } label: {
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: entry.name)
          .font(.body.weight(.semibold))
        Text(verbatim: "\(NativeStrings.Licences.licence(entry.licence)) · \(entry.copyright)")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
    .accessibilityIdentifier("hermie.settings.licences.\(entry.id)")
  }
}
