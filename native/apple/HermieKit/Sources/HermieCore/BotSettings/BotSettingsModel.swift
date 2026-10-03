import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// The calls the bot settings make, as one function: a test hands over a closure, production a
/// session's link.
public struct BotSettingsGateway: Sendable {
  public let request: @Sendable (_ method: String, _ params: JSONObject) async throws -> JSONValue

  public init(request: @escaping @Sendable (_ method: String, _ params: JSONObject) async throws -> JSONValue) {
    self.request = request
  }

  /// Over a session's link.
  public static func link(_ link: any GatewayLink) -> BotSettingsGateway {
    BotSettingsGateway { method, params in
      try await link.requestReply(method, params: .object(params)).result
    }
  }
}

/**
 One bot's settings on the gateway: what `profiles.describe` reads, and the writes
 `profiles.configure`, `profiles.set_asset` and `reload.mcp` make.

 ## What waits for a button and what writes at once

 Two fields are text, the description and the personality (`SOUL.md`), and a text field is an edit
 in progress: they keep a draft and write on `saveDescription()` / `saveSoul()`. Everything else is
 a choice and writes the moment it is made: a switch that waited for a button would misreport the
 world until the button was pressed.

 ## Switches

 Every capability section is a replace over a whole list (`BotSettingsParams`), so a toggle paints
 first and the section is then written from the state on screen. Toggles made while a write is in
 flight do not start another: they mark the section dirty, and the running write sends the latest
 state when it comes back, so two quick taps are two states in order and never two writes racing.
 A refusal puts the section back to what the gateway last confirmed and says so.

 ## Permissions and support

 The gateway decides what this account may do, and says so only when a write is refused. A refusal
 that reads as an access denial (`BotSettingsFailure.forbidden`) puts the model in `refused`, and
 the screen draws read-only from then on; a gateway without the methods (`unsupported`) leaves the
 model without `details`, and the screen shows only what it keeps itself.

 Every string in here that came from the gateway is untrusted: it is plain text, never Markdown.
 */
@MainActor
@Observable
public final class BotSettingsModel {
  public enum Phase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(BotSettingsFailure)
  }

  /// A thing the screen can be busy writing, or have failed to write.
  public enum Field: Hashable, Sendable {
    case description
    case soul
    case model
    case toolsets
    case skills
    case mcp
    case avatar

    init(_ section: BotCapabilitySection) {
      switch section {
      case .toolsets: self = .toolsets
      case .skills: self = .skills
      case .mcp: self = .mcp
      }
    }
  }

  /// The model inventory, read when the picker is first opened.
  public enum ModelChoices: Equatable, Sendable {
    case idle
    case loading
    case loaded([BotModelChoice])
    /// The gateway would not list models; the picker is not offered.
    case unavailable
  }

  /// A guarded model (an expensive one, or one with a data policy) that wrote nothing until the
  /// person confirms. `message` is the gateway's own words.
  public struct ModelConfirmation: Equatable, Sendable {
    public var choice: BotModelChoice
    public var message: String
  }

  /// Something that happened and is worth one line.
  public enum Notice: Equatable, Sendable {
    case mcpReloaded
  }

  /// The gateway's question about reloading MCP servers into running chats: its own warning.
  public struct ReloadPrompt: Equatable, Sendable {
    public var message: String
  }

  /// The bot's handle: the gateway's profile name, not its display name.
  public let profile: String

  public private(set) var phase = Phase.idle
  /// The gateway's snapshot, with the switches as they are on screen.
  public private(set) var details: BotProfileDetails?
  public var descriptionDraft = ""
  public var soulDraft = ""
  public private(set) var busy: Set<Field> = []
  public private(set) var failures: [Field: BotSettingsFailure] = [:]
  public private(set) var modelChoices = ModelChoices.idle
  public private(set) var modelConfirmation: ModelConfirmation?
  /// Set while the gateway waits to be told whether to reload MCP servers into running chats.
  public private(set) var mcpReloadPrompt: ReloadPrompt?
  public private(set) var notice: Notice?
  /// A write was refused as not this account's to make: the screen is read-only from here on.
  public private(set) var refused = false

  @ObservationIgnored private let gateway: BotSettingsGateway
  @ObservationIgnored private let runtimeSessionID: @MainActor () async -> String?
  @ObservationIgnored private let onChanged: @MainActor () -> Void
  /// What the gateway last confirmed, the state a refused write goes back to.
  @ObservationIgnored private var confirmed: BotProfileDetails?
  @ObservationIgnored private var dirty: Set<BotCapabilitySection> = []
  @ObservationIgnored private var writing: Set<BotCapabilitySection> = []

  /// - Parameters:
  ///   - runtimeSessionID: the bot's live chat, for `reload.mcp`; nil when it has none.
  ///   - onChanged: told after a write the roster shows (description, picture, model), so the
  ///     list re-reads.
  public init(
    gateway: BotSettingsGateway,
    profile: String,
    runtimeSessionID: @escaping @MainActor () async -> String? = { nil },
    onChanged: @escaping @MainActor () -> Void = {}
  ) {
    self.gateway = gateway
    self.profile = profile
    self.runtimeSessionID = runtimeSessionID
    self.onChanged = onChanged
  }

  // MARK: - Reading

  /// Read the profile. A reload keeps a draft the person has started and a write still in flight.
  public func load() async {
    guard phase != .loading else {
      return
    }

    if details == nil {
      phase = .loading
    }

    do {
      let reply = try await gateway.request(RPC.ProfilesDescribe.name, ["name": .string(profile)])

      guard let described = ProfilesDescribeResult(jsonValue: reply) else {
        throw BotSettingsFailure.refused("")
      }

      adopt(BotProfileDetails(described, fallbackName: profile))
      phase = .loaded
    } catch {
      let failure = BotSettingsFailure.classify(error)

      if failure.isForbidden {
        refused = true
      }

      if details == nil {
        phase = .failed(failure)
      }
    }
  }

  private func adopt(_ fresh: BotProfileDetails) {
    let before = confirmed
    confirmed = fresh

    // What is on screen follows the gateway, except where the person is in the middle of
    // something: a section being written keeps its switches, a field being typed its draft.
    var next = fresh

    if !writing.isEmpty, let current = details {
      if writing.contains(.toolsets) { next.toolsets = current.toolsets; next.toolsetsPinned = current.toolsetsPinned }
      if writing.contains(.skills) { next.skills = current.skills }
      if writing.contains(.mcp) { next.mcpServers = current.mcpServers }
    }

    details = next

    // A draft that is still what the gateway last said is not an edit: it follows. One the person
    // has started stays.
    if let before {
      if descriptionDraft.trimmingCharacters(in: .whitespacesAndNewlines) == before.description {
        descriptionDraft = fresh.description
      }

      if soulDraft == before.soul {
        soulDraft = fresh.soul
      }
    } else {
      descriptionDraft = fresh.description
      soulDraft = fresh.soul
    }
  }

  // MARK: - What can be done

  /// Whether a write to the gateway is worth attempting: connected, and not refused.
  public func canWrite(connected: Bool) -> Bool {
    connected && !refused && details != nil
  }

  public var descriptionIsDirty: Bool {
    guard let details else { return false }
    return descriptionDraft.trimmingCharacters(in: .whitespacesAndNewlines) != details.description
  }

  public var soulIsDirty: Bool {
    guard let details else { return false }
    return soulDraft != details.soul
  }

  /// Take the drafts back to what the gateway holds.
  public func revertDescription() {
    descriptionDraft = details?.description ?? ""
    failures[.description] = nil
  }

  public func revertSoul() {
    soulDraft = details?.soul ?? ""
    failures[.soul] = nil
  }

  public func dismissFailure(_ field: Field) {
    failures[field] = nil
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: - Text

  public func saveDescription() async {
    guard details != nil, !busy.contains(.description) else { return }

    let text = descriptionDraft.trimmingCharacters(in: .whitespacesAndNewlines)

    await write(.description, section: "description", params: BotSettingsParams.description(profile, text)) {
      self.details?.description = text
      self.confirmed?.description = text
      self.descriptionDraft = text
      self.onChanged()
    }
  }

  public func saveSoul() async {
    guard details != nil, !busy.contains(.soul) else { return }

    let text = soulDraft

    await write(.soul, section: "soul", params: BotSettingsParams.soul(profile, text)) {
      self.details?.soul = text
      self.confirmed?.soul = text
    }
  }

  /// One `profiles.configure` for one section, with the failure kept under `field`.
  private func write(
    _ field: Field, section: String, params: JSONObject, applied: @MainActor () -> Void
  ) async {
    busy.insert(field)
    failures[field] = nil
    defer { busy.remove(field) }

    do {
      let reply = try await gateway.request(RPC.ProfilesConfigure.name, params)
      try BotSettingsParams.check(reply, applied: section)
      applied()
    } catch {
      fail(field, error)
    }
  }

  private func fail(_ field: Field, _ error: any Error) {
    let failure = BotSettingsFailure.classify(error)
    failures[field] = failure

    if failure.isForbidden {
      refused = true
    }
  }

  // MARK: - Switches

  /// Whether this toolset may be switched off: not the last one that is on (`lastToolset`).
  public func canDisableToolset(_ name: String) -> Bool {
    guard let toolsets = details?.toolsets else { return false }

    return toolsets.contains { $0.enabled && $0.name != name }
  }

  public func setToolset(_ name: String, enabled: Bool) async {
    guard let index = details?.toolsets.firstIndex(where: { $0.name == name }),
      details?.toolsets[index].enabled != enabled
    else { return }

    guard enabled || canDisableToolset(name) else {
      failures[.toolsets] = .lastToolset
      return
    }

    details?.toolsets[index].enabled = enabled
    await commit(.toolsets)
  }

  /// Take the pin away so the bot follows the gateway's toolset defaults again, and show what those
  /// are: they need not be every toolset.
  public func useDefaultToolsets() async {
    guard details?.toolsetsPinned == true, !writing.contains(.toolsets), !busy.contains(.toolsets) else { return }

    busy.insert(.toolsets)
    failures[.toolsets] = nil
    defer { busy.remove(.toolsets) }

    do {
      let reply = try await gateway.request(RPC.ProfilesConfigure.name, BotSettingsParams.toolsetDefaults(profile))
      try BotSettingsParams.check(reply, applied: BotSettingsParams.appliedKey(.toolsets))
      confirmed?.toolsetsPinned = false
      details?.toolsetsPinned = false
      await reread()
    } catch {
      fail(.toolsets, error)
    }
  }

  public func setSkill(_ name: String, enabled: Bool) async {
    guard let index = details?.skills.firstIndex(where: { $0.name == name }),
      details?.skills[index].enabled != enabled
    else { return }

    details?.skills[index].enabled = enabled
    await commit(.skills)
  }

  public func setMcpServer(_ name: String, enabled: Bool) async {
    guard let index = details?.mcpServers.firstIndex(where: { $0.name == name }),
      details?.mcpServers[index].enabled != enabled
    else { return }

    details?.mcpServers[index].enabled = enabled
    await commit(.mcp)
  }

  /// Write a section from the state on screen. See the type's note on how overlapping toggles
  /// coalesce.
  private func commit(_ section: BotCapabilitySection) async {
    let field = Field(section)

    failures[field] = nil
    dirty.insert(section)

    guard !writing.contains(section) else {
      return
    }

    writing.insert(section)
    busy.insert(field)
    defer {
      writing.remove(section)
      busy.remove(field)
    }

    var wrote = false

    while dirty.remove(section) != nil, let snapshot = details {
      do {
        let reply = try await gateway.request(RPC.ProfilesConfigure.name, params(for: section, snapshot))
        try BotSettingsParams.check(reply, applied: BotSettingsParams.appliedKey(section))
        wrote = true
        confirm(section, from: snapshot)
      } catch {
        dirty.remove(section)
        fail(field, error)
        restore(section)
        return
      }
    }

    if wrote, section == .mcp {
      await offerMcpReload()
    }
  }

  private func params(for section: BotCapabilitySection, _ details: BotProfileDetails) -> JSONObject {
    switch section {
    case .toolsets: BotSettingsParams.toolsets(profile, details.toolsets)
    case .skills: BotSettingsParams.skills(profile, details.skills)
    case .mcp: BotSettingsParams.mcp(profile, details.mcpServers)
    }
  }

  private func confirm(_ section: BotCapabilitySection, from snapshot: BotProfileDetails) {
    switch section {
    case .toolsets:
      // A list of names was sent, and any such list is a pin.
      confirmed?.toolsets = snapshot.toolsets
      confirmed?.toolsetsPinned = true

      if details?.toolsets == snapshot.toolsets {
        details?.toolsetsPinned = true
      }
    case .skills:
      confirmed?.skills = snapshot.skills
    case .mcp:
      confirmed?.mcpServers = snapshot.mcpServers
    }
  }

  private func restore(_ section: BotCapabilitySection) {
    guard let confirmed else { return }

    switch section {
    case .toolsets:
      details?.toolsets = confirmed.toolsets
      details?.toolsetsPinned = confirmed.toolsetsPinned
    case .skills:
      details?.skills = confirmed.skills
    case .mcp:
      details?.mcpServers = confirmed.mcpServers
    }
  }

  // MARK: - MCP reload

  /// A changed MCP list does not reach a chat that is already running until the gateway reloads
  /// them, which makes every running chat send its whole input again. So the gateway is asked
  /// without `confirm`, and when it wants an answer the screen puts the question to the person
  /// with the gateway's own warning.
  private func offerMcpReload() async {
    do {
      let sessionID = await runtimeSessionID()
      let reply = try await gateway.request(RPC.ReloadMcp.name, BotSettingsParams.reloadMcp(sessionID: sessionID))

      switch BotSettingsParams.reloadAnswer(reply) {
      case .reloaded: notice = .mcpReloaded
      case .confirmationRequired(let message): mcpReloadPrompt = ReloadPrompt(message: message)
      }
    } catch {
      fail(.mcp, error)
    }
  }

  /// The person answered the gateway's question: reload now, and with `always` stop being asked
  /// (the gateway's own setting, which the CLI and the desktop app share).
  public func reloadMcp(always: Bool) async {
    mcpReloadPrompt = nil
    busy.insert(.mcp)
    defer { busy.remove(.mcp) }

    do {
      let sessionID = await runtimeSessionID()

      _ = try await gateway.request(
        RPC.ReloadMcp.name, BotSettingsParams.reloadMcp(confirm: true, always: always, sessionID: sessionID))
      notice = .mcpReloaded
    } catch {
      fail(.mcp, error)
    }
  }

  public func declineMcpReload() {
    mcpReloadPrompt = nil
  }

  // MARK: - Model

  /// The models the gateway offers this account, read once. A gateway that will not list them
  /// leaves `.unavailable`, and the picker is not drawn.
  public func loadModelChoices() async {
    switch modelChoices {
    case .loading, .loaded: return
    case .idle, .unavailable: break
    }

    modelChoices = .loading

    do {
      let reply = try await gateway.request(RPC.ModelOptions.name, ["explicit_only": .bool(true)])

      guard let options = ModelOptionsResult(jsonValue: reply) else {
        modelChoices = .unavailable
        return
      }

      let choices = BotModelChoice.choices(options)
      modelChoices = choices.isEmpty ? .unavailable : .loaded(choices)
    } catch {
      modelChoices = .unavailable
    }
  }

  /// Pin the bot to a model. A guarded model writes nothing and sets `modelConfirmation`.
  public func chooseModel(_ choice: BotModelChoice) async {
    await pin(choice, confirmExpensive: false)
  }

  /// The person confirmed the guarded model the gateway asked about.
  public func confirmModel() async {
    guard let pending = modelConfirmation else { return }

    await confirmModel(pending)
  }

  /// The same, for a screen that holds the question it showed: an alert closes (and so clears the
  /// question) around the button that answers it, and the answer must not depend on which comes first.
  public func confirmModel(_ pending: ModelConfirmation) async {
    modelConfirmation = nil
    await pin(pending.choice, confirmExpensive: true)
  }

  public func cancelModelConfirmation() {
    modelConfirmation = nil
  }

  private func pin(_ choice: BotModelChoice, confirmExpensive: Bool) async {
    guard details != nil, !busy.contains(.model) else { return }

    busy.insert(.model)
    failures[.model] = nil
    defer { busy.remove(.model) }

    do {
      let reply = try await gateway.request(
        RPC.ProfilesConfigure.name, BotSettingsParams.model(profile, choice, confirmExpensive: confirmExpensive))

      switch try BotSettingsParams.modelAnswer(reply) {
      case .confirmationRequired(let message):
        modelConfirmation = ModelConfirmation(choice: choice, message: message)
      case .applied:
        // What the gateway stored is what to show: it normalises the pair it was given.
        phase = .loaded
        await reread()
        onChanged()
      }
    } catch {
      fail(.model, error)
    }
  }

  /// Read the snapshot again after a write whose result is the gateway's to say.
  private func reread() async {
    do {
      let reply = try await gateway.request(RPC.ProfilesDescribe.name, ["name": .string(profile)])

      if let described = ProfilesDescribeResult(jsonValue: reply) {
        adopt(BotProfileDetails(described, fallbackName: profile))
      }
    } catch {
      // The write landed; a failed re-read leaves the screen as it was until the next load.
    }
  }

  // MARK: - Picture

  /// Store a picture: bare base64, PNG, JPEG or WebP, at most 2 MB (the gateway's own limit).
  public func setAvatar(base64: String) async {
    await writeAvatar(BotSettingsParams.avatar(profile, base64: base64))
  }

  public func clearAvatar() async {
    await writeAvatar(BotSettingsParams.clearAvatar(profile))
  }

  private func writeAvatar(_ params: JSONObject) async {
    guard !busy.contains(.avatar) else { return }

    busy.insert(.avatar)
    failures[.avatar] = nil
    defer { busy.remove(.avatar) }

    do {
      let reply = try await gateway.request(RPC.ProfilesSetAsset.name, params)

      if reply["ok"] == .bool(false) {
        throw BotSettingsFailure.notApplied
      }

      onChanged()
    } catch {
      fail(.avatar, error)
    }
  }
}
