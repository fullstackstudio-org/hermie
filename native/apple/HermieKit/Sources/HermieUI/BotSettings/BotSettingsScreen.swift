import HermieCore
import SwiftUI

/**
 One bot's settings, as a page pushed over its chat (`DetailRoute.botProfile`), reached from the
 chat's header and from the chat list's row menu.

 It holds what the Expo app's profile sheet, capabilities sheet and chat options hold, in sections:
 the picture, name and colour; the description; the personality; the model; the toolsets, skills and
 MCP servers; what the chat shows; and the chat list's pin, mute and archive.

 - **What this account may do.** The gateway says only when it refuses, so the form is writable until
   a write is refused as not this account's to make; from then on it is read-only (the editors become
   plain selectable text, the switches disabled) and says so. Offline is read-only too. The
   name, colour, pin, mute and archive are not the gateway's profile but this person's `ui_meta`, and
   follow whether that sync is attached.
 - **What the gateway lacks.** A gateway without `profiles.describe` shows the sections Hermie
   keeps itself and one line that the rest is not offered, not controls that cannot work. The
   model picker is drawn only where `model.options` lists models.
 - **Writes** go through the gateway's own methods (`BotSettingsModel`); a failure is said under the
   control it is about, in the gateway's words, as plain text.

 It reads the session from `LiveGateway` in the environment.
 */
public struct BotSettingsScreen: View {
  let chat: ChatRef

  @Environment(LiveGateway.self) private var live: LiveGateway?

  public init(chat: ChatRef) {
    self.chat = chat
  }

  public var body: some View {
    Group {
      if let live, live.gatewayID == chat.gatewayId, let session = live.session {
        BotSettingsContent(chat: chat, session: session)
          .id(ObjectIdentifier(session))
      } else {
        EmptyState(
          NativeStrings.BotSettings.title,
          systemImage: "slider.horizontal.3",
          message: Text(NativeStrings.BotSettings.offline)
        )
      }
    }
    .navigationTitle(NativeStrings.BotSettings.title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.botSettings")
  }
}

/// The chat header's way in: opens the bot's settings over the chat. Absent where there is no router
/// to push on.
struct BotSettingsButton: View {
  let chat: ChatRef

  @Environment(AppRouter.self) private var router: AppRouter?

  var body: some View {
    if let router {
      Button {
        router.showBotSettings(chat)
      } label: {
        Label(NativeStrings.BotSettings.open, systemImage: "info.circle")
      }
      .accessibilityIdentifier("hermie.chat.botSettings")
    }
  }
}

/// The form over a running session.
struct BotSettingsContent: View {
  let chat: ChatRef
  let session: GatewaySession

  @State private var model: BotSettingsModel

  init(chat: ChatRef, session: GatewaySession) {
    self.chat = chat
    self.session = session
    _model = State(initialValue: session.botSettings(for: chat.bot))
  }

  var body: some View {
    let connected = session.status.phase == .ready
    let gatewayEditable = model.canWrite(connected: connected)
    let metaEditable = session.arrangement.canEdit

    Form {
      BotHeaderSection(chat: chat, session: session, model: model, editable: gatewayEditable)

      status(connected: connected)

      BotIdentitySection(chat: chat, session: session, editable: metaEditable)

      if model.details != nil {
        BotDescriptionSection(handle: chat.bot, model: model, editable: gatewayEditable)
        BotPersonalitySection(handle: chat.bot, model: model, editable: gatewayEditable)
        BotModelSection(chat: chat, session: session, model: model, editable: gatewayEditable)
        BotToolsetsSection(handle: chat.bot, model: model, editable: gatewayEditable)
        BotSkillsSection(handle: chat.bot, model: model, editable: gatewayEditable)
        BotMcpSection(handle: chat.bot, model: model, editable: gatewayEditable)
      }

      BotChatViewSection(chat: session.chat(chat.bot))
      BotChatListSection(chat: chat, session: session, editable: metaEditable)
      BotAboutSection(chat: chat, session: session)
    }
    .formStyle(.grouped)
    .task { await model.load() }
    .task(id: gatewayEditable) {
      if gatewayEditable { await model.loadModelChoices() }
    }
    .onChange(of: connected) { _, now in
      // A connection that came back is the moment to read what could not be read, and to drop an
      // older read-only that was only the connection's.
      if now, model.details == nil || model.phase != .loaded {
        Task { await model.load() }
      }
    }
    .refreshable { await model.load() }
    .alert(
      Strings.Chat.Options.expensiveTitle,
      isPresented: Binding(
        get: { model.modelConfirmation != nil },
        set: { if !$0 { model.cancelModelConfirmation() } }
      ),
      presenting: model.modelConfirmation
    ) { confirmation in
      Button(Strings.Chat.Options.expensiveConfirm) {
        Task { await model.confirmModel(confirmation) }
      }
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: { confirmation in
      Text(verbatim: confirmation.message)
    }
    .alert(
      Strings.Profiles.Capabilities.Reload.title,
      isPresented: Binding(
        get: { model.mcpReloadPrompt != nil },
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

  /// Why the gateway's sections are missing or read-only: loading, a failed read, no support, no
  /// connection, or an account that may not write.
  @ViewBuilder private func status(connected: Bool) -> some View {
    switch model.phase {
    case .idle, .loading:
      Section {
        HStack(spacing: 10) {
          ProgressView()
          Text(Strings.Profiles.Capabilities.loading)
        }
        .accessibilityElement(children: .combine)
      }
    case .failed(let failure):
      Section {
        switch failure {
        case .unsupported:
          Label(NativeStrings.BotSettings.unsupported, systemImage: "slider.horizontal.3")
        default:
          Text(verbatim: Strings.Profiles.Capabilities.failed(reason: Self.reason(failure, handle: chat.bot)))
          Button(Strings.App.Common.retry) { Task { await model.load() } }
        }
      }
    case .loaded:
      if model.refused {
        Section {
          Label(NativeStrings.BotSettings.readOnly, systemImage: "lock")
            .accessibilityIdentifier("hermie.botSettings.readOnly")
        }
      } else if !connected {
        Section {
          Label(NativeStrings.BotSettings.offline, systemImage: "wifi.slash")
        }
      }
    }
  }

  /// A failed read in words: the gateway's, when it had some.
  static func reason(_ failure: BotSettingsFailure, handle: String) -> String {
    failure.detail ?? BotSettingsText.message(for: failure, handle: handle)
  }
}
