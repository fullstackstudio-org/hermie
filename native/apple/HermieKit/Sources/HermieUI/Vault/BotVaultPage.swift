import HermieCore
import SwiftUI

/**
 A bot's Vault, on its settings page: one row, in the style of the capability and usage rows, that says how
 many items the bot's vault holds and opens its page (`BotVaultPage`).

 The row and the page share one model, so what the page adds or removes is in the row's count on the way back.
 The count is read when the row appears unless a read within the last minute already gave it (`VaultCounts`):
 a listing can ask a password manager on the gateway's host, which is not instant.
 */
struct BotVaultSection: View {
  let chat: ChatRef
  let session: GatewaySession

  @State private var model: VaultModel

  init(chat: ChatRef, session: GatewaySession) {
    self.chat = chat
    self.session = session
    _model = State(initialValue: session.vault(for: chat.bot))
  }

  var body: some View {
    let connected = session.status.phase == .ready

    Section {
      NavigationLink {
        BotVaultPage(session: session, bot: chat.bot, model: model)
      } label: {
        LabeledContent {
          summary
        } label: {
          Label(NativeStrings.Vault.title, systemImage: "key")
        }
      }
      .accessibilityIdentifier("hermie.botSettings.vault")
    }
    .task(id: connected) {
      if connected {
        await model.loadCountIfStale()
      }
    }
  }

  /// How many items, a spinner while they are read, a dash where they cannot be.
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

/// A bot's Vault page from the chat's menu (`DetailRoute.vault`): the live session's page, or a line that it
/// needs the connection.
struct BotVaultScreen: View {
  let chat: ChatRef

  @Environment(LiveGateway.self) private var live: LiveGateway?

  var body: some View {
    if let live, live.gatewayID == chat.gatewayId, let session = live.session {
      BotVaultPage(session: session, bot: chat.bot)
        .id(ObjectIdentifier(session))
    } else {
      EmptyState(NativeStrings.Vault.title, systemImage: "key", message: Text(NativeStrings.Vault.offline))
        .navigationTitle(NativeStrings.Vault.title)
    }
  }
}

/**
 One bot's own vault on the gateway (`vault.*`, always with the bot's profile).

 - What each item is for (its label, its kind, its site and, for a login, the email or username the bot signs
   in with), never what it holds: the page reads metadata only, and holds no secret.
 - **Add** opens a sheet whose secret fields are masked and kept nowhere but that sheet (`VaultAddSheet`).
 - **Remove** asks first, and only for an item in the bot's own vault: a password manager's items are the
   manager's.
 - The password managers on the gateway's computer, when there are any: on or off for this bot, locked or
   unlocked, with Lock and Unlock (the master password is typed in a sheet of its own, `VaultUnlockSheet`).
 */
struct BotVaultPage: View {
  let session: GatewaySession
  let bot: String

  @State private var model: VaultModel
  @State private var adding = false
  @State private var unlocking: VaultSource?

  /// - Parameter model: the bot settings row's model, so the row's count follows what is done here; nil
  ///   builds one for this page (opened from the chat's menu).
  init(session: GatewaySession, bot: String, model: VaultModel? = nil) {
    self.session = session
    self.bot = bot
    _model = State(initialValue: model ?? session.vault(for: bot))
  }

  var body: some View {
    let name = session.chatName(bot)

    Form {
      Section {
        Label {
          Text(NativeStrings.Vault.about(name))
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "lock.shield")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
        .accessibilityIdentifier("hermie.vault.about")
      }

      if let failure = model.actionFailure {
        Section {
          CapabilityStatusRow(
            text: VaultWords.action(failure), symbol: "exclamationmark.triangle", identifier: "hermie.vault.actionFailure")
          Button(Strings.App.Common.dismiss) { model.dismissActionFailure() }
        }
      }

      itemsSection(name)

      if model.phase == .loaded, !model.managers.isEmpty {
        Section {
          ForEach(model.managers) { source in
            VaultSourceRow(model: model, source: source) { unlocking = source }
          }
        } header: {
          Text(NativeStrings.Vault.sources)
        } footer: {
          SettingsNote(NativeStrings.Vault.sourcesNote(name))
        }
        .accessibilityIdentifier("hermie.vault.sources")
      }
    }
    .formStyle(.grouped)
    .navigationTitle(NativeStrings.Vault.title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button(NativeStrings.Vault.add, systemImage: "plus") { adding = true }
          .disabled(model.phase != .loaded)
          .accessibilityIdentifier("hermie.vault.addButton")
      }
    }
    .task { await model.load() }
    .refreshable { await model.load() }
    .sheet(isPresented: $adding) {
      VaultAddSheet(model: model, botName: name)
    }
    .sheet(item: $unlocking) { source in
      VaultUnlockSheet(model: model, source: source)
    }
    .confirmationDialog(
      model.pendingRemoval.map { NativeStrings.Vault.removeTitle($0.label) } ?? "",
      isPresented: Binding(
        get: { model.pendingRemoval != nil },
        set: { if !$0 { VaultRemovalDialog.dismissed(model) } }
      ),
      titleVisibility: .visible,
      presenting: model.pendingRemoval
    ) { item in
      Button(NativeStrings.Vault.remove, role: .destructive) {
        VaultRemovalDialog.confirmed(model, item)
      }
      .accessibilityIdentifier("hermie.vault.remove.confirm")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: { _ in
      Text(NativeStrings.Vault.removeMessage(name))
    }
    .accessibilityIdentifier("hermie.vault.page")
  }

  @ViewBuilder private func itemsSection(_ name: String) -> some View {
    Section {
      switch model.phase {
      case .idle, .loading:
        CapabilityLoadingRow(text: NativeStrings.Vault.loading)
      case .failed(let failure):
        CapabilityFailureRow(text: VaultWords.load(failure)) { Task { await model.load() } }
      case .loaded:
        if model.items.isEmpty {
          Text(NativeStrings.Vault.empty)
            .foregroundStyle(Color.primary)
            .accessibilityIdentifier("hermie.vault.empty")
        }

        ForEach(model.items) { item in
          VaultItemRow(item: item, manager: model.managerName(of: item), removing: model.removing.contains(item.id)) {
            model.askRemoval(item)
          }
        }

        Button(NativeStrings.Vault.add, systemImage: "plus") { adding = true }
          .accessibilityIdentifier("hermie.vault.add")
      }
    } header: {
      Text(NativeStrings.Vault.items)
    }
    .accessibilityIdentifier("hermie.vault.items")
  }
}

/// One item: what it is for, never what it holds.
struct VaultItemRow: View {
  let item: VaultItem
  /// The password manager that holds it; nil for the bot's own vault.
  let manager: String?
  let removing: Bool
  let remove: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Image(systemName: VaultWords.symbol(item))
        .foregroundStyle(.tint)
        .frame(width: 24)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: item.label.isEmpty ? VaultWords.kind(item) : item.label)
          .lineLimit(2)
        Text(verbatim: details)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)
          .truncationMode(.middle)
      }

      Spacer(minLength: 0)

      if removing {
        ProgressView()
          .controlSize(.small)
      } else if item.isLocal {
        Button(role: .destructive, action: remove) {
          Image(systemName: "trash")
            .accessibilityLabel(NativeStrings.Vault.remove)
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("hermie.vault.item.remove")
      }
    }
    .accessibilityElement(children: .combine)
    .contextMenu {
      if item.isLocal {
        Button(NativeStrings.Vault.remove, systemImage: "trash", role: .destructive, action: remove)
      }
    }
    .accessibilityIdentifier("hermie.vault.item")
  }

  /// The kind, the site, the login's identifier, and where it is kept when that is a password manager.
  private var details: String {
    var parts = [VaultWords.kind(item)]

    if let origin = item.origin {
      parts.append(origin)
    }

    if let identifier = item.identifier {
      parts.append(identifier)
    }

    if item.hasOTP {
      parts.append(NativeStrings.Vault.withOTP)
    }

    if let manager {
      parts.append(NativeStrings.Vault.inManager(manager))
    }

    return parts.joined(separator: " · ")
  }
}

/// One password manager: on or off for this bot, locked or unlocked, and the button that changes that.
struct VaultSourceRow: View {
  let model: VaultModel
  let source: VaultSource
  let unlock: () -> Void

  var body: some View {
    let busy = model.busySources.contains(source.name)

    VStack(alignment: .leading, spacing: 8) {
      Toggle(
        NativeStrings.Vault.use(source.displayName),
        isOn: Binding(
          get: { source.enabled },
          set: { on in Task { await model.setEnabled(source.name, on) } }
        )
      )
      .disabled(busy || (!source.installed && !source.enabled))
      .accessibilityIdentifier("hermie.vault.source.enabled")

      HStack {
        Label(state, systemImage: source.unlocked ? "lock.open" : "lock")
          .font(.footnote)
          .foregroundStyle(.secondary)

        Spacer(minLength: 0)

        if busy {
          ProgressView()
            .controlSize(.small)
        } else if source.enabled, source.installed {
          if source.unlocked {
            Button(NativeStrings.Vault.lock) { Task { await model.lock(source.name) } }
              .accessibilityIdentifier("hermie.vault.source.lock")
          } else {
            Button(NativeStrings.Vault.unlock, action: unlock)
              .accessibilityIdentifier("hermie.vault.source.unlock")
          }
        }
      }
      .buttonStyle(.borderless)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.vault.source")
  }

  private var state: String {
    if !source.installed {
      return NativeStrings.Vault.notInstalled
    }

    return source.unlocked ? NativeStrings.Vault.unlocked : NativeStrings.Vault.locked
  }
}

/**
 What the remove question's two ends do, in the order SwiftUI calls them: a button of a confirmation dialog
 first dismisses the dialog (its `isPresented` setter, with `false`) and only then runs its action. So the yes
 carries the item the dialog presented, and the dismissal clears the question only while one is still asked.
 */
@MainActor
enum VaultRemovalDialog {
  /// The dialog went away (Cancel, a tap outside, Esc, or before any button's action).
  static func dismissed(_ model: VaultModel) {
    if model.pendingRemoval != nil {
      model.cancelRemoval()
    }
  }

  /// Remove: `item` is the one the dialog presented.
  @discardableResult
  static func confirmed(_ model: VaultModel, _ item: VaultItem) -> Task<Bool, Never> {
    Task { await model.confirmRemoval(item) }
  }
}
