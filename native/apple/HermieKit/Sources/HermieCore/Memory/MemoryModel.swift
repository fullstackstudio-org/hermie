import Foundation
import Observation

/**
 One bot's memory page: the two files as entries, a search over both, the raw side, and the writes
 (`useMemory` and `MemoryController` in the Expo app).

 ## A write is followed by a read

 A write answers the store's own result and little else, and what the page needs afterwards is not
 in it: the positional ids have all shifted, and the usage has moved by the delimiter as well as by
 the text. Rebuilding the listing from the answer would mean this model holding a second opinion
 about how full a file is, so every successful write reads the listing again, and the read is the
 source of truth. A refusal is shown in the store's own words: a limit, an entry that has moved.

 One write runs at a time, and a read that a newer one overtook is dropped. Every text here is the
 gateway's or the bot's: plain text, never Markdown.
 */
@MainActor
@Observable
public final class MemoryModel {
  /// Where the first read stands.
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    /// The route is not mounted: the plugin is absent or too old.
    case missing
    /// The route is there and this profile has memory browsing switched off (403). The REST client
    /// keeps no sentence from a 403, so the page says it in its own words.
    case switchedOff
    case failed(String)
  }

  public enum SearchState: Equatable, Sendable {
    case idle
    case searching
    case results(MemorySearchAnswer)
    case failed(String)
  }

  /// Something a write or a refresh said that is worth a line.
  public enum Notice: Equatable, Sendable {
    /// In the gateway's own words.
    case words(String)
    /// The gateway refused a write because memory editing is switched off for this profile (403).
    case editSwitchedOff
  }

  public enum RawState: Equatable, Sendable {
    case idle
    case loading
    case loaded(MemoryRaw)
    /// This gateway's plugin does not serve raw memory.
    case missing
    case failed(String)
  }

  /// The bot's handle: the gateway's profile name.
  public let profile: String
  /// What the plugin lets this person do. It moves when the roster is read again.
  public private(set) var availability: MemoryAvailability

  public private(set) var phase = Phase.loading
  public private(set) var listing: MemoryListing?
  public private(set) var query = ""
  public private(set) var search = SearchState.idle
  public private(set) var raw = RawState.idle
  /// A write is running.
  public private(set) var busy = false
  /// What the last write that failed said; cleared by the next write or by `dismissNotice()`.
  public private(set) var notice: Notice?

  @ObservationIgnored private let backend: any MemoryBackend
  @ObservationIgnored private var round = 0
  @ObservationIgnored private var searchRound = 0
  @ObservationIgnored private var rawRound = 0

  public init(backend: any MemoryBackend, profile: String, availability: MemoryAvailability) {
    self.backend = backend
    self.profile = profile
    self.availability = availability
  }

  // MARK: Reading

  public func setAvailability(_ availability: MemoryAvailability) {
    if self.availability != availability {
      self.availability = availability
    }
  }

  public var canWrite: Bool { availability.canWrite }

  /// A search is in the field: the page draws its results instead of both files.
  public var isSearching: Bool {
    !query.isEmpty
  }

  /// Read the listing. A listing already on screen stays while it is read again, and a failed
  /// refresh of one says so without blanking it.
  public func load() async {
    round += 1
    let mine = round

    do {
      let read = try await backend.list(profile: profile)

      if round == mine {
        listing = read
        phase = .ready
      }
    } catch {
      guard round == mine else {
        return
      }

      if CapabilityText.isMissingRoute(error) {
        phase = .missing
      } else if CapabilityText.isSwitchedOff(error) {
        phase = .switchedOff
      } else if listing == nil {
        phase = .failed(CapabilityText.words(of: error))
      } else {
        notice = .words(CapabilityText.words(of: error))
      }
    }
  }

  /// Search both files for `text`. An empty query is not sent (the route refuses it with a 400, and
  /// "you have not typed anything yet" is no error): it clears the results.
  public func search(_ text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

    query = trimmed
    searchRound += 1
    let mine = searchRound

    guard !trimmed.isEmpty else {
      search = .idle

      return
    }

    search = .searching

    do {
      let answer = try await backend.search(profile: profile, query: trimmed)

      if searchRound == mine {
        search = .results(answer)
      }
    } catch {
      if searchRound == mine {
        search = .failed(CapabilityText.words(of: error))
      }
    }
  }

  /// Read what each backend holds, as stored. Read when the Raw tab is opened, not beside the
  /// listing: most readers never open it.
  public func loadRaw() async {
    rawRound += 1
    let mine = rawRound

    if case .loaded = raw {
      // Stays on screen while it is read again.
    } else {
      raw = .loading
    }

    do {
      let read = try await backend.raw(profile: profile)

      if rawRound == mine {
        raw = .loaded(read)
      }
    } catch {
      guard rawRound == mine else {
        return
      }

      // A gateway without the route is a gateway with one tab fewer to show, not an error.
      raw = CapabilityText.isMissingRoute(error) ? .missing : .failed(CapabilityText.words(of: error))
    }
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: Writing

  /// Add an entry to `target`; true when the gateway took it.
  @discardableResult
  public func add(_ target: MemoryTarget, content: String) async -> Bool {
    let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty else {
      return false
    }

    return await write(.add, target: target, content: trimmed, entry: nil)
  }

  /// Replace one entry's text; true when the gateway took it. An unchanged text is not sent.
  @discardableResult
  public func replace(_ entry: MemoryEntry, with content: String) async -> Bool {
    let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty, trimmed != entry.text else {
      return false
    }

    return await write(.replace, target: entry.target, content: trimmed, entry: entry)
  }

  /// Remove one entry; true when the gateway did. The caller has asked first: Hermes keeps no
  /// history of a memory file.
  @discardableResult
  public func remove(_ entry: MemoryEntry) async -> Bool {
    await write(.remove, target: entry.target, content: nil, entry: entry)
  }

  private func write(_ operation: MemoryOperation, target: MemoryTarget, content: String?, entry: MemoryEntry?) async
    -> Bool
  {
    guard canWrite, !busy else {
      return false
    }

    busy = true
    notice = nil
    defer { busy = false }

    let answer: MemoryWriteAnswer

    do {
      answer = try await backend.write(
        profile: profile, operation: operation, target: target, content: content, entry: entry)
    } catch {
      notice = CapabilityText.isSwitchedOff(error) ? .editSwitchedOff : .words(CapabilityText.words(of: error))

      return false
    }

    // Whether it landed or the store said the entry had moved, what is on screen is now stale.
    await refreshAfterWrite()

    guard answer.success else {
      let said = CapabilityText.line(answer.error)

      notice = .words(said.isEmpty ? "The gateway refused that change." : said)

      return false
    }

    return true
  }

  private func refreshAfterWrite() async {
    await load()

    if !query.isEmpty {
      await search(query)
    }

    if case .loaded = raw {
      await loadRaw()
    }
  }
}
