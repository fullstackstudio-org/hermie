import Foundation
import HermieGateway
import HermieProtocol

/**
 Skills: what is installed, what the hub offers, and which bot has which on (`skills-controller.ts` in
 the Expo app).

 Two gateway methods with a seam between them that is easy to miss.

 `skills.manage {action: "list"}` answers a CATEGORY MAP, `{bundled: [...], installed: [...]}`, of
 names, and carries no enabled flag at all. Whether a skill is on is per BOT and lives in
 `profiles.describe`, as the complement of the stored disabled set. A page that only called
 `skills.manage` could tell what exists and never whether any of it is on; one that only called
 `profiles.describe` would miss everything the hub could install.

 Installing from the hub works over the socket (`skills.manage {action: "install"}`). There is no
 uninstall in the gateway's socket methods, so none is offered here.
 */

/// One installed skill, joined across the two methods.
public struct InstalledSkill: Sendable, Equatable, Identifiable {
  public var name: String
  /// `bundled`, `installed`, or whatever category the gateway filed it under.
  public var category: String
  /// From `profiles.describe`. `nil` where no bot was asked about, or the gateway would not say: a
  /// row is then drawn without a state and never with one defaulted to on.
  public var enabled: Bool?

  public var id: String { name }

  public init(name: String, category: String, enabled: Bool? = nil) {
    self.name = name
    self.category = category
    self.enabled = enabled
  }
}

/// One row of the hub: a `search` hit (name and description only) or a `browse` item (with where it
/// comes from and how far it is trusted).
public struct HubSkill: Sendable, Equatable, Identifiable {
  public var name: String
  public var description: String
  public var source: String?
  public var trust: String?
  /// What `install` and `inspect` take: the item's own identifier where the gateway sent one, else its name.
  public var identifier: String

  public var id: String { identifier }

  public init(name: String, description: String = "", source: String? = nil, trust: String? = nil, identifier: String? = nil)
  {
    self.name = name
    self.description = description
    self.source = source
    self.trust = trust
    self.identifier = identifier.flatMap { $0.isEmpty ? nil : $0 } ?? name
  }

  init?(row: JSONValue) {
    guard let object = row.objectValue, let name = object["name"]?.stringValue, !name.isEmpty else {
      return nil
    }

    self.init(
      name: name,
      description: CapabilityText.text(object["description"]?.stringValue),
      source: object["source"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
      trust: object["trust"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
      identifier: object["identifier"]?.stringValue
    )
  }
}

/// One page of `browse`.
public struct HubPage: Sendable, Equatable {
  public var items: [HubSkill]
  public var page: Int
  public var totalPages: Int
  public var total: Int

  public init(items: [HubSkill] = [], page: Int = 1, totalPages: Int = 1, total: Int = 0) {
    self.items = items
    self.page = page
    self.totalPages = totalPages
    self.total = total
  }

  public var hasMore: Bool { page < totalPages }
}

/// `inspect`: what the hub says about one skill, which is `{}` when the identifier resolves nowhere.
public struct SkillInfo: Sendable, Equatable {
  public var name: String
  public var description: String
  public var source: String?
  public var identifier: String?
  public var tags: [String]
  /// The start of its SKILL.md. Untrusted text, shown as plain text.
  public var preview: String

  public init(
    name: String, description: String = "", source: String? = nil, identifier: String? = nil, tags: [String] = [],
    preview: String = ""
  ) {
    self.name = name
    self.description = description
    self.source = source
    self.identifier = identifier
    self.tags = tags
    self.preview = preview
  }

  /// `nil` for the empty answer a miss gives.
  init?(_ info: JSONValue?) {
    guard let object = info?.objectValue, !object.isEmpty else {
      return nil
    }

    self.init(
      name: object["name"]?.stringValue ?? "",
      description: CapabilityText.text(object["description"]?.stringValue),
      source: object["source"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
      identifier: object["identifier"]?.stringValue,
      tags: (object["tags"]?.arrayValue ?? []).compactMap(\.stringValue),
      preview: CapabilityText.text(object["skill_md_preview"]?.stringValue, limit: 2_000)
    )
  }
}

/// The gateway's calls behind the Skills page.
public struct SkillsService: Sendable {
  /// How many hub items a page asks for.
  public static let pageSize = 20

  let gateway: BotSettingsGateway

  public init(gateway: BotSettingsGateway) {
    self.gateway = gateway
  }

  /// The installed list, with each bot's switch position where a bot was named.
  ///
  /// `profiles.describe` is allowed to fail on its own: an older gateway may not have it, and a list
  /// of skills with no switches is still a useful one. What is not acceptable is guessing: `nil`
  /// means nobody asked.
  public func installed(profile: String?) async throws -> [InstalledSkill] {
    var params: JSONObject = ["action": "list"]

    if let profile {
      params["profile"] = .string(profile)
    }

    let listed = try await gateway.request(RPC.SkillsManage.name, params)
    var enabled: [String: Bool]?

    if let profile, let described = try? await gateway.request(RPC.ProfilesDescribe.name, ["name": .string(profile)]) {
      enabled = [:]

      for entry in described["skills"]?.arrayValue ?? [] {
        if let name = entry["name"]?.stringValue {
          enabled?[name] = entry["enabled"]?.boolValue != false
        }
      }
    }

    // `skills` is an OBJECT of arrays: a client that read it as an array would get nothing and draw an
    // empty page rather than an error.
    let categories = listed["skills"]?.objectValue ?? [:]
    var rows: [InstalledSkill] = []

    for (category, names) in categories {
      for name in names.arrayValue?.compactMap(\.stringValue) ?? [] where !name.isEmpty {
        rows.append(InstalledSkill(name: name, category: category, enabled: enabled.map { $0[name] ?? true }))
      }
    }

    return rows.sorted { left, right in
      left.name.localizedStandardCompare(right.name) == .orderedAscending
    }
  }

  /// One page of the hub, browsed.
  public func browse(page: Int) async throws -> HubPage {
    let result = try await gateway.request(
      RPC.SkillsManage.name,
      ["action": "browse", "page": .number(Double(page)), "page_size": .number(Double(Self.pageSize))])

    return HubPage(
      items: (result["items"]?.arrayValue ?? []).compactMap { HubSkill(row: $0) },
      page: result["page"]?.intValue ?? page,
      totalPages: max(1, result["total_pages"]?.intValue ?? 1),
      total: result["total"]?.intValue ?? 0
    )
  }

  /// The hub, searched. `search` answers `results` where `browse` answers `items`, and the fields they
  /// carry are not the same either.
  public func search(_ query: String) async throws -> [HubSkill] {
    let result = try await gateway.request(RPC.SkillsManage.name, ["action": "search", "query": .string(query)])

    return (result["results"]?.arrayValue ?? []).compactMap { HubSkill(row: $0) }
  }

  public func inspect(_ identifier: String) async throws -> SkillInfo? {
    SkillInfo(
      try await gateway.request(RPC.SkillsManage.name, ["action": "inspect", "query": .string(identifier)])["info"])
  }

  /// Install one skill from the hub into a bot's skills directory; the installed name. The gateway
  /// raises on a miss, so a refusal arrives as a thrown error, and `installed: false` is one too.
  @discardableResult
  public func install(_ identifier: String, profile: String?) async throws -> String {
    var params: JSONObject = ["action": "install", "query": .string(identifier)]

    if let profile {
      params["profile"] = .string(profile)
    }

    let result = try await gateway.request(RPC.SkillsManage.name, params)

    if result["installed"]?.boolValue == false {
      throw GatewayRPCError(.rejected, "The gateway did not install \(identifier).")
    }

    return result["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? identifier
  }

  /// The command that does it where the socket cannot: what the page prints when the gateway refuses
  /// the action outright, as an older one without it does (`unknown skills action`, code 4017).
  public static func installCommand(_ identifier: String, profile: String?) -> String {
    guard let profile, !profile.isEmpty else {
      return "hermes skills install \(identifier)"
    }

    return "hermes --profile \(profile) skills install \(identifier)"
  }

  /// The command that removes an installed skill. The socket has no uninstall, so this is what the page
  /// offers to copy: it is run on the machine that hosts the gateway.
  public static func uninstallCommand(_ name: String, profile: String?) -> String {
    guard let profile, !profile.isEmpty else {
      return "hermes skills uninstall \(name)"
    }

    return "hermes --profile \(profile) skills uninstall \(name)"
  }

  /// Whether a refusal was the gateway saying it has no such action.
  public static func isUnknownAction(_ error: any Error) -> Bool {
    if let rpc = error as? GatewayRPCError {
      return rpc.code == 4017 || rpc.message.localizedCaseInsensitiveContains("unknown skills action")
    }

    return false
  }
}
