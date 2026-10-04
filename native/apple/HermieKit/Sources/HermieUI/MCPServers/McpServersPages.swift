import HermieCore
import SwiftUI

/**
 Settings → MCP servers: the tools a bot reaches over the Model Context Protocol (`McpScreen` in the
 Expo app). Not Settings → MCP, which is the gateway's own endpoint for other clients.

 The servers of the bot the page is about, each with what the gateway last knew of it; a server's page
 tests the connection (a probe, never run unless asked), walks an OAuth sign-in in the browser where the
 server needs one, writes an API key, and removes it after a confirmation. A server can be added from
 the gateway's catalogue or by hand. Which bots have a server switched on is the bot's own settings,
 which the pages link to. A reload applies configuration changes to chats that are already running, and
 asks first where the gateway asks.

 Every text here is the gateway's or a server author's: plain text, never Markdown. A key or a token is
 typed into a secure field, sent to the gateway and dropped: the page never keeps it.
 */
struct McpServersSettingsEntry: View {
  var body: some View {
    CapabilityHost(identifier: "hermie.mcpServers.page") { session in
      McpServersPage(session: session)
    }
  }
}

struct McpServersPage: View {
  let session: GatewaySession

  @State private var model: McpServersModel
  @State private var bot: String?
  @State private var adding = false

  init(session: GatewaySession) {
    self.session = session

    let first = session.capabilityBots.first?.id

    _bot = State(initialValue: first)
    _model = State(initialValue: session.mcpServers(for: first))
  }

  var body: some View {
    let bots = session.capabilityBots

    Form {
      if !bots.isEmpty {
        Section {
          CapabilityBotPicker(bots: bots, selection: $bot, identifier: "hermie.mcpServers.bot")
        }
      }

      CapabilityNoticeSection(text: McpServersText.notice(model.notice), dismiss: model.dismissNotice)

      serversSection

      Section {
        Button(NativeStrings.McpServersPage.add, systemImage: "plus") { adding = true }
          .accessibilityIdentifier("hermie.mcpServers.add")

        Button(Strings.Mcp.reload, systemImage: "arrow.triangle.2.circlepath") {
          Task { await model.reload() }
        }
        .accessibilityIdentifier("hermie.mcpServers.reload")
      } footer: {
        SettingsNote(Strings.Mcp.reloadHint)
      }
    }
    .formStyle(.grouped)
    .navigationTitle(Strings.Mcp.title)
    .task(id: ObjectIdentifier(model)) { await model.load() }
    .onChange(of: bot) { _, now in
      Task { await model.setProfile(now) }
    }
    .refreshable { await model.load() }
    .sheet(isPresented: $adding) {
      McpAddSheet(model: model)
    }
    .confirmationDialog(
      Strings.Profiles.Capabilities.Reload.title,
      isPresented: Binding(
        get: { model.reloadPrompt != nil },
        set: { if !$0 { model.declineReload() } }
      ),
      titleVisibility: .visible,
      presenting: model.reloadPrompt
    ) { _ in
      Button(Strings.Profiles.Capabilities.Reload.now) {
        Task { await model.confirmReload(always: false) }
      }
      Button(Strings.Profiles.Capabilities.Reload.always) {
        Task { await model.confirmReload(always: true) }
      }
      Button(Strings.Profiles.Capabilities.Reload.later, role: .cancel) {}
    } message: { _ in
      // The gateway's own wording of the warning is a slash command's reply ("Reply `/reload-mcp now`…")
      // and is not shown.
      Text(verbatim: "\(Strings.Profiles.Capabilities.Reload.body)\n\n\(Strings.Profiles.Capabilities.Reload.alwaysHint)")
    }
    .accessibilityIdentifier("hermie.mcpServers.page")
  }

  @ViewBuilder private var serversSection: some View {
    Section {
      switch model.phase {
      case .loading:
        CapabilityLoadingRow(text: Strings.Mcp.loading)
      case .failed(let words):
        CapabilityFailureRow(text: Strings.Mcp.failed(reason: words)) { Task { await model.load() } }
      case .ready:
        if model.servers.isEmpty {
          Text(Strings.Mcp.empty)
            .foregroundStyle(Color.primary)
            .accessibilityIdentifier("hermie.mcpServers.empty")
        }

        ForEach(model.servers) { server in
          NavigationLink {
            McpServerPage(session: session, model: model, name: server.name, bot: bot)
          } label: {
            McpServerRowView(server: server, probe: model.probes[server.name])
          }
          .accessibilityIdentifier("hermie.mcpServers.server.\(server.name)")
        }
      }
    } footer: {
      SettingsNote(Strings.Mcp.subtitle)
    }
  }
}

/// One server in the list: its name, what it is, and what the gateway last knew of it.
struct McpServerRowView: View {
  let server: McpServerRow
  let probe: McpServersModel.ProbeState?

  var body: some View {
    let status = McpServersText.status(of: server, probe: probe)

    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: server.name)
      Text(verbatim: "\(server.transport) · \(status)")
        .font(.footnote)
        .foregroundStyle(Color.primary)
      if !server.address.isEmpty {
        Text(verbatim: server.address)
          .font(.footnote.monospaced())
          .foregroundStyle(Color.primary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(server.name)
    .accessibilityValue("\(server.transport), \(status)")
  }
}

/// One server: what it is, the connection test, the sign-in, an API key and removing it.
struct McpServerPage: View {
  let session: GatewaySession
  let model: McpServersModel
  let name: String
  let bot: String?

  @Environment(\.openURL) private var openURL
  @Environment(\.dismiss) private var dismiss
  @Environment(LiveGateway.self) private var live: LiveGateway?
  @State private var walk: Task<Void, Never>?
  @State private var settingKey = false
  @State private var removing = false

  var body: some View {
    Group {
      if let server = model.server(named: name) {
        content(server)
      } else {
        // Removed from under the page: there is nothing left to show.
        Form {
          Section { CapabilityStatusRow(text: Strings.Mcp.empty, symbol: "tray") }
        }
        .formStyle(.grouped)
      }
    }
    .navigationTitle(name)
    .onDisappear { walk?.cancel() }
    .accessibilityIdentifier("hermie.mcpServers.detail")
  }

  private func content(_ server: McpServerRow) -> some View {
    let probe = model.probes[name]

    return Form {
      CapabilityNoticeSection(text: McpServersText.notice(model.notice), dismiss: model.dismissNotice)

      Section {
        LabeledContent(Strings.Mcp.Detail.transport) { Text(verbatim: server.transport) }

        if !server.address.isEmpty {
          LabeledContent(Strings.Mcp.Detail.address) {
            Text(verbatim: server.address)
              .font(.callout.monospaced())
              .textSelection(.enabled)
          }
        }

        LabeledContent(Strings.Mcp.Detail.auth) {
          Text(verbatim: server.auth ?? Strings.Mcp.Detail.authNone)
        }

        LabeledContent(Strings.Mcp.Detail.title) {
          Text(verbatim: McpServersText.status(of: server, probe: probe))
        }
      }

      testSection(server, probe: probe)
      toolsSection(server, probe: probe)

      if !server.env.isEmpty {
        Section {
          ForEach(server.env, id: \.self) { key in
            Text(verbatim: key)
              .font(.callout.monospaced())
          }
        } header: {
          SettingsNote(Strings.Mcp.Detail.env)
        } footer: {
          SettingsNote(Strings.Mcp.Detail.envHint)
        }
      }

      Section {
        Button(NativeStrings.McpServersPage.setKey, systemImage: "key") { settingKey = true }
          .disabled(model.busy.contains(name))
          .accessibilityIdentifier("hermie.mcpServers.setKey")

        botSettingsLink
      }

      Section {
        Button(Strings.App.Common.remove, systemImage: "trash", role: .destructive) { removing = true }
          .disabled(model.busy.contains(name))
          .accessibilityIdentifier("hermie.mcpServers.remove")
      }
    }
    .formStyle(.grouped)
    .sheet(isPresented: $settingKey) {
      McpKeySheet(model: model, server: server)
    }
    .confirmationDialog(
      NativeStrings.McpServersPage.removeTitle(name: name), isPresented: $removing, titleVisibility: .visible
    ) {
      Button(Strings.App.Common.remove, role: .destructive) {
        Task {
          if await model.remove(name) {
            dismiss()
          }
        }
      }
      .accessibilityIdentifier("hermie.mcpServers.remove.confirm")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: {
      Text(NativeStrings.McpServersPage.removeMessage)
    }
  }

  // MARK: Testing and authorising

  @ViewBuilder private func testSection(_ server: McpServerRow, probe: McpServersModel.ProbeState?) -> some View {
    Section {
      Button(Strings.Mcp.test, systemImage: "bolt.horizontal") {
        Task { await model.test(name) }
      }
      .disabled(probe == .testing || model.authorising != nil)
      .accessibilityIdentifier("hermie.mcpServers.test")

      switch probe {
      case .testing:
        CapabilityLoadingRow(text: Strings.Mcp.testing)
      case .failed(let words):
        CapabilityStatusRow(text: Strings.Mcp.testFailed(reason: words), symbol: "exclamationmark.triangle")
      case .done(let result):
        if result.ok {
          CapabilityStatusRow(
            text: Strings.Mcp.testOk(count: result.tools.count), symbol: "checkmark.circle",
            identifier: "hermie.mcpServers.probe")
        } else if result.needsAuth {
          CapabilityStatusRow(
            text: Strings.Mcp.needsAuth, symbol: "person.badge.key", identifier: "hermie.mcpServers.probe")
        } else {
          CapabilityStatusRow(
            text: Strings.Mcp.testFailed(reason: result.error ?? ""), symbol: "exclamationmark.triangle",
            identifier: "hermie.mcpServers.probe")
        }
      case nil:
        EmptyView()
      }

      if showsAuthorise(server, probe: probe) {
        if model.authorising == name {
          CapabilityLoadingRow(text: Strings.Mcp.authorising)
        } else {
          Button(Strings.Mcp.authorise, systemImage: "person.badge.key") { authorise() }
            .disabled(model.authorising != nil)
            .accessibilityIdentifier("hermie.mcpServers.authorise")
        }
      }
    } footer: {
      if showsAuthorise(server, probe: probe) {
        SettingsNote(Strings.Mcp.authoriseHint)
      }
    }
  }

  /// OAuth applies to an http server that says it uses it, or that a probe found needs it.
  private func showsAuthorise(_ server: McpServerRow, probe: McpServersModel.ProbeState?) -> Bool {
    guard server.isHTTP else {
      return false
    }

    if server.auth == "oauth" {
      return true
    }

    if case .done(let result) = probe {
      return result.needsAuth
    }

    return false
  }

  private func authorise() {
    walk?.cancel()
    walk = Task {
      await model.authorise(name) { url in
        openURL(url)

        return true
      }
    }
  }

  @ViewBuilder private func toolsSection(_ server: McpServerRow, probe: McpServersModel.ProbeState?) -> some View {
    Section {
      if case .done(let result) = probe, result.ok {
        if result.tools.isEmpty {
          Text(Strings.Mcp.Detail.toolsEmpty)
            .foregroundStyle(Color.primary)
        }

        ForEach(result.tools) { tool in
          VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: tool.name)
              .font(.callout.monospaced())
            if !tool.description.isEmpty {
              Text(verbatim: tool.description)
                .font(.footnote)
                .foregroundStyle(Color.primary)
            }
          }
          .accessibilityElement(children: .combine)
        }
      } else {
        Text(
          server.toolCount > 0 ? Strings.Mcp.toolCount(count: server.toolCount) : Strings.Mcp.Detail.toolsUnknown
        )
        .foregroundStyle(Color.primary)
      }
    } header: {
      SettingsNote(Strings.Mcp.Detail.tools)
    }
  }

  /// Which bots have a server switched on is the bot's own settings.
  @ViewBuilder private var botSettingsLink: some View {
    if let bot, let gateway = live?.gatewayID {
      NavigationLink {
        BotSettingsScreen(chat: ChatRef(gatewayId: gateway, bot: bot))
      } label: {
        Text(NativeStrings.McpServersPage.openBotSettings(name: session.chatName(bot)))
      }
      .accessibilityIdentifier("hermie.mcpServers.botSettings")
    }
  }
}

/// Write an API key for a server. It is typed into a secure field, sent to the gateway and dropped.
struct McpKeySheet: View {
  let model: McpServersModel
  let server: McpServerRow

  @Environment(\.dismiss) private var dismiss
  @State private var value = ""
  @State private var variable: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          SecureField(NativeStrings.McpServersPage.keyField, text: $value)
            .textContentType(.password)
            .autocorrectionDisabled()
            #if os(iOS)
              .textInputAutocapitalization(.never)
            #endif
            .accessibilityIdentifier("hermie.mcpServers.key.field")

          if !server.isHTTP, server.env.count > 1 {
            Picker(NativeStrings.McpServersPage.keyVariable, selection: $variable) {
              ForEach(server.env, id: \.self) { key in
                Text(verbatim: key).tag(Optional(key))
              }
            }
          }
        } footer: {
          SettingsNote(NativeStrings.McpServersPage.keyHint)
        }
      }
      .formStyle(.grouped)
      .navigationTitle(NativeStrings.McpServersPage.keyTitle)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.cancel) { dismiss() }
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(NativeStrings.Capability.save) {
            let secret = value

            value = ""
            Task {
              _ = await model.setAPIKey(server.name, value: secret, envVar: variable ?? server.env.first)
            }
            dismiss()
          }
          .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("hermie.mcpServers.key.save")
        }
      }
      .onAppear { variable = server.isHTTP ? nil : server.env.first }
    }
    #if os(macOS)
      .frame(minWidth: 420, minHeight: 240)
    #endif
  }
}

/// Add a server: from the gateway's catalogue, or one the person describes.
struct McpAddSheet: View {
  let model: McpServersModel

  @Environment(\.dismiss) private var dismiss
  @State private var draft = McpServerDraft()
  @State private var showsProblems = false

  var body: some View {
    NavigationStack {
      Form {
        if let error = model.addError {
          Section { CapabilityStatusRow(text: error, symbol: "exclamationmark.triangle", identifier: "hermie.mcpServers.add.error") }
        }

        catalogueSection
        customSection
      }
      .formStyle(.grouped)
      .navigationTitle(NativeStrings.McpServersPage.addTitle)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.done) { dismiss() }
            .accessibilityIdentifier("hermie.mcpServers.add.done")
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(Strings.App.Common.add) {
            showsProblems = true

            Task {
              if await model.add(draft) {
                dismiss()
              }
            }
          }
          .disabled(model.adding)
          .accessibilityIdentifier("hermie.mcpServers.add.save")
        }
      }
      .task {
        model.beginAdding()
        await model.loadCatalog()
      }
    }
    #if os(macOS)
      .frame(minWidth: 460, minHeight: 520)
    #endif
  }

  @ViewBuilder private var catalogueSection: some View {
    Section {
      switch model.catalog {
      case .idle, .loading:
        CapabilityLoadingRow(text: Strings.Mcp.loading)
      case .failed(let words):
        CapabilityStatusRow(text: Strings.Mcp.failed(reason: words), symbol: "exclamationmark.triangle")
      case .loaded(let entries):
        ForEach(entries) { entry in
          HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
              Text(verbatim: entry.name)
              if !entry.description.isEmpty {
                Text(verbatim: entry.description)
                  .font(.footnote)
                  .foregroundStyle(Color.primary)
              }
              if !entry.requires.isEmpty {
                Text(NativeStrings.McpServersPage.needs(keys: entry.requires.joined(separator: ", ")))
                  .font(.footnote.monospaced())
                  .foregroundStyle(Color.primary)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)

            if entry.installed {
              Text(Strings.Skills.alreadyInstalled)
                .font(.footnote)
                .foregroundStyle(Color.primary)
            } else {
              Button(Strings.App.Common.add) {
                Task {
                  if await model.addPreset(entry) {
                    dismiss()
                  }
                }
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
              .disabled(model.adding)
              .accessibilityLabel("\(Strings.App.Common.add) \(entry.name)")
              .accessibilityIdentifier("hermie.mcpServers.add.preset.\(entry.name)")
            }
          }
        }
      }
    } header: {
      SettingsNote(NativeStrings.McpServersPage.catalogueHeader)
    }
  }

  private var customSection: some View {
    Section {
      Picker(NativeStrings.McpServersPage.kind, selection: $draft.kind) {
        Text(NativeStrings.McpServersPage.kindHTTP).tag(McpServerDraft.Kind.http)
        Text(NativeStrings.McpServersPage.kindStdio).tag(McpServerDraft.Kind.stdio)
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("hermie.mcpServers.add.kind")

      TextField(NativeStrings.McpServersPage.name, text: $draft.name)
        .autocorrectionDisabled()
        #if os(iOS)
          .textInputAutocapitalization(.never)
        #endif
        .accessibilityIdentifier("hermie.mcpServers.add.name")
      problem(.nameMissing, .nameHasSpaces)

      switch draft.kind {
      case .http:
        TextField(NativeStrings.McpServersPage.url, text: $draft.url)
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
          #endif
          .accessibilityIdentifier("hermie.mcpServers.add.url")
        problem(.urlInvalid)

        SecureField(NativeStrings.McpServersPage.bearer, text: $draft.bearerToken)
          .autocorrectionDisabled()
          .accessibilityIdentifier("hermie.mcpServers.add.bearer")
      case .stdio:
        TextField(NativeStrings.McpServersPage.command, text: $draft.command)
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
          .accessibilityIdentifier("hermie.mcpServers.add.command")
        problem(.commandMissing)

        TextField(NativeStrings.McpServersPage.arguments, text: $draft.arguments)
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
          .accessibilityIdentifier("hermie.mcpServers.add.arguments")
      }
    } header: {
      SettingsNote(NativeStrings.McpServersPage.customHeader)
    } footer: {
      SettingsNote(draft.kind == .http ? NativeStrings.McpServersPage.bearerHint : NativeStrings.McpServersPage.argumentsHint)
    }
  }

  /// What is wrong with a field, once the person has tried to add.
  @ViewBuilder private func problem(_ these: McpServerDraft.Problem...) -> some View {
    if showsProblems, let found = draft.problems.first(where: { these.contains($0) }) {
      Text(McpServersText.problem(found))
        .font(.footnote)
        .foregroundStyle(Color.primary)
        .accessibilityIdentifier("hermie.mcpServers.add.problem")
    }
  }
}

/// The words of the MCP servers page, from the model's cases.
enum McpServersText {
  /// What the gateway last knew of a server, and what a probe found since, as one phrase.
  static func status(of server: McpServerRow, probe: McpServersModel.ProbeState?) -> String {
    if case .done(let result) = probe {
      if result.ok {
        return Strings.Mcp.testOk(count: result.tools.count)
      }

      if result.needsAuth {
        return Strings.Mcp.needsAuth
      }
    }

    if !server.enabled {
      return Strings.Mcp.Runtime.disabled
    }

    switch server.runtime {
    case .connected: return Strings.Mcp.Runtime.connected
    case .disabled: return Strings.Mcp.Runtime.disabled
    case .connecting: return Strings.Mcp.Runtime.connecting
    case .failed: return Strings.Mcp.Runtime.failed
    case .lazy: return Strings.Mcp.Runtime.lazy
    case .configured: return Strings.Mcp.Runtime.configured
    case .unknown: return Strings.Mcp.Runtime.unknown
    }
  }

  static func notice(_ notice: McpServersModel.Notice?) -> String? {
    switch notice {
    case .authorised: Strings.Mcp.authoriseOk
    case .authoriseFailed(let words): Strings.Mcp.authoriseFailed(reason: words)
    case .added(let name): NativeStrings.McpServersPage.added(name: bounded(name))
    case .removed(let name): NativeStrings.McpServersPage.removed(name: bounded(name))
    case .keySaved(let name): NativeStrings.McpServersPage.keySaved(name: bounded(name))
    case .reloaded: Strings.Profiles.Capabilities.Reload.done
    case .linkRefused: NativeStrings.McpServersPage.linkRefused
    case .failure(let words): Strings.Mcp.failed(reason: words)
    case nil: nil
    }
  }

  static func problem(_ problem: McpServerDraft.Problem) -> String {
    switch problem {
    case .nameMissing: NativeStrings.McpServersPage.nameMissing
    case .nameHasSpaces: NativeStrings.McpServersPage.nameHasSpaces
    case .urlInvalid: NativeStrings.McpServersPage.urlInvalid
    case .commandMissing: NativeStrings.McpServersPage.commandMissing
    }
  }

  private static func bounded(_ name: String) -> String {
    SecurePrompt.displayText(name, limit: SecurePrompt.nameLimit)
  }
}
