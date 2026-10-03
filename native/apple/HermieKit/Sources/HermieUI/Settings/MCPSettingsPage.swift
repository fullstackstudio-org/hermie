import HermieCore
import HermieGateway
import HermieProtocol
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// What the page has just put on the pasteboard, so its button can say so for a moment.
enum MCPCopyTarget: Equatable {
  case endpoint
  case command
  case config
}

/**
 Settings → MCP: the gateway's MCP endpoint, as the gateway describes it (plan `gateway-mcp.md` N1,
 contract `contract/gateway/mcp.md`). Whether MCP is on, the endpoint, the command and the
 configuration to copy, the gateway's own instructions, and the clients the person has allowed
 (name, when it was allowed, when it was last used, from which address) with a way to revoke each
 after a confirmation. It reloads when it opens, when the app comes back to the foreground and when
 the gateway says something changed (`mcp.changed`).

 Hermie never speaks MCP and runs no server, and the page makes no request but the gateway's. Every
 string the gateway sent is plain text (`Text(verbatim:)`): the command and the configuration are
 shown with their whitespace and invisible characters made visible (`ConfirmDetailMarkup`) and are
 copied exactly as received. Nothing here runs the command.
 */
struct MCPSettingsPage: View {
  let model: MCPSettingsModel
  let gatewayName: String

  @Environment(\.scenePhase) private var scenePhase
  @State private var confirming: MCPGrant?
  @State private var copied: MCPCopyTarget?

  var body: some View {
    let state = MCPPageState.of(model)

    Form {
      noticeSection
      stateSection(state)

      if state.showsSettings, let settings = model.settings {
        endpointSection(settings)
        commandSection(settings)
        configSection(settings)
        clientsSection(settings)
        instructionsSection(settings)
      }

      failureSection
    }
    .formStyle(.grouped)
    .navigationTitle(NativeStrings.MCP.title)
    .accessibilityIdentifier("hermie.mcp.page")
    .task(id: ObjectIdentifier(model)) { await model.refresh() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        Task { await model.refresh() }
      }
    }
    .confirmationDialog(
      NativeStrings.MCP.Grant.revokeTitle,
      isPresented: confirmationPresented,
      titleVisibility: .visible,
      presenting: confirming
    ) { grant in
      Button(NativeStrings.MCP.Grant.revoke, role: .destructive) {
        revoke(grant)
      }
      .accessibilityIdentifier("hermie.mcp.revoke.confirm")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: { grant in
      Text(verbatim: NativeStrings.MCP.Grant.revokeMessage(MCPText.lines(for: grant).name))
    }
  }

  // MARK: Sections

  @ViewBuilder private var noticeSection: some View {
    if let notice = model.notice {
      Section {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Label {
            Text(verbatim: MCPText.notice(notice))
              .foregroundStyle(Color.primary)
              .fixedSize(horizontal: false, vertical: true)
          } icon: {
            Image(systemName: "bell")
              .foregroundStyle(Color.primary)
              .accessibilityHidden(true)
          }
          .frame(maxWidth: .infinity, alignment: .leading)

          Button(NativeStrings.MCP.dismiss, systemImage: "xmark") {
            model.dismissNotice()
          }
          .labelStyle(.iconOnly)
          .buttonStyle(.borderless)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
          .accessibilityIdentifier("hermie.mcp.notice.dismiss")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hermie.mcp.notice")
      }
    }
  }

  private func stateSection(_ state: MCPPageState) -> some View {
    let words = MCPText.state(state)

    return Section {
      Label {
        Text(verbatim: words.text)
          .foregroundStyle(Color.primary)
          .fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: words.symbol)
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("hermie.mcp.state")

      if state == .unreadable || state == .stale {
        Button(NativeStrings.MCP.retry) {
          Task { await model.refresh() }
        }
        .accessibilityIdentifier("hermie.mcp.retry")
      }
    } header: {
      SettingsNote(NativeStrings.MCP.stateHeader(gatewayName))
    }
  }

  private func endpointSection(_ settings: MCPSettings) -> some View {
    Section {
      CopyBlock(
        text: settings.endpointURL ?? "",
        copyTitle: NativeStrings.MCP.Endpoint.copy,
        copied: copied == .endpoint,
        identifier: "hermie.mcp.endpoint"
      ) {
        copy(settings.endpointURL ?? "", .endpoint)
      }
    } header: {
      SettingsNote(NativeStrings.MCP.Endpoint.header)
    }
  }

  private func commandSection(_ settings: MCPSettings) -> some View {
    Section {
      CopyBlock(
        text: settings.claudeCommand ?? "",
        copyTitle: NativeStrings.MCP.Command.copy,
        copied: copied == .command,
        identifier: "hermie.mcp.command"
      ) {
        copy(settings.claudeCommand ?? "", .command)
      }
    } header: {
      SettingsNote(NativeStrings.MCP.Command.header)
    } footer: {
      SettingsNote(NativeStrings.MCP.Command.footer)
    }
  }

  private func configSection(_ settings: MCPSettings) -> some View {
    Section {
      CopyBlock(
        text: settings.configJSON ?? "",
        copyTitle: NativeStrings.MCP.Config.copy,
        copied: copied == .config,
        identifier: "hermie.mcp.config"
      ) {
        copy(settings.configJSON ?? "", .config)
      }
    } header: {
      SettingsNote(NativeStrings.MCP.Config.header)
    } footer: {
      SettingsNote(NativeStrings.MCP.Config.footer)
    }
  }

  private func clientsSection(_ settings: MCPSettings) -> some View {
    let grants = settings.grants ?? []

    return Section {
      if grants.isEmpty {
        Text(verbatim: NativeStrings.MCP.Clients.empty)
          .foregroundStyle(Color.primary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("hermie.mcp.clients.empty")
      }

      ForEach(grants) { grant in
        MCPGrantRow(grant: grant, busy: model.revoking.contains(grant.id)) {
          confirming = grant
        }
      }
    } header: {
      SettingsNote(NativeStrings.MCP.Clients.header)
    } footer: {
      SettingsNote(NativeStrings.MCP.Clients.footer)
    }
  }

  @ViewBuilder private func instructionsSection(_ settings: MCPSettings) -> some View {
    let prose = MCPSettingsModel.displayProse(settings.instructions)

    if !prose.isEmpty {
      Section {
        Text(verbatim: prose)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .accessibilityIdentifier("hermie.mcp.instructions")
      } header: {
        SettingsNote(NativeStrings.MCP.Instructions.header)
      }
    }
  }

  @ViewBuilder private var failureSection: some View {
    if model.revokeFailed {
      Section {
        Label {
          Text(verbatim: NativeStrings.MCP.Grant.revokeFailed)
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "exclamationmark.triangle")
            .foregroundStyle(Color.primary)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.mcp.failure")
      }
    }
  }

  // MARK: Actions

  private var confirmationPresented: Binding<Bool> {
    Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })
  }

  private func revoke(_ grant: MCPGrant) {
    let id = grant.id

    Task {
      await model.revoke(grantID: id)
    }
  }

  /// The text exactly as the gateway sent it, never the marked-up version the page draws.
  private func copy(_ text: String, _ target: MCPCopyTarget) {
    MCPBoard.copy(text)
    copied = target

    Task {
      try? await Task.sleep(for: .seconds(2))

      if copied == target {
        copied = nil
      }
    }
  }
}

/// A text the person can copy: drawn in a monospaced face with its whitespace and invisible
/// characters made visible, and copied as it is.
private struct CopyBlock: View {
  let text: String
  let copyTitle: String
  let copied: Bool
  let identifier: String
  let copyAction: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: ConfirmDetailMarkup(text, emptyLines: NativeStrings.Confirm.emptyLines).text)
        .font(.callout.monospaced())
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("\(identifier).text")

      Button(
        copied ? NativeStrings.MCP.copied : copyTitle,
        systemImage: copied ? "checkmark" : "doc.on.doc",
        action: copyAction
      )
      .buttonStyle(.borderless)
      .disabled(text.isEmpty)
      .accessibilityLabel(copyTitle)
      .accessibilityIdentifier("\(identifier).copy")
    }
    .accessibilityElement(children: .contain)
  }
}

/// One MCP client the person allowed: its name as it registered, when it was allowed, when it last
/// used its token and from where, and the way to revoke it.
struct MCPGrantRow: View {
  let grant: MCPGrant
  let busy: Bool
  let revoke: () -> Void

  var body: some View {
    let lines = MCPText.lines(for: grant)

    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        // The name and the addresses are somebody else's text: plain, one bounded line each.
        Text(verbatim: lines.name)
          .font(.body)
          .fixedSize(horizontal: false, vertical: true)
        Text(verbatim: lines.allowed)
          .font(.footnote)
        Text(verbatim: lines.lastUsed)
          .font(.footnote)
        if let expires = lines.expires {
          Text(verbatim: expires)
            .font(.footnote)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(verbatim: lines.spoken))
      .accessibilityIdentifier("hermie.mcp.grant")

      Button(NativeStrings.MCP.Grant.revoke, systemImage: "trash", role: .destructive, action: revoke)
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .disabled(busy)
        .accessibilityLabel(Text(verbatim: NativeStrings.MCP.Grant.revokeLabel(lines.name)))
        .accessibilityIdentifier("hermie.mcp.revoke")
    }
    .accessibilityElement(children: .contain)
  }
}

/// The pasteboard for what the page copies: the endpoint, the command and the configuration are not
/// secrets, so this is the plain general pasteboard.
@MainActor
enum MCPBoard {
  static func copy(_ text: String) {
    #if os(iOS)
      UIPasteboard.general.string = text
    #elseif os(macOS)
      let board = NSPasteboard.general
      board.clearContents()
      board.setString(text, forType: .string)
    #endif
  }
}

/// The MCP category of Settings: the live gateway's page, or the one line that there is none. Only
/// the live gateway has a session, so only its MCP settings can be read and changed.
struct MCPSettingsEntry: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(LiveGateway.self) private var live: LiveGateway?

  var body: some View {
    if let model = live?.session?.mcp, let id = live?.gatewayID, let entry = launch.gateways.entry(id: id) {
      MCPSettingsPage(model: model, gatewayName: entry.name)
    } else {
      MCPNoGatewayPage()
    }
  }
}

/// What the MCP category says while there is no live gateway.
struct MCPNoGatewayPage: View {
  var body: some View {
    let words = MCPText.state(.noGateway)

    Form {
      Section {
        Label {
          Text(verbatim: words.text)
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: words.symbol)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.mcp.state")
      }
    }
    .formStyle(.grouped)
    .accessibilityIdentifier("hermie.mcp.page")
  }
}
