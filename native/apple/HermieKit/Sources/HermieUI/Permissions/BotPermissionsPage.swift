import HermieCore
import SwiftUI

/**
 A bot's Permissions, on its settings page: one row, in the style of the capability, usage and vault rows, that
 says how many approvals the bot holds on the gateway and opens its page (`BotPermissionsPage`).

 The row and the page share one model, so what the page revokes is in the row's count on the way back. The
 count is read when the row appears and the gateway is connected.
 */
struct BotPermissionsSection: View {
  let chat: ChatRef
  let session: GatewaySession

  @State private var model: PermissionsModel

  init(chat: ChatRef, session: GatewaySession) {
    self.chat = chat
    self.session = session
    _model = State(initialValue: session.permissions(for: chat.bot))
  }

  var body: some View {
    let connected = session.status.phase == .ready

    Section {
      NavigationLink {
        BotPermissionsPage(session: session, bot: chat.bot, model: model)
      } label: {
        LabeledContent {
          summary
        } label: {
          Label(NativeStrings.Permissions.title, systemImage: "checkmark.shield")
        }
      }
      .accessibilityIdentifier("hermie.botSettings.permissions")
    }
    .task(id: connected) {
      if connected, model.phase != .loaded {
        await model.load()
      }
    }
  }

  /// How many approvals, a spinner while they are read, a dash where there are none or they cannot be read.
  @ViewBuilder private var summary: some View {
    if let count = model.count {
      Text(verbatim: count == 0 ? "–" : String(count))
        .foregroundStyle(.secondary)
        .monospacedDigit()
    } else if model.phase == .loading {
      ProgressView()
        .controlSize(.small)
    } else {
      Text(verbatim: "–")
        .foregroundStyle(.secondary)
    }
  }
}

/**
 One bot's approvals on the gateway (`approval.grants` and `approval.revoke`, always with the bot's profile).

 - **The approval mode**, shown and explained. It is the gateway's configuration: the page does not change it.
 - **Always allowed**: each standing approval as the gateway names it (plain text; one approval may name several
   rules), with Revoke, and Revoke all.
 - **This session**, for each live session that holds an approval or has YOLO on: whether YOLO is on (it is
   switched off in the chat's options, not here), and the session's approvals with Revoke, and Revoke all.
 - **A revoke asks first**, applies on this gateway at once, and the lists are read again after it. The page says
   that other Hermes processes on the same profile follow on their next reload.
 */
struct BotPermissionsPage: View {
  let session: GatewaySession
  let bot: String

  @State private var model: PermissionsModel

  /// - Parameter model: the bot settings row's model, so the row's count follows what is done here; nil
  ///   builds one for this page.
  init(session: GatewaySession, bot: String, model: PermissionsModel? = nil) {
    self.session = session
    self.bot = bot
    _model = State(initialValue: model ?? session.permissions(for: bot))
  }

  var body: some View {
    let name = session.chatName(bot)

    Form {
      Section {
        Label {
          Text(NativeStrings.Permissions.about(name))
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "checkmark.shield")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
        .accessibilityIdentifier("hermie.permissions.about")
      }

      if let failure = model.actionFailure {
        Section {
          CapabilityStatusRow(
            text: PermissionWords.action(failure), symbol: "exclamationmark.triangle",
            identifier: "hermie.permissions.actionFailure")
          Button(Strings.App.Common.dismiss) { model.dismissActionFailure() }
        }
      }

      switch model.phase {
      case .idle, .loading:
        Section {
          CapabilityLoadingRow(text: NativeStrings.Permissions.loading)
        }
      case .failed(let failure):
        Section {
          CapabilityFailureRow(text: PermissionWords.load(failure)) { Task { await model.load() } }
        }
      case .loaded:
        loaded(name)
      }
    }
    .formStyle(.grouped)
    .navigationTitle(NativeStrings.Permissions.title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .task { await model.load() }
    .refreshable { await model.load() }
    .confirmationDialog(
      model.pending.map { PermissionDialogWords.title($0) } ?? "",
      isPresented: Binding(
        get: { model.pending != nil },
        set: { if !$0 { PermissionRevokeDialog.dismissed(model) } }
      ),
      titleVisibility: .visible,
      presenting: model.pending
    ) { revocation in
      Button(
        revocation.grant == nil ? NativeStrings.Permissions.revokeAll : NativeStrings.Permissions.revoke,
        role: .destructive
      ) {
        PermissionRevokeDialog.confirmed(model, revocation)
      }
      .accessibilityIdentifier("hermie.permissions.revoke.confirm")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: { revocation in
      Text(PermissionDialogWords.message(revocation, bot: name))
    }
    .accessibilityIdentifier("hermie.permissions.page")
  }

  @ViewBuilder private func loaded(_ name: String) -> some View {
    Section {
      LabeledContent(NativeStrings.Permissions.mode) {
        Text(NativeStrings.Permissions.modeName(model.mode))
          .foregroundStyle(.secondary)
      }
      .accessibilityIdentifier("hermie.permissions.mode")

      Text(NativeStrings.Permissions.modeNote(model.mode))
        .foregroundStyle(Color.primary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("hermie.permissions.modeNote")
    } footer: {
      Text(NativeStrings.Permissions.modeFooter)
    }

    Section {
      if model.permanent.isEmpty {
        Text(NativeStrings.Permissions.alwaysEmpty)
          .foregroundStyle(Color.primary)
          .accessibilityIdentifier("hermie.permissions.always.empty")
      }

      ForEach(model.permanent) { grant in
        PermissionGrantRow(
          grant: grant, revoking: model.isRevoking(PermissionRevocation(scope: .permanent, grant: grant))
        ) {
          model.ask(PermissionRevocation(scope: .permanent, grant: grant))
        }
      }

      if !model.permanent.isEmpty {
        Button(NativeStrings.Permissions.revokeAll, role: .destructive) {
          model.ask(PermissionRevocation(scope: .permanent, grant: nil))
        }
        .disabled(model.isRevoking(PermissionRevocation(scope: .permanent, grant: nil)))
        .accessibilityIdentifier("hermie.permissions.always.revokeAll")
      }
    } header: {
      Text(NativeStrings.Permissions.always)
    } footer: {
      Text(NativeStrings.Permissions.alwaysNote(name))
    }
    .accessibilityIdentifier("hermie.permissions.always")

    if model.sessions.isEmpty {
      Section {
        Text(NativeStrings.Permissions.sessionsEmpty)
          .foregroundStyle(Color.primary)
          .accessibilityIdentifier("hermie.permissions.sessions.empty")
      } header: {
        Text(NativeStrings.Permissions.sessionThis)
      } footer: {
        Text(NativeStrings.Permissions.sessionsFooter)
      }
    } else {
      ForEach(Array(model.sessions.enumerated()), id: \.element.id) { index, live in
        sessionSection(live, title: title(of: live, at: index), last: index == model.sessions.count - 1)
      }
    }

    Section {
      SettingsNote(NativeStrings.Permissions.scopeNote)
        .accessibilityIdentifier("hermie.permissions.scopeNote")
    }
  }

  /// This chat's session, or the Nth other one.
  private func title(of live: SessionPermissions, at index: Int) -> String {
    if model.isChat(live) {
      return NativeStrings.Permissions.sessionThis
    }

    let others = model.sessions.prefix(index + 1).filter { !model.isChat($0) }.count

    return NativeStrings.Permissions.sessionOther(others)
  }

  @ViewBuilder private func sessionSection(_ live: SessionPermissions, title: String, last: Bool) -> some View {
    Section {
      LabeledContent(NativeStrings.Permissions.yolo) {
        Text(live.yolo ? NativeStrings.Permissions.on : NativeStrings.Permissions.off)
          .foregroundStyle(live.yolo ? Color.orange : Color.secondary)
      }
      .accessibilityIdentifier("hermie.permissions.session.yolo")

      if live.yolo {
        Text(NativeStrings.Permissions.yoloNote)
          .foregroundStyle(Color.primary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if live.grants.isEmpty {
        Text(NativeStrings.Permissions.sessionEmpty)
          .foregroundStyle(Color.primary)
          .accessibilityIdentifier("hermie.permissions.session.empty")
      }

      ForEach(live.grants) { grant in
        let revocation = PermissionRevocation(scope: .session(live.sessionID), grant: grant)

        PermissionGrantRow(grant: grant, revoking: model.isRevoking(revocation)) {
          model.ask(revocation)
        }
      }

      if !live.grants.isEmpty {
        Button(NativeStrings.Permissions.revokeAll, role: .destructive) {
          model.ask(PermissionRevocation(scope: .session(live.sessionID), grant: nil))
        }
        .disabled(model.isRevoking(PermissionRevocation(scope: .session(live.sessionID), grant: nil)))
        .accessibilityIdentifier("hermie.permissions.session.revokeAll")
      }
    } header: {
      Text(title)
    } footer: {
      if last {
        Text(NativeStrings.Permissions.sessionsFooter)
      }
    }
    .accessibilityIdentifier("hermie.permissions.session")
  }
}

/// One approval: what it allows as the gateway names it, in plain text, and the way to take it back.
struct PermissionGrantRow: View {
  let grant: PermissionGrant
  let revoking: Bool
  let revoke: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: grant.label)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)

        if grant.tirith {
          Text(NativeStrings.Permissions.tirith)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Spacer(minLength: 0)

      if revoking {
        ProgressView()
          .controlSize(.small)
      } else {
        Button(NativeStrings.Permissions.revoke, role: .destructive, action: revoke)
          .buttonStyle(.borderless)
          .accessibilityIdentifier("hermie.permissions.grant.revoke")
      }
    }
    .contextMenu {
      Button(NativeStrings.Permissions.revoke, systemImage: "xmark.circle", role: .destructive, action: revoke)
    }
    .accessibilityIdentifier("hermie.permissions.grant")
  }
}

/// What the revoke question says: about one approval, or about all of a scope's.
enum PermissionDialogWords {
  static func title(_ revocation: PermissionRevocation) -> String {
    switch (revocation.scope, revocation.grant) {
    case (_, let grant?): NativeStrings.Permissions.revokeTitle(grant.label)
    case (.permanent, nil): NativeStrings.Permissions.revokeAllTitle
    case (.session, nil): NativeStrings.Permissions.revokeAllSessionTitle
    }
  }

  static func message(_ revocation: PermissionRevocation, bot: String) -> String {
    switch (revocation.scope, revocation.grant) {
    case (.permanent, .some): NativeStrings.Permissions.revokeMessage(bot)
    case (.permanent, nil): NativeStrings.Permissions.revokeAllMessage(bot)
    case (.session, _): NativeStrings.Permissions.revokeSessionMessage(bot)
    }
  }
}

/**
 What the revoke question's two ends do, in the order SwiftUI calls them: a button of a confirmation dialog
 first dismisses the dialog (its `isPresented` setter, with `false`) and only then runs its action. So the yes
 carries the revocation the dialog presented, and the dismissal clears the question only while one is still
 asked.
 */
@MainActor
enum PermissionRevokeDialog {
  /// The dialog went away (Cancel, a tap outside, Esc, or before any button's action).
  static func dismissed(_ model: PermissionsModel) {
    if model.pending != nil {
      model.cancel()
    }
  }

  /// Revoke: `revocation` is the one the dialog presented.
  @discardableResult
  static func confirmed(_ model: PermissionsModel, _ revocation: PermissionRevocation) -> Task<Bool, Never> {
    Task { await model.confirm(revocation) }
  }
}
