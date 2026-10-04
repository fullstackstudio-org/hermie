import HermieCore
import SwiftUI

/**
 Settings → Skills: what a bot can do from instructions it opens when it needs them (`SkillsScreen` in
 the Expo app).

 The installed skills of the bot the page is about, each with whether the bot has it on, and the hub
 the gateway offers: browsed a page at a time, searched, a skill's details one tap away, and Install
 for the bot. The switches themselves are the bot's own settings, which the page links to; the
 gateway has no way to remove a skill over its socket, so a skill's menu copies the command that does
 it on the machine that hosts the gateway.

 Every text here is the gateway's or a skill author's: plain text, never Markdown.
 */
struct SkillsSettingsEntry: View {
  var body: some View {
    CapabilityHost(identifier: "hermie.skills.page") { session in
      SkillsPage(session: session)
    }
  }
}

struct SkillsPage: View {
  let session: GatewaySession

  @Environment(LiveGateway.self) private var live: LiveGateway?
  @State private var model: SkillsModel
  @State private var bot: String?
  @State private var text = ""
  @State private var detailed: HubSkill?

  init(session: GatewaySession) {
    self.session = session

    let first = session.capabilityBots.first?.id

    _bot = State(initialValue: first)
    _model = State(initialValue: session.skills(for: first))
  }

  var body: some View {
    let bots = session.capabilityBots

    Form {
      if !bots.isEmpty {
        Section {
          CapabilityBotPicker(bots: bots, selection: $bot, identifier: "hermie.skills.bot")
        } footer: {
          if bots.count > 1, let name = bots.first(where: { $0.id == bot })?.name {
            SettingsNote(Strings.Skills.forBot(name: name))
          }
        }
      }

      CapabilityNoticeSection(text: noticeText(model.notice), dismiss: model.dismissNotice)

      installedSection(bots: bots)
      catalogueSection
    }
    .formStyle(.grouped)
    .searchable(text: $text, prompt: Strings.Skills.searchPlaceholder)
    .task(id: ObjectIdentifier(model)) { await model.load() }
    .task(id: text) {
      // A burst of typing is one search: the last keystroke's, after a short pause. The first run, with
      // nothing typed, browses the hub's first page.
      if !text.isEmpty {
        try? await Task.sleep(for: .milliseconds(300))
      }

      if !Task.isCancelled {
        await model.searchHub(text)
      }
    }
    .onChange(of: bot) { _, now in
      Task { await model.setProfile(now) }
    }
    .refreshable {
      await model.load()
      await model.searchHub(text)
    }
    .sheet(item: $detailed) { skill in
      SkillDetailSheet(model: model, skill: skill)
    }
    .navigationTitle(Strings.Skills.title)
    .accessibilityIdentifier("hermie.skills.page")
  }

  private func noticeText(_ notice: SkillsModel.Notice?) -> String? {
    switch notice {
    case .installed(let name): Strings.Skills.installed_(name: SecurePrompt.displayText(name, limit: SecurePrompt.nameLimit))
    case .installFailed(let words): Strings.Skills.installFailed(reason: words)
    case .installCommand(let command): Strings.Skills.cliOnly + " " + command
    case .failed(let words): Strings.Skills.failed(reason: words)
    case nil: nil
    }
  }

  // MARK: Installed

  @ViewBuilder private func installedSection(bots: [CapabilityBot]) -> some View {
    Section {
      switch model.phase {
      case .loading:
        CapabilityLoadingRow(text: Strings.Skills.loading)
      case .failed(let words):
        CapabilityFailureRow(text: Strings.Skills.failed(reason: words)) { Task { await model.load() } }
      case .ready:
        if model.installed.isEmpty {
          Text(Strings.Skills.installedEmpty)
            .foregroundStyle(Color.primary)
            .accessibilityIdentifier("hermie.skills.installed.empty")
        }

        ForEach(model.installed) { skill in
          installedRow(skill)
        }

        botSettingsLink(bots: bots)
      }
    } header: {
      SettingsNote(Strings.Skills.installed)
    } footer: {
      SettingsNote(Strings.Skills.installedFooter + " " + NativeStrings.SkillsPage.removeFooter)
    }
  }

  private func installedRow(_ skill: InstalledSkill) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: skill.name)
        Text(verbatim: skill.category)
          .font(.footnote)
          .foregroundStyle(Color.primary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if let enabled = skill.enabled {
        Text(enabled ? NativeStrings.SkillsPage.on : NativeStrings.SkillsPage.off)
          .font(.footnote)
          .foregroundStyle(Color.primary)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(skill.name)
    .accessibilityValue(skill.enabled.map { $0 ? NativeStrings.SkillsPage.on : NativeStrings.SkillsPage.off } ?? "")
    .contextMenu {
      Button(NativeStrings.SkillsPage.copyRemoveCommand, systemImage: "doc.on.doc") {
        MCPBoard.copy(SkillsService.uninstallCommand(skill.name, profile: model.profile))
      }
    }
    .accessibilityAction(named: NativeStrings.SkillsPage.copyRemoveCommand) {
      MCPBoard.copy(SkillsService.uninstallCommand(skill.name, profile: model.profile))
    }
    .accessibilityIdentifier("hermie.skills.installed.\(skill.name)")
  }

  /// The switches are the bot's own settings: one tap away.
  @ViewBuilder private func botSettingsLink(bots: [CapabilityBot]) -> some View {
    if let bot, let name = bots.first(where: { $0.id == bot })?.name, let gateway = live?.gatewayID {
      NavigationLink {
        BotSettingsScreen(chat: ChatRef(gatewayId: gateway, bot: bot))
      } label: {
        Text(NativeStrings.SkillsPage.openBotSettings(name: name))
      }
      .accessibilityIdentifier("hermie.skills.botSettings")
    }
  }

  // MARK: Catalogue

  private var catalogueSection: some View {
    Section {
      switch model.hubPhase {
      case .failed(let words):
        CapabilityFailureRow(text: Strings.Skills.failed(reason: words)) { Task { await model.searchHub(text) } }
      case .idle, .loading, .ready:
        if model.hubPhase != .ready, model.hub.isEmpty {
          CapabilityLoadingRow(text: model.query.isEmpty ? Strings.Skills.loading : Strings.Skills.searching)
        } else {
          if model.hub.isEmpty {
            Text(Strings.Skills.catalogueEmpty)
              .foregroundStyle(Color.primary)
              .accessibilityIdentifier("hermie.skills.catalogue.empty")
          }

          ForEach(model.hub) { skill in
            hubRow(skill)
          }

          if model.canLoadMore {
            Button(NativeStrings.SkillsPage.more) { Task { await model.loadMore() } }
              .accessibilityIdentifier("hermie.skills.more")
          }
        }
      }
    } header: {
      SettingsNote(Strings.Skills.catalogue)
    }
  }

  private func hubRow(_ skill: HubSkill) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Button {
        detailed = skill
      } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: skill.name)
            .foregroundStyle(Color.primary)
          if !skill.description.isEmpty {
            Text(verbatim: skill.description)
              .font(.footnote)
              .foregroundStyle(Color.primary)
              .lineLimit(3)
          }
          if let source = skill.source {
            Text(verbatim: source)
              .font(.footnote)
              .foregroundStyle(Color.primary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(skill.name)
      .accessibilityHint(skill.description)

      SkillInstallControl(model: model, skill: skill)
    }
    .accessibilityIdentifier("hermie.skills.hub.\(skill.id)")
  }
}

/// The Install button of one hub skill: what it does now (not installed, installing, installed).
struct SkillInstallControl: View {
  let model: SkillsModel
  let skill: HubSkill

  var body: some View {
    if model.isInstalled(skill) {
      Text(Strings.Skills.alreadyInstalled)
        .font(.footnote)
        .foregroundStyle(Color.primary)
    } else if model.installing.contains(skill.id) {
      HStack(spacing: 6) {
        ProgressView()
        Text(Strings.Skills.installing)
          .font(.footnote)
      }
      .accessibilityElement(children: .combine)
    } else {
      Button(Strings.Skills.install) {
        Task { await model.install(skill) }
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .accessibilityLabel("\(Strings.Skills.install) \(skill.name)")
      .accessibilityIdentifier("hermie.skills.install.\(skill.id)")
    }
  }
}

/// What the hub says about one skill, with the way to install it.
struct SkillDetailSheet: View {
  let model: SkillsModel
  let skill: HubSkill

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(verbatim: skill.description.isEmpty ? skill.name : skill.description)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)

          if let source = skill.source {
            LabeledContent(NativeStrings.SkillsPage.source) { Text(verbatim: source) }
          }

          if let trust = skill.trust {
            LabeledContent(NativeStrings.SkillsPage.trust) { Text(verbatim: trust) }
          }

          HStack {
            Spacer()
            SkillInstallControl(model: model, skill: skill)
          }
        }

        inspection
      }
      .formStyle(.grouped)
      .navigationTitle(skill.name)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(Strings.App.Common.done) { dismiss() }
            .accessibilityIdentifier("hermie.skills.detail.done")
        }
      }
      .task { await model.inspect(skill) }
    }
    #if os(macOS)
      .frame(minWidth: 460, minHeight: 360)
    #endif
    .accessibilityIdentifier("hermie.skills.detail")
  }

  @ViewBuilder private var inspection: some View {
    switch model.inspected[skill.id] {
    case nil, .loading:
      Section { CapabilityLoadingRow(text: NativeStrings.SkillsPage.detailsLoading) }
    case .unknown:
      Section { CapabilityStatusRow(text: NativeStrings.SkillsPage.detailsUnknown, symbol: "questionmark.circle") }
    case .failed(let words):
      Section { CapabilityStatusRow(text: words, symbol: "exclamationmark.triangle") }
    case .loaded(let info):
      if !info.tags.isEmpty {
        Section {
          Text(verbatim: info.tags.joined(separator: ", "))
        } header: {
          SettingsNote(NativeStrings.SkillsPage.tags)
        }
      }

      if !info.preview.isEmpty {
        Section {
          Text(verbatim: info.preview)
            .font(.callout.monospaced())
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        } header: {
          SettingsNote(NativeStrings.SkillsPage.preview)
        }
      }
    }
  }
}
