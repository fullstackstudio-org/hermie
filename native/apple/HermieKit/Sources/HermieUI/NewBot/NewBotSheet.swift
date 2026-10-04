import HermieCore
import HermieTranscript
import SwiftUI

/**
 The New bot sheet (`NewBotFlow` and `NewBotSheet` in the Expo app): a handle, an optional name of the
 reader's own, a description, a model, and a bot to copy the settings of. The handle is checked while
 it is typed, against what the gateway will accept (`ProfileName`); everything else the gateway checks
 again when it is asked.

 It is the one way to make a bot, and every entry point opens it through the router (`AppSheet.newBot`):
 the chat list's button and the File menu. When the bot is made its chat is opened, as a tap on its row
 would. A bot the gateway could not give a model asks first, on a page of its own, instead of opening a
 chat that can only answer with an error.

 It reads the live session from the environment. With no live session it says so.
 */
struct NewBotSheet: View {
  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(AppRouter.self) private var router: AppRouter?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      if let live, let session = live.session, let gatewayID = live.gatewayID {
        NewBotForm(session: session) { created in
          router?.openChat(ChatRef(gatewayId: gatewayID, bot: created.name))
          dismiss()
        }
        .id(ObjectIdentifier(session))
      } else {
        EmptyState(
          Strings.Profiles.New.title,
          systemImage: "person.crop.circle.badge.plus",
          message: Text(NativeStrings.NewBot.offline)
        ) {
          Button(Strings.Profiles.New.cancel) { dismiss() }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 460, minHeight: 520)
    #endif
    .accessibilityIdentifier("hermie.newBot")
  }
}

/// The form over one session.
struct NewBotForm: View {
  let session: GatewaySession
  /// A bot was made and its chat is to be opened.
  let opened: (NewBotModel.Created) -> Void

  @State private var model: NewBotModel
  @State private var touched = false
  @FocusState private var handleFocused: Bool
  @Environment(\.dismiss) private var dismiss

  init(session: GatewaySession, opened: @escaping (NewBotModel.Created) -> Void) {
    self.session = session
    self.opened = opened
    _model = State(initialValue: session.newBot())
  }

  var body: some View {
    Group {
      if let created = model.created, created.withoutModel {
        withoutModelPage(created)
      } else {
        form
      }
    }
    .navigationTitle(Strings.Profiles.New.title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .task { await model.loadModelChoices() }
  }

  // MARK: Form

  private var form: some View {
    Form {
      handleSection
      nameSection
      descriptionSection
      modelSection
      cloneSection

      if let failure = model.failure {
        Section {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(.red)
              .accessibilityHidden(true)
            Text(verbatim: NewBotText.failure(failure))
              .font(.callout)
              .fixedSize(horizontal: false, vertical: true)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("hermie.newBot.error")
        }
      }
    }
    .formStyle(.grouped)
    .disabled(model.creating)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button(Strings.Profiles.New.cancel) { dismiss() }
          .disabled(model.creating)
          .accessibilityIdentifier("hermie.newBot.cancel")
      }

      ToolbarItem(placement: .confirmationAction) {
        if model.creating {
          ProgressView()
            .controlSize(.small)
            .accessibilityLabel(Strings.Profiles.New.creating)
        } else {
          Button(Strings.Profiles.New.create) { submit() }
            .disabled(!model.verdict.isValid)
            .accessibilityIdentifier("hermie.newBot.create")
        }
      }
    }
    .interactiveDismissDisabled(model.creating)
    .onAppear { handleFocused = true }
  }

  private var handleSection: some View {
    let verdict = model.verdict
    let showProblem = (touched || !model.handleText.isEmpty) ? verdict.problem : nil

    return Section {
      TextField(
        Strings.Profiles.New.handle, text: $model.handleText,
        prompt: Text(Strings.Profiles.New.handlePlaceholder)
      )
      .focused($handleFocused)
      .autocorrectionDisabled()
      .onSubmit { submit() }
      #if os(iOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.asciiCapable)
      #endif
      .accessibilityIdentifier("hermie.newBot.handle")

      if let problem = showProblem {
        Text(verbatim: NewBotText.problem(problem))
          .font(.footnote)
          .foregroundStyle(.red)
          .accessibilityIdentifier("hermie.newBot.handleProblem")
      }
    } footer: {
      Text(verbatim: verdict.warning.map(NewBotText.warning) ?? Strings.Profiles.New.handleHint)
    }
  }

  private var nameSection: some View {
    Section {
      TextField(
        Strings.Profiles.New.displayName, text: $model.displayName,
        prompt: Text(Strings.Profiles.New.displayNamePlaceholder)
      )
      .accessibilityIdentifier("hermie.newBot.displayName")
    } footer: {
      Text(Strings.Profiles.New.displayNameHint)
    }
  }

  private var descriptionSection: some View {
    Section {
      TextField(
        Strings.Profiles.New.description, text: $model.botDescription,
        prompt: Text(Strings.Profiles.New.descriptionPlaceholder), axis: .vertical
      )
      .lineLimit(2...5)
      .accessibilityIdentifier("hermie.newBot.description")
    }
  }

  @ViewBuilder private var modelSection: some View {
    if case .loaded(let choices) = model.modelChoices {
      Section {
        NavigationLink {
          NewBotModelPicker(model: model, choices: choices)
        } label: {
          LabeledContent(Strings.Profiles.New.model) {
            Text(verbatim: model.model.map { prettyModelName($0.model) } ?? Strings.Profiles.New.modelInherit)
          }
        }
        .accessibilityIdentifier("hermie.newBot.model")
      } footer: {
        Text(Strings.Profiles.New.modelHint)
      }
    }
  }

  @ViewBuilder private var cloneSection: some View {
    if !model.cloneable.isEmpty {
      Section {
        Picker(Strings.Profiles.New.cloneFrom, selection: $model.cloneFrom) {
          Text(Strings.Profiles.New.cloneNone).tag(String?.none)

          ForEach(model.cloneable, id: \.self) { name in
            Text(verbatim: session.chatName(name)).tag(String?.some(name))
          }
        }
        .accessibilityIdentifier("hermie.newBot.clone")
      } footer: {
        Text(Strings.Profiles.New.cloneHint)
      }
    }
  }

  // MARK: Done

  /// The bot exists and has nowhere to send a message: said before its chat opens.
  private func withoutModelPage(_ created: NewBotModel.Created) -> some View {
    EmptyState(
      NativeStrings.NewBot.ready(session.chatName(created.name)),
      systemImage: "checkmark.circle",
      message: Text(Strings.Profiles.New.withoutModel)
    ) {
      Button(NativeStrings.NewBot.openChat) { opened(created) }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("hermie.newBot.openChat")
    }
  }

  private func submit() {
    touched = true

    guard model.canCreate else {
      return
    }

    Task {
      if let created = await model.create(), !created.withoutModel {
        opened(created)
      }
    }
  }
}

/// The models the gateway offers, one section per provider, with a search, and "Inherit" first.
/// Choosing one goes back. Every name is the gateway's and untrusted: plain text.
struct NewBotModelPicker: View {
  @Bindable var model: NewBotModel
  let choices: [BotModelChoice]

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  var body: some View {
    List {
      if query.isEmpty {
        Button {
          model.model = nil
          dismiss()
        } label: {
          row(Strings.Profiles.New.modelInherit, detail: nil, selected: model.model == nil)
        }
        .foregroundStyle(.primary)
        .accessibilityIdentifier("hermie.newBot.model.inherit")
      }

      ForEach(ModelChoiceList.sections(of: ModelChoiceList.matching(choices, query: query))) { section in
        Section {
          ForEach(section.choices) { choice in
            Button {
              model.model = choice
              dismiss()
            } label: {
              row(prettyModelName(choice.model), detail: choice.model, selected: model.model == choice)
            }
            .foregroundStyle(.primary)
            .accessibilityIdentifier("hermie.newBot.model.\(choice.id)")
          }
        } header: {
          Text(verbatim: section.name)
        }
      }
    }
    .modifier(ModelSearch(query: $query))
    .navigationTitle(Strings.Profiles.New.model)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
  }

  private func row(_ title: String, detail: String?, selected: Bool) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: title)

        if let detail {
          Text(verbatim: detail)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
        }
      }

      Spacer(minLength: 0)

      if selected {
        Image(systemName: "checkmark")
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
      }
    }
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}
