import Foundation
import HermieProtocol

/**
 The Hermie plugin's memory answers, as the Memory page reads them (`features/memory/model.ts` in the
 Expo app, and `memory/browse.py` in the plugin). Three decisions of the plugin reach into every type
 here:

 - **An id is positional.** A memory file is plain text with entries joined by `"\n§\n"`: no ids, no
   timestamps. `memory:3` means "the fourth entry as the file reads right now" and stops being true
   the moment one above it goes, so it names a row on screen and nothing else. Every write sends the
   entry's TEXT, which is what the store itself matches on.
 - **There are exactly two targets**, `memory` and `user`. The store dispatches on a bare
   `target == "user"` and refuses anything else.
 - **`chars` is what the store spends**, delimiter included, which is why the usage bar reads the
   number off the answer instead of summing the entries it drew.

 Every reader is forgiving about what is missing and strict about nothing: a row it cannot read is
 dropped and a number it cannot read is zero, so one odd row never blanks the page.
 */

/// The two files a bot has.
public enum MemoryTarget: String, Sendable, CaseIterable, Hashable {
  /// `MEMORY.md`: what the bot has written down about its work.
  case memory
  /// `USER.md`: what the bot has written down about the person.
  case user

  /// The file's name, as a person knows it.
  public var fileName: String {
    switch self {
    case .memory: "MEMORY.md"
    case .user: "USER.md"
    }
  }
}

/// One entry of one file.
public struct MemoryEntry: Sendable, Equatable, Identifiable {
  /// `memory:3`. Positional, and stale the moment an entry above it goes.
  public var id: String
  public var target: MemoryTarget
  public var index: Int
  public var text: String
  public var chars: Int

  public init(id: String? = nil, target: MemoryTarget, index: Int, text: String, chars: Int? = nil) {
    self.id = id ?? "\(target.rawValue):\(index)"
    self.target = target
    self.index = index
    self.text = text
    self.chars = chars ?? text.count
  }

  init(row: JSONValue, fallbackTarget: MemoryTarget, fallbackIndex: Int) {
    let object = row.objectValue ?? [:]
    let target = object["target"]?.stringValue.flatMap(MemoryTarget.init(rawValue:)) ?? fallbackTarget
    let index = object["index"]?.intValue ?? fallbackIndex
    let text = object["text"]?.stringValue ?? ""

    self.init(
      id: object["id"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
      target: target,
      index: index,
      text: text,
      // `chars` off the answer, and the text's own length only where the gateway sent none.
      chars: object["chars"]?.intValue
    )
  }
}

/// One file with what it costs.
public struct MemorySection: Sendable, Equatable, Identifiable {
  public var target: MemoryTarget
  public var entries: [MemoryEntry]
  /// What this file costs, delimiter included: the store's own number.
  public var chars: Int
  /// `0` on a gateway that configured no limit; the usage bar is not drawn then.
  public var limit: Int
  public var percent: Int

  public var id: MemoryTarget { target }

  public init(target: MemoryTarget, entries: [MemoryEntry] = [], chars: Int = 0, limit: Int = 0, percent: Int = 0) {
    self.target = target
    self.entries = entries
    self.chars = chars
    self.limit = limit
    self.percent = percent
  }

  /// How full the file is, between 0 and 1, or `nil` where there is no limit to be full against.
  public var fraction: Double? {
    guard limit > 0 else {
      return nil
    }

    return min(1, max(0, Double(chars) / Double(limit)))
  }

  /// The whole percent the usage bar's spoken label says: the gateway's own where it sent one.
  public var spokenPercent: Int {
    if percent > 0 || limit == 0 {
      return percent
    }

    return Int((Double(chars) * 100 / Double(limit)).rounded())
  }
}

/// A memory provider the gateway has. `enumerable` is false on every external one: a provider answers
/// a query with text and offers no call that lists what it holds, so naming it while saying it cannot
/// be opened is the honest version.
public struct MemoryProviderInfo: Sendable, Equatable, Identifiable {
  public var name: String
  public var description: String
  public var available: Bool
  public var enumerable: Bool

  public var id: String { name }
}

/// `GET …/memory/list`.
public struct MemoryListing: Sendable, Equatable {
  public var profile: String
  /// Both targets, in the plugin's order, even when one is empty: an absent section would read as
  /// "this gateway has no USER.md", which is not the same as one with nothing in it yet.
  public var sections: [MemorySection]
  public var providers: [MemoryProviderInfo]

  public init(profile: String = "", sections: [MemorySection] = [], providers: [MemoryProviderInfo] = []) {
    self.profile = profile
    self.sections = sections
    self.providers = providers
  }

  public init(_ body: JSONValue?) {
    let object = body?.objectValue ?? [:]
    var byTarget: [MemoryTarget: JSONObject] = [:]

    for row in object["targets"]?.arrayValue ?? [] {
      if let row = row.objectValue, let target = row["target"]?.stringValue.flatMap(MemoryTarget.init(rawValue:)) {
        byTarget[target] = row
      }
    }

    self.init(
      profile: object["profile"]?.stringValue ?? "",
      sections: MemoryTarget.allCases.map { target in
        let row = byTarget[target] ?? [:]
        let entries = (row["entries"]?.arrayValue ?? []).enumerated().map { index, entry in
          MemoryEntry(row: entry, fallbackTarget: target, fallbackIndex: index)
        }

        return MemorySection(
          target: target,
          entries: entries,
          chars: row["chars"]?.intValue ?? 0,
          limit: row["limit"]?.intValue ?? 0,
          percent: row["percent"]?.intValue ?? 0
        )
      },
      providers: (object["providers"]?.arrayValue ?? []).compactMap { row in
        guard let row = row.objectValue, let name = row["name"]?.stringValue, !name.isEmpty else {
          return nil
        }

        return MemoryProviderInfo(
          name: name,
          description: CapabilityText.line(row["description"]?.stringValue),
          available: row["available"]?.boolValue != false,
          enumerable: row["enumerable"]?.boolValue == true
        )
      }
    )
  }

  public func section(_ target: MemoryTarget) -> MemorySection? {
    sections.first { $0.target == target }
  }

  /// The providers that say they cannot be opened.
  public var externalProviders: [MemoryProviderInfo] {
    providers.filter { !$0.enumerable }
  }
}

/// `GET …/memory/search?q=…`: one list, across both targets, ids kept.
public struct MemorySearchAnswer: Sendable, Equatable {
  public var query: String
  public var results: [MemoryEntry]

  public init(query: String = "", results: [MemoryEntry] = []) {
    self.query = query
    self.results = results
  }

  public init(_ body: JSONValue?) {
    let object = body?.objectValue ?? [:]

    self.init(
      query: object["query"]?.stringValue ?? "",
      results: (object["results"]?.arrayValue ?? []).enumerated().map { index, row in
        MemoryEntry(row: row, fallbackTarget: .memory, fallbackIndex: index)
      }
    )
  }
}

/// What a write answered: the store's own result, with nothing added to it, so `error` is Hermes'
/// sentence about what went wrong (a character limit, an entry that has moved) and is shown as it is.
public struct MemoryWriteAnswer: Sendable, Equatable {
  public var success: Bool
  public var error: String?
  /// The target as the store re-read it after a stale-index refusal. Not applied: the page reads the
  /// listing again, because one rebuilt from half an answer would have the bar and the entries
  /// disagree.
  public var currentEntries: [String]?

  public init(success: Bool, error: String? = nil, currentEntries: [String]? = nil) {
    self.success = success
    self.error = error
    self.currentEntries = currentEntries
  }

  public init(_ body: JSONValue?) {
    let object = body?.objectValue ?? [:]
    let said = object["error"]?.stringValue ?? ""

    self.init(
      success: object["success"]?.boolValue == true,
      error: said.isEmpty ? nil : said,
      currentEntries: object["current_entries"]?.arrayValue?.compactMap(\.stringValue)
    )
  }
}

/// One stored document of one backend, as it is held rather than as parsed.
public struct MemoryDocument: Sendable, Equatable, Identifiable {
  /// The backend's own name for it: `memory`, `user`, a collection.
  public var id: String
  /// What to put on the card: `MEMORY.md`.
  public var label: String
  /// The content as stored. Empty is a real answer: the file exists and is bare.
  public var content: String
  public var chars: Int
  /// The gateway cut it. Said out loud rather than shown as the whole of it.
  public var truncated: Bool
}

/// One backend's raw side: what it holds, or why it cannot say.
public struct MemoryBackendRaw: Sendable, Equatable, Identifiable {
  public var name: String
  public var label: String
  /// The gateway has this backend at all.
  public var available: Bool
  /// The route would take a write for it. Nothing writes raw content: entries are edited one by one.
  public var editable: Bool
  /// Why there are no documents, when there are none and that is not an error.
  public var note: String?
  public var documents: [MemoryDocument]

  public var id: String { name }
}

/// `GET …/memory/raw`: a route newer than the plugin the first gateways ran, so a gateway without it
/// is a state (`MemoryModel.RawState.missing`) and not a failure.
public struct MemoryRaw: Sendable, Equatable {
  public var profile: String
  public var backends: [MemoryBackendRaw]

  public init(profile: String = "", backends: [MemoryBackendRaw] = []) {
    self.profile = profile
    self.backends = backends
  }

  public init(_ body: JSONValue?) {
    let object = body?.objectValue ?? [:]

    self.init(
      profile: object["profile"]?.stringValue ?? "",
      backends: (object["backends"]?.arrayValue ?? []).compactMap { row in
        guard let row = row.objectValue, let name = row["name"]?.stringValue, !name.isEmpty else {
          return nil
        }

        let documents: [MemoryDocument] = (row["documents"]?.arrayValue ?? []).compactMap { document in
          guard let document = document.objectValue else {
            return nil
          }

          let content = document["content"]?.stringValue ?? ""
          let label = document["label"]?.stringValue ?? ""
          let id = document["id"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? label

          return MemoryDocument(
            id: id,
            label: label.isEmpty ? id : label,
            content: content,
            chars: document["chars"]?.intValue ?? content.count,
            truncated: document["truncated"]?.boolValue == true
          )
        }

        let note = CapabilityText.text(row["note"]?.stringValue)
        let label = row["label"]?.stringValue ?? ""

        return MemoryBackendRaw(
          name: name,
          label: label.isEmpty ? name : label,
          available: row["available"]?.boolValue != false,
          editable: row["editable"]?.boolValue == true,
          note: note.isEmpty ? nil : note,
          documents: documents
        )
      }
    )
  }
}

/// What the page has to decide between before it draws anything.
public enum MemoryAvailability: Sendable, Equatable {
  /// The roster has not been read, so what the plugin offers is not known yet.
  case unknown
  /// The gateway has no Hermie plugin, or one that does not browse memory.
  case missing
  /// Memory can be read and not written (`memory.edit` is off for this profile).
  case readOnly
  case editable

  public static let browseCapability = "memory.browse"
  public static let editCapability = "memory.edit"

  /// From the roster: whether it has been read, and what the plugin's advert listed.
  public static func of(capabilities: Set<String>, refreshed: Bool) -> MemoryAvailability {
    guard refreshed else {
      return .unknown
    }

    guard capabilities.contains(browseCapability) else {
      return .missing
    }

    return capabilities.contains(editCapability) ? .editable : .readOnly
  }

  public var canRead: Bool { self == .readOnly || self == .editable }
  public var canWrite: Bool { self == .editable }
}

/// A write, named the way the plugin names it.
public enum MemoryOperation: String, Sendable {
  case add
  case replace
  case remove
}
