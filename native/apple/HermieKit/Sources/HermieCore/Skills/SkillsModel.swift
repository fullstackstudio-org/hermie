import Foundation
import Observation

/**
 The Skills page's state: the installed skills of one bot, the hub (browsed a page at a time, or
 searched), what one hub skill says about itself, and an install.

 ## What is shown, and what is asked

 The installed list is read for the bot the page is about, with each skill's switch position beside it
 (read only here: the switches are written from the bot's own settings, which the page links to). The
 hub is read on demand: a page of the browse list when the page opens, a search when the person types,
 and nothing is installed without a tap. A read that a newer one overtook is dropped.

 An install is one at a time per skill and reads the installed list again after it. A gateway that
 refuses the action outright (an older one) is told as the command to run on its own machine, which is
 what the page prints in its place.

 Every text here is the gateway's or a skill author's: plain text, never Markdown.
 */
@MainActor
@Observable
public final class SkillsModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    case failed(String)
  }

  public enum HubPhase: Equatable, Sendable {
    /// Nothing asked yet.
    case idle
    case loading
    case ready
    case failed(String)
  }

  /// What one hub skill says about itself.
  public enum Inspection: Equatable, Sendable {
    case loading
    case loaded(SkillInfo)
    /// The identifier resolves nowhere (`{}`).
    case unknown
    case failed(String)
  }

  /// Something that happened and is worth one line.
  public enum Notice: Equatable, Sendable {
    case installed(String)
    case installFailed(String)
    /// The gateway cannot install over its socket: the command to run where it lives.
    case installCommand(String)
    /// The installed list could not be read again.
    case failed(String)
  }

  /// The bot the page is about; `nil` reads the gateway's own.
  public private(set) var profile: String?
  public private(set) var phase = Phase.loading
  public private(set) var installed: [InstalledSkill] = []
  public private(set) var hubPhase = HubPhase.idle
  public private(set) var hub: [HubSkill] = []
  public private(set) var query = ""
  /// The hub's browse paging, which a search has none of.
  public private(set) var hubPage = HubPage()
  public private(set) var installing: Set<String> = []
  public private(set) var inspected: [String: Inspection] = [:]
  public private(set) var notice: Notice?

  @ObservationIgnored private let service: SkillsService
  @ObservationIgnored private var round = 0
  @ObservationIgnored private var hubRound = 0

  public init(service: SkillsService, profile: String?) {
    self.service = service
    self.profile = profile
  }

  // MARK: Reading

  /// The names that are installed, for marking the hub's rows.
  public var installedNames: Set<String> {
    Set(installed.map(\.name))
  }

  public func isInstalled(_ skill: HubSkill) -> Bool {
    installedNames.contains(skill.name) || installedNames.contains(skill.identifier)
  }

  /// The hub is being browsed (not searched) and has another page.
  public var canLoadMore: Bool {
    query.isEmpty && hubPage.hasMore && hubPhase == .ready
  }

  /// Point the page at another bot. The installed list is read again, which is what carries the new
  /// bot's switch positions.
  public func setProfile(_ profile: String?) async {
    guard self.profile != profile else {
      return
    }

    self.profile = profile
    await load()
  }

  /// Read the installed list. A list already on screen stays while it is read again.
  public func load() async {
    round += 1
    let mine = round
    let asked = profile

    do {
      let rows = try await service.installed(profile: asked)

      if round == mine {
        installed = rows
        phase = .ready
      }
    } catch {
      guard round == mine else {
        return
      }

      if phase == .ready {
        notice = .failed(CapabilityText.words(of: error))
      } else {
        phase = .failed(CapabilityText.words(of: error))
      }
    }
  }

  /// Read the hub for what is typed: a search for text, the first page of the browse list for none.
  public func searchHub(_ text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

    query = trimmed
    hubRound += 1
    let mine = hubRound
    hubPhase = .loading

    do {
      if trimmed.isEmpty {
        let page = try await service.browse(page: 1)

        if hubRound == mine {
          hub = page.items
          hubPage = page
          hubPhase = .ready
        }
      } else {
        let hits = try await service.search(trimmed)

        if hubRound == mine {
          hub = hits
          hubPage = HubPage()
          hubPhase = .ready
        }
      }
    } catch {
      if hubRound == mine {
        hubPhase = .failed(CapabilityText.words(of: error))
      }
    }
  }

  /// The next page of the browse list, appended. Rows the hub listed twice are kept once.
  public func loadMore() async {
    guard canLoadMore else {
      return
    }

    hubRound += 1
    let mine = hubRound
    let next = hubPage.page + 1

    do {
      let page = try await service.browse(page: next)

      if hubRound == mine {
        let known = Set(hub.map(\.id))

        hub += page.items.filter { !known.contains($0.id) }
        hubPage = page
      }
    } catch {
      if hubRound == mine {
        notice = .failed(CapabilityText.words(of: error))
      }
    }
  }

  /// What the hub says about one skill. Asked once per skill: the answer is kept.
  public func inspect(_ skill: HubSkill) async {
    if case .loaded = inspected[skill.id] {
      return
    }

    inspected[skill.id] = .loading

    do {
      if let info = try await service.inspect(skill.identifier) {
        inspected[skill.id] = .loaded(info)
      } else {
        inspected[skill.id] = .unknown
      }
    } catch {
      inspected[skill.id] = .failed(CapabilityText.words(of: error))
    }
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: Installing

  /// Install a hub skill into the bot's skills; true when the gateway did.
  @discardableResult
  public func install(_ skill: HubSkill) async -> Bool {
    guard !installing.contains(skill.id), !isInstalled(skill) else {
      return false
    }

    installing.insert(skill.id)
    notice = nil
    defer { installing.remove(skill.id) }

    do {
      let name = try await service.install(skill.identifier, profile: profile)

      notice = .installed(name)
      await load()

      return true
    } catch {
      notice =
        SkillsService.isUnknownAction(error)
        ? .installCommand(SkillsService.installCommand(skill.identifier, profile: profile))
        : .installFailed(CapabilityText.words(of: error))

      return false
    }
  }
}
