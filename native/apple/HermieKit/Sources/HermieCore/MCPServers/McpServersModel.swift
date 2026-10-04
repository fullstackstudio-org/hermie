import Foundation
import HermieProtocol
import Observation

/**
 The MCP servers page's state: one bot's configured servers with their cached runtime state, what a
 probe found for each, the OAuth walk, the catalogue, and the writes (add, remove, an API key).

 ## Nothing is probed on the person's behalf

 The list paints from the config and the cached runtime rows. A probe connects, and a cold `npx`
 server takes seconds, so probing three of them on every visit would make the page feel broken: it is a
 button. A server that needs authorising is a probe result, never a badge on the list, because only a
 probe can tell it from one that is fine.

 ## The OAuth walk

 Start, hand the link to the system browser, poll until it settles. The gateway keeps its own
 redirect listener, so the person comes back to this page and the poll sees the approval. Whichever
 way it ends (approved, refused, timed out, or the person leaves the page and the task is cancelled)
 the gateway is told the flow is over.

 ## A secret goes one way

 A bearer token or an API key is sent to the gateway, which writes it to the profile's `.env`. It is
 never kept here after the call, never read back, and never part of a notice.

 Every text here is the gateway's or a server author's: plain text, never Markdown. A read that a
 newer one overtook is dropped; one write runs at a time.
 */
@MainActor
@Observable
public final class McpServersModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    case failed(String)
  }

  /// What the last probe of a server found.
  public enum ProbeState: Equatable, Sendable {
    case testing
    case done(McpProbe)
    /// The call itself failed (not a probe that found a broken server).
    case failed(String)
  }

  public enum CatalogState: Equatable, Sendable {
    case idle
    case loading
    case loaded([McpCatalogEntry])
    case failed(String)
  }

  /// Something that happened and is worth one line.
  public enum Notice: Equatable, Sendable {
    case authorised(String)
    case authoriseFailed(String)
    case added(String)
    case removed(String)
    case keySaved(String)
    case reloaded
    /// The authorisation link the gateway sent could not be opened (not an https link, or the system
    /// would not open it).
    case linkRefused
    case failure(String)
  }

  /// The gateway's question about reloading: its own warning about the prompt cache.
  public struct ReloadPrompt: Equatable, Sendable {
    public var message: String
  }

  /// The bot the page is about; `nil` reads the gateway's own.
  public private(set) var profile: String?
  public private(set) var phase = Phase.loading
  public private(set) var servers: [McpServerRow] = []
  public private(set) var probes: [String: ProbeState] = [:]
  public private(set) var catalog = CatalogState.idle
  /// Servers with a write in flight.
  public private(set) var busy: Set<String> = []
  /// The server whose OAuth walk is running.
  public private(set) var authorising: String?
  public private(set) var notice: Notice?
  public private(set) var reloadPrompt: ReloadPrompt?
  /// An add is running.
  public private(set) var adding = false
  /// Why the last add was refused, in the gateway's words; cleared by the next one.
  public private(set) var addError: String?

  @ObservationIgnored private let service: McpServersService
  @ObservationIgnored private let pollInterval: Duration
  @ObservationIgnored private let maxPolls: Int
  @ObservationIgnored private var round = 0

  /// - Parameters:
  ///   - pollInterval: how often `oauth.poll` is asked, as the desktop's own driver does. Zero (a
  ///     test's) waits for no time at all.
  ///   - maxPolls: how many polls the walk makes before it gives up: six minutes at the default.
  public init(
    service: McpServersService, profile: String?, pollInterval: Duration = .seconds(1), maxPolls: Int = 360
  ) {
    self.service = service
    self.profile = profile
    self.pollInterval = pollInterval
    self.maxPolls = maxPolls
  }

  /// Wait for the next poll: the interval, or just a turn of the executor where the interval is zero
  /// (a test's). Not an injected closure: the Swift 6.4 runtime aborts on calling a stored `async`
  /// closure here the first time it really suspends.
  private func waitForNextPoll() async {
    if pollInterval > .zero {
      try? await Task.sleep(for: pollInterval)
    } else {
      await Task.yield()
    }
  }

  // MARK: Reading

  public func server(named name: String) -> McpServerRow? {
    servers.first { $0.name == name }
  }

  public func setProfile(_ profile: String?) async {
    guard self.profile != profile else {
      return
    }

    self.profile = profile
    probes = [:]
    catalog = .idle
    await load()
  }

  /// Read the list. A list already on screen stays while it is read again.
  public func load() async {
    round += 1
    let mine = round

    do {
      let rows = try await service.servers(profile: profile)

      if round == mine {
        servers = rows
        phase = .ready
      }
    } catch {
      guard round == mine else {
        return
      }

      if phase == .ready {
        notice = .failure(CapabilityText.words(of: error))
      } else {
        phase = .failed(CapabilityText.words(of: error))
      }
    }
  }

  /// Read the catalogue, when the add sheet opens.
  public func loadCatalog() async {
    if case .loading = catalog {
      return
    }

    catalog = .loading

    do {
      catalog = .loaded(try await service.catalog(profile: profile))
    } catch {
      catalog = .failed(CapabilityText.words(of: error))
    }
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: Probing

  /// Connect to one server and list what it offers.
  public func test(_ name: String) async {
    guard probes[name] != .testing else {
      return
    }

    probes[name] = .testing

    do {
      probes[name] = .done(try await service.test(name, profile: profile))
    } catch {
      probes[name] = .failed(CapabilityText.words(of: error))
    }
  }

  // MARK: Authorising

  /// Walk an OAuth flow for `name`. `open` hands the link to the system browser and answers whether it
  /// was opened. True when the server was authorised.
  ///
  /// `open` is `@escaping` although the walk never stores it: it is held across the walk's suspensions,
  /// and the Swift 6.4 runtime aborts ("freed pointer was not the last allocation") on a non-escaping
  /// closure that outlives a real suspension.
  @discardableResult
  public func authorise(_ name: String, open: @escaping @MainActor (URL) -> Bool) async -> Bool {
    guard authorising == nil else {
      return false
    }

    authorising = name
    notice = nil
    defer { authorising = nil }

    let started: (sessionID: String, authURL: String)

    do {
      started = try await service.startOAuth(name, profile: profile)
    } catch {
      notice = .authoriseFailed(CapabilityText.words(of: error))

      return false
    }

    // The link is the gateway's text and goes to the person's browser: https only, a host, and no
    // user or password before it.
    guard !started.sessionID.isEmpty, let link = AuthorisationLink(started.authURL), open(link.url) else {
      notice = .linkRefused

      if !started.sessionID.isEmpty {
        await service.cancelOAuth(name, sessionID: started.sessionID, profile: profile)
      }

      return false
    }

    for _ in 0..<maxPolls {
      do {
        try Task.checkCancellation()

        switch try await service.pollOAuth(name, sessionID: started.sessionID, profile: profile) {
        case .approved(let tools):
          probes[name] = .done(McpProbe(ok: true, tools: tools))
          notice = .authorised(name)
          await load()

          return true
        case .failed(let words):
          notice = .authoriseFailed(words)
          await service.cancelOAuth(name, sessionID: started.sessionID, profile: profile)

          return false
        case .pending:
          await waitForNextPoll()
        }
      } catch {
        // Always tell the gateway the flow is over.
        await service.cancelOAuth(name, sessionID: started.sessionID, profile: profile)

        if !(error is CancellationError) {
          notice = .authoriseFailed(CapabilityText.words(of: error))
        }

        return false
      }
    }

    notice = .authoriseFailed("Timed out waiting for the authorisation to finish.")
    await service.cancelOAuth(name, sessionID: started.sessionID, profile: profile)

    return false
  }

  // MARK: Writing

  /// Add a server from what the person wrote; true when the gateway took it. A draft with problems is
  /// not sent: the sheet shows what is wrong.
  @discardableResult
  public func add(_ draft: McpServerDraft) async -> Bool {
    guard !adding, draft.problems.isEmpty else {
      return false
    }

    adding = true
    addError = nil
    defer { adding = false }

    do {
      _ = try await service.add(draft, profile: profile)
    } catch {
      addError = CapabilityText.words(of: error)

      return false
    }

    notice = .added(draft.trimmedName)
    await load()
    await refreshCatalogIfLoaded()

    return true
  }

  /// Add a server from a catalogue preset; true when the gateway took it.
  @discardableResult
  public func addPreset(_ entry: McpCatalogEntry) async -> Bool {
    guard !adding, !entry.installed, server(named: entry.name) == nil else {
      return false
    }

    adding = true
    addError = nil
    defer { adding = false }

    do {
      _ = try await service.addPreset(entry.name, profile: profile)
    } catch {
      addError = CapabilityText.words(of: error)

      return false
    }

    notice = .added(entry.name)
    await load()
    await refreshCatalogIfLoaded()

    return true
  }

  /// The add sheet is opened again: what the last add said is stale.
  public func beginAdding() {
    addError = nil
  }

  /// Take a server out of the bot's config; true when the gateway did. The caller has asked first.
  @discardableResult
  public func remove(_ name: String) async -> Bool {
    await mutate(name) {
      try await self.service.remove(name, profile: self.profile)
      self.servers.removeAll { $0.name == name }
      self.probes[name] = nil
      self.notice = .removed(name)
    }
  }

  /// Write an API key for a server. The value goes to the gateway and nowhere else.
  @discardableResult
  public func setAPIKey(_ name: String, value: String, envVar: String? = nil) async -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty else {
      return false
    }

    return await mutate(name) {
      try await self.service.setAPIKey(name, value: trimmed, envVar: envVar, profile: self.profile)
      self.notice = .keySaved(name)
      // The key changes what the server needs: the earlier probe no longer says anything about it.
      self.probes[name] = nil
    }
  }

  private func mutate(_ name: String, _ work: () async throws -> Void) async -> Bool {
    guard !busy.contains(name) else {
      return false
    }

    busy.insert(name)
    notice = nil
    defer { busy.remove(name) }

    do {
      try await work()
    } catch {
      notice = .failure(CapabilityText.words(of: error))

      return false
    }

    await load()

    return true
  }

  private func refreshCatalogIfLoaded() async {
    if case .loaded = catalog {
      catalog = .loaded((try? await service.catalog(profile: profile)) ?? [])
    }
  }

  // MARK: Reloading

  /// Ask the gateway to reload its MCP servers into the chats that are running. It may answer with a
  /// question first: the reload makes every live chat send its whole input again on its next message,
  /// which the person pays for.
  public func reload() async {
    reloadPrompt = nil

    do {
      switch try await service.reload() {
      case .reloaded: notice = .reloaded
      case .confirmationRequired(let message): reloadPrompt = ReloadPrompt(message: message)
      }
    } catch {
      notice = .failure(CapabilityText.words(of: error))
    }
  }

  /// The person answered the gateway's question. `always` proceeds and clears the approval in the
  /// gateway's own config, which the CLI and the desktop app share: it is not a local preference.
  public func confirmReload(always: Bool) async {
    reloadPrompt = nil

    do {
      _ = try await service.reload(confirm: true, always: always)
      notice = .reloaded
    } catch {
      notice = .failure(CapabilityText.words(of: error))
    }
  }

  public func declineReload() {
    reloadPrompt = nil
  }
}
