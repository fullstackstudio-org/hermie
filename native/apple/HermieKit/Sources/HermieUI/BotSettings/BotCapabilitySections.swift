import HermieCore
import SwiftUI

// The toolsets, skills and MCP servers of the bot settings. The main screen shows one row for each
// (`BotCapabilitiesSection`, with a one-line summary); a row opens that kind's own page, which holds
// the whole list with all its switches (`BotToolsetsSection`, `BotSkillsSection`, `BotMcpSection`).

// MARK: - The rows on the main screen

/// The three kinds of capability a bot has, each with its own page.
enum BotCapabilityKind: CaseIterable, Hashable {
  case toolsets
  case skills
  case mcp

  /// The model's name for what is written and what failed.
  var field: BotSettingsModel.Field {
    switch self {
    case .toolsets: .toolsets
    case .skills: .skills
    case .mcp: .mcp
    }
  }

  var title: String {
    switch self {
    case .toolsets: NativeStrings.BotSettings.toolsets
    case .skills: NativeStrings.BotSettings.skills
    case .mcp: NativeStrings.BotSettings.mcp
    }
  }

  /// What the kind is, in a sentence, at the top of its page.
  var about: String {
    switch self {
    case .toolsets: NativeStrings.BotSettings.toolsetsAbout
    case .skills: NativeStrings.BotSettings.skillsAbout
    case .mcp: NativeStrings.BotSettings.mcpAbout
    }
  }

  var symbol: String {
    switch self {
    case .toolsets: "wrench.and.screwdriver"
    case .skills: "sparkles"
    case .mcp: "server.rack"
    }
  }

  /// The last part of the accessibility identifiers of the row and its page.
  var key: String {
    switch self {
    case .toolsets: "toolsets"
    case .skills: "skills"
    case .mcp: "mcp"
    }
  }
}

/// What a row says on the right.
enum BotCapabilitySummary: Equatable {
  /// The gateway is being read: a small progress indicator, no value.
  case loading
  /// `needsAttention`: a write to this list failed.
  case value(String, needsAttention: Bool)
}

/// The pure parts of the capability rows and pages: what a row says, when a page has a search field and what it
/// lets through.
enum BotCapabilityLogic {
  /// A list longer than this gets a search field.
  static let searchThreshold = 8

  /// - Parameters:
  ///   - loading: the gateway is being read (`BotSettingsModel.phase` is `idle` or `loading`).
  ///   - failed: a write to this kind's list failed (`BotSettingsModel.failures`).
  static func summary(_ kind: BotCapabilityKind, details: BotProfileDetails?, loading: Bool, failed: Bool)
    -> BotCapabilitySummary
  {
    if loading {
      return .loading
    }

    let counts: (on: Int, total: Int)

    switch kind {
    case .toolsets:
      let list = details?.toolsets ?? []
      counts = (list.filter(\.enabled).count, list.count)
    case .skills:
      let list = details?.skills ?? []
      counts = (list.filter(\.enabled).count, list.count)
    case .mcp:
      let list = details?.mcpServers ?? []
      counts = (list.filter(\.enabled).count, list.count)
    }

    return .value(text(kind, on: counts.on, of: counts.total), needsAttention: failed)
  }

  /// "8 of 14 on", "14 on", "None"; the skills, which are many and mostly all on, say only "23" while none is off.
  static func text(_ kind: BotCapabilityKind, on: Int, of total: Int) -> String {
    if total == 0 {
      return NativeStrings.BotSettings.summaryNone
    }

    if on == total {
      return kind == .skills ? "\(total)" : NativeStrings.BotSettings.summaryOn(total)
    }

    return NativeStrings.BotSettings.summaryOfOn(on, of: total)
  }

  /// Whether a list of this many items gets a search field.
  static func showsSearch(itemCount: Int) -> Bool {
    itemCount > searchThreshold
  }

  /// Whether every word of the search is in one of the fields, in any order.
  static func matches(_ query: String, in fields: [String]) -> Bool {
    let words = query.lowercased().split(separator: " ").map(String.init)

    guard !words.isEmpty else {
      return true
    }

    let haystack = fields.joined(separator: " ").lowercased()

    return words.allSatisfy { haystack.contains($0) }
  }

  static func toolsets(_ toolsets: [BotToolset], matching query: String) -> [BotToolset] {
    toolsets.filter { matches(query, in: [$0.label, $0.name, $0.details]) }
  }

  /// Skills by name, MCP servers by name and transport.
  static func switches(_ switches: [BotSwitch], matching query: String) -> [BotSwitch] {
    switches.filter { matches(query, in: [$0.name, $0.transport]) }
  }

  /// Whether this account may change the gateway's settings of the bot now. The pages ask for themselves, so an
  /// account that is refused, or a connection that is lost, while a page is open is seen on that page.
  @MainActor static func editable(model: BotSettingsModel, session: GatewaySession) -> Bool {
    model.canWrite(connected: session.status.phase == .ready)
  }
}

/// The toolsets, skills and MCP servers as three rows, each opening its own page.
struct BotCapabilitiesSection: View {
  let handle: String
  let session: GatewaySession
  @Bindable var model: BotSettingsModel
  /// Set while the MCP page is on screen (see `McpReloadAlert`).
  @Binding var mcpPageOpen: Bool

  var body: some View {
    Section {
      ForEach(BotCapabilityKind.allCases, id: \.self) { kind in
        NavigationLink {
          page(kind)
        } label: {
          LabeledContent {
            value(kind)
          } label: {
            Label(kind.title, systemImage: kind.symbol)
          }
        }
        .accessibilityIdentifier("hermie.botSettings.\(kind.key)")
      }
    } header: {
      Text(NativeStrings.BotSettings.capabilities)
    }
  }

  @ViewBuilder private func page(_ kind: BotCapabilityKind) -> some View {
    switch kind {
    case .toolsets: BotToolsetsPage(handle: handle, session: session, model: model)
    case .skills: BotSkillsPage(handle: handle, session: session, model: model)
    case .mcp: BotMcpPage(handle: handle, session: session, model: model, open: $mcpPageOpen)
    }
  }

  @ViewBuilder private func value(_ kind: BotCapabilityKind) -> some View {
    let loading: Bool = {
      switch model.phase {
      case .idle, .loading: true
      case .loaded, .failed: false
      }
    }()

    switch BotCapabilityLogic.summary(
      kind, details: model.details, loading: loading, failed: model.failures[kind.field] != nil)
    {
    case .loading:
      ProgressView()
        .controlSize(.small)
    case .value(let text, let needsAttention):
      HStack(spacing: 6) {
        if needsAttention {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
            .accessibilityLabel(NativeStrings.BotSettings.needsAttention)
        }

        Text(verbatim: text)
      }
    }
  }
}

// MARK: - The pages

/// The frame of a capability page: the kind's sentence, then its list, with a search field when the list is long.
struct BotCapabilityPage<Content: View>: View {
  let kind: BotCapabilityKind
  let itemCount: Int
  @Binding var query: String
  @ViewBuilder var content: Content

  var body: some View {
    Form {
      Section {
        Text(verbatim: kind.about)
          .font(.callout)
          .foregroundStyle(.secondary)
      }
      .listRowBackground(Color.clear)

      content
    }
    .formStyle(.grouped)
    .modifier(
      ModelSearch(
        query: $query, prompt: Strings.App.Common.search, identifier: "hermie.botSettings.\(kind.key).search",
        enabled: BotCapabilityLogic.showsSearch(itemCount: itemCount))
    )
    .navigationTitle(kind.title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .accessibilityIdentifier("hermie.botSettings.\(kind.key).page")
  }
}

struct BotToolsetsPage: View {
  let handle: String
  let session: GatewaySession
  @Bindable var model: BotSettingsModel

  @State private var query = ""

  var body: some View {
    BotCapabilityPage(kind: .toolsets, itemCount: model.details?.toolsets.count ?? 0, query: $query) {
      BotToolsetsSection(
        handle: handle, model: model, editable: BotCapabilityLogic.editable(model: model, session: session), query: query)
    }
  }
}

struct BotSkillsPage: View {
  let handle: String
  let session: GatewaySession
  @Bindable var model: BotSettingsModel

  @State private var query = ""

  var body: some View {
    BotCapabilityPage(kind: .skills, itemCount: model.details?.skills.count ?? 0, query: $query) {
      BotSkillsSection(
        handle: handle, model: model, editable: BotCapabilityLogic.editable(model: model, session: session), query: query)
    }
  }
}

struct BotMcpPage: View {
  let handle: String
  let session: GatewaySession
  @Bindable var model: BotSettingsModel
  @Binding var open: Bool

  @State private var query = ""

  var body: some View {
    BotCapabilityPage(kind: .mcp, itemCount: model.details?.mcpServers.count ?? 0, query: $query) {
      BotMcpSection(
        handle: handle, model: model, editable: BotCapabilityLogic.editable(model: model, session: session), query: query)
    }
    .modifier(McpReloadAlert(model: model, active: true))
    .onAppear { open = true }
    .onDisappear { open = false }
  }
}

/// The gateway's question about reloading MCP servers into the running chats, in the app's words. It is asked
/// from the page the switch is on while that page is open, and from the settings screen otherwise (the answer
/// can arrive after the page was left), so there is only ever one alert.
struct McpReloadAlert: ViewModifier {
  @Bindable var model: BotSettingsModel
  let active: Bool

  func body(content: Content) -> some View {
    content.alert(
      Strings.Profiles.Capabilities.Reload.title,
      isPresented: Binding(
        get: { active && model.mcpReloadPrompt != nil },
        set: { if !$0 { model.declineMcpReload() } }
      ),
      presenting: model.mcpReloadPrompt
    ) { _ in
      Button(Strings.Profiles.Capabilities.Reload.now) {
        Task { await model.reloadMcp(always: false) }
      }
      Button(Strings.Profiles.Capabilities.Reload.always) {
        Task { await model.reloadMcp(always: true) }
      }
      Button(Strings.Profiles.Capabilities.Reload.later, role: .cancel) {}
    } message: { _ in
      // In the app's words. The gateway's own warning is written for its command line ("Reply
      // `/reload-mcp now`…") and is not shown.
      Text(verbatim: "\(Strings.Profiles.Capabilities.Reload.body)\n\n\(Strings.Profiles.Capabilities.Reload.alwaysHint)")
    }
  }
}

/// What a page says when a search lets nothing through.
struct BotCapabilityNoMatches: View {
  var body: some View {
    Text(NativeStrings.BotSettings.noMatches)
      .foregroundStyle(.secondary)
  }
}

// MARK: - The lists

/// The toolsets, with what pinning them means said in words.
struct BotToolsetsSection: View {
  let handle: String
  @Bindable var model: BotSettingsModel
  let editable: Bool
  /// What the page's search field says; the list shows what matches.
  var query = ""

  var body: some View {
    let details = model.details
    let toolsets = BotCapabilityLogic.toolsets(details?.toolsets ?? [], matching: query)

    Section {
      if toolsets.isEmpty, !query.isEmpty {
        BotCapabilityNoMatches()
      }

      ForEach(toolsets) { toolset in
        Toggle(isOn: binding(toolset)) {
          VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: toolset.label)
            Text(verbatim: Self.detail(toolset))
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .disabled(
          !editable || model.toolsetsLocked || (toolset.enabled && !model.canDisableToolset(toolset.name)))
        .accessibilityIdentifier("hermie.botSettings.toolset.\(toolset.name)")
      }

      if details?.toolsetsPinned == true, editable {
        Button(NativeStrings.BotSettings.followDefaults) {
          Task { await model.useDefaultToolsets() }
        }
        .disabled(model.toolsetsLocked)
        .accessibilityIdentifier("hermie.botSettings.toolsets.defaults")
      }

      if let failure = model.failures[.toolsets] {
        FailureLine(failure: failure, handle: handle) { model.dismissFailure(.toolsets) }
      }
    } footer: {
      let state =
        details?.toolsetsPinned == true
        ? Strings.Profiles.Capabilities.toolsetsPinned : Strings.Profiles.Capabilities.toolsetsUnpinned

      SettingsNote("\(state) \(NativeStrings.BotSettings.toolsetsScope)")
    }
  }

  private func binding(_ toolset: BotToolset) -> Binding<Bool> {
    Binding(
      get: { toolset.enabled },
      set: { value in Task { await model.setToolset(toolset.name, enabled: value) } }
    )
  }

  static func detail(_ toolset: BotToolset) -> String {
    let count = Strings.Profiles.Capabilities.toolCount(count: toolset.toolCount)

    return toolset.details.isEmpty ? count : "\(toolset.details) · \(count)"
  }
}

/// The skills installed for this bot.
struct BotSkillsSection: View {
  let handle: String
  @Bindable var model: BotSettingsModel
  let editable: Bool
  var query = ""

  var body: some View {
    let all = model.details?.skills ?? []
    let skills = BotCapabilityLogic.switches(all, matching: query)

    Section {
      if all.isEmpty {
        Text(Strings.Profiles.Capabilities.skillsEmpty)
          .foregroundStyle(.secondary)
      } else if skills.isEmpty {
        BotCapabilityNoMatches()
      }

      ForEach(skills) { skill in
        Toggle(
          isOn: Binding(
            get: { skill.enabled },
            set: { value in Task { await model.setSkill(skill.name, enabled: value) } }
          )
        ) {
          Text(verbatim: skill.name)
        }
        .disabled(!editable)
        .accessibilityIdentifier("hermie.botSettings.skill.\(skill.name)")
      }

      if let failure = model.failures[.skills] {
        FailureLine(failure: failure, handle: handle) { model.dismissFailure(.skills) }
      }
    } footer: {
      if model.details?.skillsToolsetOff == true {
        SettingsNote("\(Strings.Profiles.Capabilities.skillsFooter) \(NativeStrings.BotSettings.skillsToolsetOff)")
      } else {
        SettingsNote(Strings.Profiles.Capabilities.skillsFooter)
      }
    }
  }
}

/// The MCP servers, and the one line when a change has been applied to the running chats.
struct BotMcpSection: View {
  let handle: String
  @Bindable var model: BotSettingsModel
  let editable: Bool
  var query = ""

  var body: some View {
    let all = model.details?.mcpServers ?? []
    let servers = BotCapabilityLogic.switches(all, matching: query)

    Section {
      if all.isEmpty {
        Text(Strings.Profiles.Capabilities.mcpEmpty)
          .foregroundStyle(.secondary)
      } else if servers.isEmpty {
        BotCapabilityNoMatches()
      }

      ForEach(servers) { server in
        Toggle(
          isOn: Binding(
            get: { server.enabled },
            set: { value in Task { await model.setMcpServer(server.name, enabled: value) } }
          )
        ) {
          VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: server.name)
            Text(verbatim: server.transport)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .disabled(!editable)
        .accessibilityIdentifier("hermie.botSettings.mcp.\(server.name)")
      }

      if model.notice == .mcpReloaded {
        Label(Strings.Profiles.Capabilities.Reload.done, systemImage: "checkmark.circle")
          .task(id: model.notice) {
            try? await Task.sleep(for: .seconds(4))
            model.dismissNotice()
          }
      }

      if let failure = model.failures[.mcp] {
        FailureLine(failure: failure, handle: handle) { model.dismissFailure(.mcp) }
      }
    } footer: {
      SettingsNote(Strings.Profiles.Capabilities.mcpFooter)
    }
  }
}
