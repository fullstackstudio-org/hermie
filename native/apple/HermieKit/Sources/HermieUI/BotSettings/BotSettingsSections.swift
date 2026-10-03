import HermieCore
import HermieTranscript
import PhotosUI
import SwiftUI

// The sections of the bot settings form, one view each. A control is drawn only when the thing
// behind it exists (`BotSettingsContent` decides), enabled only when this account may use it, and
// every string the gateway sent is drawn as plain text (`Text(verbatim:)`).

// MARK: - The picture and the name

/// The bot's picture and name, with the buttons that change the picture.
struct BotHeaderSection: View {
  let chat: ChatRef
  let session: GatewaySession
  @Bindable var model: BotSettingsModel
  /// Whether this account may write to the gateway now.
  let editable: Bool

  @State private var photoItem: PhotosPickerItem?
  @State private var photoFailed = false

  var body: some View {
    let row = session.chatList.rows[chat.bot]
    let name = session.chatName(chat.bot)

    Section {
      VStack(spacing: 12) {
        BotAvatar(name: name, avatar: row?.avatar, size: 96, accent: session.arrangement.accent(chat.bot))

        VStack(spacing: 2) {
          Text(verbatim: name)
            .font(.title2.weight(.semibold))
            .multilineTextAlignment(.center)
          Text(verbatim: chat.bot)
            .font(.callout.monospaced())
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)

        if editable {
          HStack(spacing: 12) {
            PhotosPicker(selection: $photoItem, matching: .images) {
              Text(row?.bot.hasAvatar == true ? Strings.App.BotProfile.photoReplace : Strings.App.BotProfile.photoChange)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("hermie.botSettings.photo")

            if row?.bot.hasAvatar == true {
              Button(Strings.App.BotProfile.photoRemove, role: .destructive) {
                Task { await model.clearAvatar() }
              }
              .buttonStyle(.bordered)
              .accessibilityIdentifier("hermie.botSettings.photo.remove")
            }
          }
          .disabled(model.busy.contains(.avatar))
        }

        if model.busy.contains(.avatar) {
          ProgressView()
        }

        if photoFailed {
          Text(verbatim: Strings.App.BotProfile.photoFailed)
            .font(.callout)
            .foregroundStyle(Color.primary)
        }

        if let failure = model.failures[.avatar] {
          FailureLine(failure: failure, handle: chat.bot) { model.dismissFailure(.avatar) }
        }
      }
      .frame(maxWidth: .infinity)
    }
    .listRowBackground(Color.clear)
    .onChange(of: photoItem) { _, item in
      guard let item else { return }

      photoItem = nil
      Task { await upload(item) }
    }
  }

  private func upload(_ item: PhotosPickerItem) async {
    photoFailed = false

    guard let data = try? await item.loadTransferable(type: Data.self), let base64 = AvatarEncoder.base64(from: data)
    else {
      photoFailed = true
      return
    }

    await model.setAvatar(base64: base64)
  }
}

/// The name this person gave the bot, the handle, and the colour.
struct BotIdentitySection: View {
  let chat: ChatRef
  let session: GatewaySession
  /// Whether the name and colour can be written: the ui_meta sync is attached.
  let editable: Bool

  @State private var labelDraft: String
  @FocusState private var labelFocused: Bool

  init(chat: ChatRef, session: GatewaySession, editable: Bool) {
    self.chat = chat
    self.session = session
    self.editable = editable
    _labelDraft = State(initialValue: session.arrangement.label(chat.bot) ?? "")
  }

  var body: some View {
    let stored = session.arrangement.label(chat.bot) ?? ""
    let fallback = session.chatList.rows[chat.bot]?.bot.displayName ?? chat.bot

    Section {
      LabeledContent(Strings.BotRename.displayLabel) {
        TextField("", text: $labelDraft, prompt: Text(verbatim: fallback))
          .multilineTextAlignment(.trailing)
          .focused($labelFocused)
          .submitLabel(.done)
          .onSubmit(commitLabel)
          .disabled(!editable)
          .accessibilityLabel(Strings.BotRename.displayLabel)
          .accessibilityIdentifier("hermie.botSettings.label")
      }

      LabeledContent(Strings.BotRename.profileLabel) {
        Text(verbatim: chat.bot)
          .font(.body.monospaced())
          .textSelection(.enabled)
      }

      VStack(alignment: .leading, spacing: 10) {
        Text(Strings.App.Layout.colour)
        AccentPicker(
          selection: session.arrangement.accent(chat.bot), botName: fallback, editable: editable
        ) { accent in
          session.arrangement.setAccent(chat.bot, accent)
        }
      }
      .padding(.vertical, 4)
    } header: {
      Text(NativeStrings.BotSettings.identity)
    } footer: {
      VStack(alignment: .leading, spacing: 6) {
        SettingsNote("\(Strings.BotRename.displayHint) \(Strings.BotRename.clearHint)")
        SettingsNote(NativeStrings.BotSettings.handleHint)
        SettingsNote(NativeStrings.BotSettings.colourHint)

        if !editable {
          SettingsNote(NativeStrings.BotSettings.notSynced)
        }
      }
    }
    .onChange(of: labelFocused) { _, focused in
      if !focused { commitLabel() }
    }
    .onChange(of: stored) { _, next in
      // Another device named it: follow, unless this field is being typed in.
      if !labelFocused { labelDraft = next }
    }
    .onDisappear(perform: commitLabel)
  }

  private func commitLabel() {
    guard editable else { return }

    let cleaned = BotIdentity.cleaned(label: labelDraft)

    if cleaned != (session.arrangement.label(chat.bot) ?? "") {
      session.arrangement.setLabel(chat.bot, labelDraft)
    }

    labelDraft = cleaned
  }
}

/// The eleven colours, as a row of swatches that wraps.
struct AccentPicker: View {
  let selection: BotAccent
  let botName: String
  let editable: Bool
  let select: (BotAccent) -> Void

  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 36, maximum: 44), spacing: 10)], alignment: .leading, spacing: 10) {
      ForEach(BotAccent.allCases, id: \.self) { accent in
        Button {
          select(accent)
        } label: {
          Circle()
            .fill(accent.fill)
            .frame(width: 32, height: 32)
            .overlay {
              if accent == selection {
                Image(systemName: "checkmark")
                  .font(.footnote.weight(.bold))
                  .foregroundStyle(accent == .lime ? Color.black : Color.white)
              }
            }
            .overlay {
              Circle().strokeBorder(Color.primary.opacity(accent == selection ? 0.9 : 0.25), lineWidth: accent == selection ? 2 : 1)
                .padding(accent == selection ? -3 : 0)
            }
            .padding(4)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(BotSettingsText.name(of: accent))
        .accessibilityAddTraits(accent == selection ? .isSelected : [])
        .accessibilityIdentifier("hermie.botSettings.colour.\(accent.rawValue)")
      }
    }
    .disabled(!editable)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Strings.App.Layout.colourOf(name: botName))
  }
}

// MARK: - Text

/// The description, with Save and Revert while it differs from the gateway's.
struct BotDescriptionSection: View {
  let handle: String
  @Bindable var model: BotSettingsModel
  let editable: Bool

  var body: some View {
    Section {
      TextField(
        Strings.App.BotProfile.descriptionPlaceholder, text: $model.descriptionDraft, axis: .vertical
      )
      .lineLimit(1...6)
      .disabled(!editable)
      .accessibilityIdentifier("hermie.botSettings.description")

      if model.descriptionIsDirty, editable {
        SaveRevertRow(
          busy: model.busy.contains(.description),
          revert: { model.revertDescription() },
          save: { Task { await model.saveDescription() } }
        )
        .accessibilityIdentifier("hermie.botSettings.description.save")
      }

      if let failure = model.failures[.description] {
        FailureLine(failure: failure, handle: handle) { model.dismissFailure(.description) }
      }
    } header: {
      Text(NativeStrings.BotSettings.descriptionHeader)
    }
  }
}

/// The personality (`SOUL.md`): an editor while this account may write, plain selectable text when it may not.
struct BotPersonalitySection: View {
  let handle: String
  @Bindable var model: BotSettingsModel
  let editable: Bool

  var body: some View {
    Section {
      if editable {
        TextEditor(text: $model.soulDraft)
          .font(.body)
          .frame(minHeight: 160)
          .scrollContentBackground(.hidden)
          .overlay(alignment: .topLeading) {
            if model.soulDraft.isEmpty {
              Text(NativeStrings.BotSettings.personalityEmpty)
                .foregroundStyle(.secondary)
                .padding(.top, 8)
                .padding(.leading, 5)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
          }
          .accessibilityLabel(NativeStrings.BotSettings.personality)
          .accessibilityIdentifier("hermie.botSettings.soul")
      } else {
        Text(verbatim: model.soulDraft.isEmpty ? NativeStrings.BotSettings.personalityEmpty : model.soulDraft)
          .foregroundStyle(model.soulDraft.isEmpty ? .secondary : .primary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }

      if model.soulIsDirty, editable {
        SaveRevertRow(
          busy: model.busy.contains(.soul),
          revert: { model.revertSoul() },
          save: { Task { await model.saveSoul() } }
        )
        .accessibilityIdentifier("hermie.botSettings.soul.save")
      }

      if let failure = model.failures[.soul] {
        FailureLine(failure: failure, handle: handle) { model.dismissFailure(.soul) }
      }
    } header: {
      Text(NativeStrings.BotSettings.personality)
    } footer: {
      SettingsNote(NativeStrings.BotSettings.personalityHint)
    }
  }
}

/// Revert on the left, Save on the right, and a spinner in place of Save's label while it writes.
struct SaveRevertRow: View {
  let busy: Bool
  let revert: () -> Void
  let save: () -> Void

  var body: some View {
    HStack {
      Button(NativeStrings.BotSettings.revert, action: revert)
        .buttonStyle(.borderless)
        .disabled(busy)

      Spacer()

      Button(action: save) {
        if busy {
          ProgressView().controlSize(.small)
        } else {
          Text(Strings.App.BotProfile.save)
        }
      }
      .buttonStyle(.borderedProminent)
      .disabled(busy)
    }
  }
}

// MARK: - Model

/// The model the bot uses and, where the gateway lists models, the way to change it.
struct BotModelSection: View {
  let chat: ChatRef
  let session: GatewaySession
  @Bindable var model: BotSettingsModel
  let editable: Bool

  var body: some View {
    let details = model.details
    let row = session.chatList.rows[chat.bot]?.bot
    let pin = details?.model ?? BotModelPin()
    let shownModel = pin.isPinned ? pin.model : (row?.model ?? "")
    let shownProvider = pin.isPinned ? pin.provider : (row?.provider ?? "")

    Section {
      LabeledContent(Strings.App.BotProfile.model) {
        Text(verbatim: shownModel.isEmpty ? NativeStrings.BotSettings.modelFollows : prettyModelName(shownModel))
          .multilineTextAlignment(.trailing)
      }

      LabeledContent(Strings.App.BotProfile.provider) {
        Text(verbatim: shownProvider.isEmpty ? Strings.App.BotProfile.unknown : shownProvider)
          .font(.body.monospaced())
      }

      if editable {
        switch model.modelChoices {
        case .loaded(let choices):
          NavigationLink {
            ModelPicker(model: model, choices: choices)
          } label: {
            HStack {
              Text(NativeStrings.BotSettings.modelChoose)
              if model.busy.contains(.model) {
                Spacer()
                ProgressView().controlSize(.small)
              }
            }
          }
          .accessibilityIdentifier("hermie.botSettings.model.choose")
        case .loading, .idle:
          HStack {
            Text(NativeStrings.BotSettings.modelChoose)
              .foregroundStyle(.secondary)
            Spacer()
            ProgressView().controlSize(.small)
          }
        case .unavailable:
          EmptyView()
        }
      }

      if let failure = model.failures[.model] {
        FailureLine(failure: failure, handle: chat.bot) { model.dismissFailure(.model) }
      }
    } header: {
      Text(Strings.Chat.Options.model)
    } footer: {
      if model.modelChoices == .unavailable {
        SettingsNote(NativeStrings.BotSettings.modelUnavailable)
      }
    }
  }
}

// MARK: - Tools

/// The toolsets, with what pinning them means said in words.
struct BotToolsetsSection: View {
  let handle: String
  @Bindable var model: BotSettingsModel
  let editable: Bool

  var body: some View {
    let details = model.details

    Section {
      ForEach(details?.toolsets ?? []) { toolset in
        Toggle(isOn: binding(toolset)) {
          VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: toolset.label)
            Text(verbatim: Self.detail(toolset))
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .disabled(!editable || (toolset.enabled && !model.canDisableToolset(toolset.name)))
        .accessibilityIdentifier("hermie.botSettings.toolset.\(toolset.name)")
      }

      if details?.toolsetsPinned == true, editable {
        Button(NativeStrings.BotSettings.followDefaults) {
          Task { await model.useDefaultToolsets() }
        }
        .disabled(model.busy.contains(.toolsets))
        .accessibilityIdentifier("hermie.botSettings.toolsets.defaults")
      }

      if let failure = model.failures[.toolsets] {
        FailureLine(failure: failure, handle: handle) { model.dismissFailure(.toolsets) }
      }
    } header: {
      Text(NativeStrings.BotSettings.toolsets)
    } footer: {
      SettingsNote(
        details?.toolsetsPinned == true
          ? Strings.Profiles.Capabilities.toolsetsPinned : Strings.Profiles.Capabilities.toolsetsUnpinned)
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

  var body: some View {
    let skills = model.details?.skills ?? []

    Section {
      if skills.isEmpty {
        Text(Strings.Profiles.Capabilities.skillsEmpty)
          .foregroundStyle(.secondary)
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
    } header: {
      Text(NativeStrings.BotSettings.skills)
    } footer: {
      SettingsNote(Strings.Profiles.Capabilities.skillsFooter)
    }
  }
}

/// The MCP servers, and the one line when a change has been applied to the running chats.
struct BotMcpSection: View {
  let handle: String
  @Bindable var model: BotSettingsModel
  let editable: Bool

  var body: some View {
    let servers = model.details?.mcpServers ?? []

    Section {
      if servers.isEmpty {
        Text(Strings.Profiles.Capabilities.mcpEmpty)
          .foregroundStyle(.secondary)
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
    } header: {
      Text(NativeStrings.BotSettings.mcp)
    } footer: {
      SettingsNote(Strings.Profiles.Capabilities.mcpFooter)
    }
  }
}

// MARK: - What the chat shows

/// Verbosity, thinking and bot-to-bot for the chat that is open, the same three the chat's own menu has.
struct BotChatViewSection: View {
  let chat: ChatModel

  var body: some View {
    let options = chat.visibility

    Section {
      Picker(
        Strings.Chat.Options.verbosity,
        selection: Binding(
          get: { options.level },
          set: {
            chat.setVisibility(
              VisibilityOptions(level: $0, showBotToBot: options.showBotToBot, showThinking: options.showThinking))
          }
        )
      ) {
        Text(Strings.Chat.Options.VerbosityOptions.quiet).tag(Verbosity.quiet)
        Text(Strings.Chat.Options.VerbosityOptions.normal).tag(Verbosity.normal)
        Text(Strings.Chat.Options.VerbosityOptions.verbose).tag(Verbosity.verbose)
      }
      .accessibilityIdentifier("hermie.botSettings.verbosity")

      Toggle(
        Strings.Chat.Options.showThinking,
        isOn: Binding(
          get: { options.showThinking },
          set: {
            chat.setVisibility(
              VisibilityOptions(level: options.level, showBotToBot: options.showBotToBot, showThinking: $0))
          }
        )
      )

      Toggle(
        Strings.Chat.Options.showBotToBot,
        isOn: Binding(
          get: { options.showBotToBot },
          set: {
            chat.setVisibility(
              VisibilityOptions(level: options.level, showBotToBot: $0, showThinking: options.showThinking))
          }
        )
      )
    } header: {
      Text(Strings.Chat.Options.viewHeader)
    }
  }
}

// MARK: - The list

/// Pin, mute and archive: the chat list's choices about this bot, which follow the person to their
/// other devices through the gateway's `ui_meta`.
struct BotChatListSection: View {
  let chat: ChatRef
  let session: GatewaySession
  let editable: Bool

  var body: some View {
    let arrangement = session.arrangement
    let name = chat.bot

    Section {
      Toggle(
        Strings.App.Layout.pinnedRow,
        isOn: Binding(get: { arrangement.isPinned(name) }, set: { arrangement.setPinned(name, $0) })
      )
      .accessibilityIdentifier("hermie.botSettings.pinned")

      if let until = arrangement.mutedUntil(name) {
        LabeledContent(ChatListFormat.mutedState(until)) {
          Button(Strings.App.Layout.unmute) { arrangement.setMute(name, until: nil) }
            .buttonStyle(.borderless)
        }
      } else {
        Menu(Strings.App.Layout.mute) {
          ForEach(MuteDuration.allCases, id: \.self) { duration in
            Button(ChatListFormat.muteTitle(duration)) { arrangement.mute(name, for: duration) }
          }
        }
        .accessibilityIdentifier("hermie.botSettings.mute")
      }

      Toggle(
        NativeStrings.ChatList.archivedTitle,
        isOn: Binding(get: { arrangement.isArchived(name) }, set: { arrangement.setArchived(name, $0) })
      )
      .accessibilityIdentifier("hermie.botSettings.archived")
    } header: {
      Text(NativeStrings.BotSettings.chatList)
    } footer: {
      if !editable {
        SettingsNote(NativeStrings.BotSettings.notSynced)
      }
    }
    .disabled(!editable)
  }
}

// MARK: - About

struct BotAboutSection: View {
  let chat: ChatRef
  let session: GatewaySession

  var body: some View {
    let canonical = session.chatList.rows[chat.bot]?.bot.canonical

    Section {
      LabeledContent(Strings.App.BotProfile.session) {
        Text(verbatim: canonical?.id ?? Strings.App.BotProfile.unknown)
          .font(.callout.monospaced())
          .textSelection(.enabled)
          .multilineTextAlignment(.trailing)
      }
    } header: {
      Text(NativeStrings.BotSettings.about)
    }
  }
}
