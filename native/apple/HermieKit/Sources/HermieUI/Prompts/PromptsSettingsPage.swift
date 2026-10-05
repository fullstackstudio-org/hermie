import HermieCore
import SwiftUI

/**
 Settings, Prompts: the person's reusable prompts for every bot, and one row per bot of the live
 gateway that opens that bot's own (NX-13).

 A prompt is a title and a text with `{{fields}}` in it; the composer's button and the list `/` opens
 offer them, and a field is asked for in a small form when the prompt is used. They live in the
 person's own ui_meta, so they follow them to their other devices on this gateway, and are edited here,
 added, deleted and put in the order the composer lists them in.
 */
struct PromptsSettingsEntry: View {
  var body: some View {
    CapabilityHost(identifier: "hermie.prompts.page") { session in
      PromptsSettingsContent(session: session)
    }
  }
}

struct PromptsSettingsContent: View {
  let session: GatewaySession

  var body: some View {
    let model = session.prompts

    Form {
      PromptListSection(model: model, scope: .global, header: NativeStrings.Prompts.global)

      Section {
        ForEach(session.chatList.names, id: \.self) { bot in
          NavigationLink {
            BotPromptsPage(session: session, bot: bot)
          } label: {
            LabeledContent {
              Text(verbatim: PromptWords.count(model.count(of: bot)))
                .foregroundStyle(.secondary)
            } label: {
              Text(verbatim: session.chatName(bot))
            }
          }
          .accessibilityIdentifier("hermie.prompts.bot.\(bot)")
        }
      } header: {
        Text(NativeStrings.Prompts.perBot)
      } footer: {
        SettingsNote(NativeStrings.Prompts.syncNote)
      }
    }
    .formStyle(.grouped)
    #if os(iOS)
      .toolbar { EditButton() }
    #endif
    .navigationTitle(NativeStrings.Prompts.title)
    .accessibilityIdentifier("hermie.prompts.page")
  }
}

/// A bot's own prompts, as a page of its own: reached from its settings and from the Prompts category.
struct BotPromptsPage: View {
  let session: GatewaySession
  let bot: String

  var body: some View {
    let model = session.prompts

    Form {
      PromptListSection(model: model, scope: .bot(bot), header: NativeStrings.Prompts.forBot(session.chatName(bot)))

      if !model.global.isEmpty {
        Section {
          Text(NativeStrings.Prompts.alsoGlobal(model.global.count))
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("hermie.prompts.alsoGlobal")
        }
      }
    }
    .formStyle(.grouped)
    #if os(iOS)
      .toolbar { EditButton() }
    #endif
    .navigationTitle(session.chatName(bot))
    .accessibilityIdentifier("hermie.prompts.botPage")
  }
}

/// A bot's Prompts, on its settings page: one row, in the style of the capability rows, that says how
/// many it has of its own and opens them (`BotPromptsPage`).
struct BotPromptsSection: View {
  let chat: ChatRef
  let session: GatewaySession

  var body: some View {
    Section {
      NavigationLink {
        BotPromptsPage(session: session, bot: chat.bot)
      } label: {
        LabeledContent {
          Text(verbatim: PromptWords.count(session.prompts.count(of: chat.bot)))
            .foregroundStyle(.secondary)
        } label: {
          Label(NativeStrings.Prompts.title, systemImage: "text.quote")
        }
      }
      .accessibilityIdentifier("hermie.botSettings.prompts")
    }
  }
}

enum PromptWords {
  /// What a row says on the right: the number, or None.
  static func count(_ count: Int) -> String {
    count == 0 ? NativeStrings.BotSettings.summaryNone : "\(count)"
  }
}

// MARK: - One scope's list

/// What the editor was opened for.
private enum PromptEditing: Identifiable {
  case new
  case edit(Prompt)

  var id: String {
    switch self {
    case .new: "new"
    case .edit(let prompt): prompt.id
    }
  }
}

/// The prompts of one scope: add, edit, delete and reorder.
struct PromptListSection: View {
  let model: PromptsModel
  let scope: PromptScope
  let header: String

  @State private var editing: PromptEditing?
  @State private var deleting: Prompt?

  var body: some View {
    let list = model.prompts(in: scope)

    Section {
      if list.isEmpty {
        Text(NativeStrings.Prompts.none)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("hermie.prompts.none")
      }

      ForEach(list) { prompt in
        Button {
          editing = .edit(prompt)
        } label: {
          PromptRow(prompt: prompt)
        }
        .buttonStyle(.plain)
        .contextMenu { actions(for: prompt, in: list) }
        #if os(iOS)
          .swipeActions {
            Button(NativeStrings.Prompts.delete, systemImage: "trash", role: .destructive) {
              deleting = prompt
            }
          }
        #endif
        .accessibilityActions { actions(for: prompt, in: list) }
        .accessibilityIdentifier("hermie.prompts.row.\(prompt.id)")
      }
      .onMove { source, destination in
        guard let from = source.first, list.indices.contains(from) else {
          return
        }

        model.move(id: list[from].id, toIndex: destination > from ? destination - 1 : destination)
      }

      Button(NativeStrings.Prompts.add, systemImage: "plus") {
        editing = .new
      }
      .disabled(!model.canAdd)
      .accessibilityIdentifier("hermie.prompts.add")
    } header: {
      Text(header)
    } footer: {
      if !model.canEdit {
        SettingsNote(NativeStrings.Prompts.notReady)
      } else if model.prompts.count >= PromptLibrary.maxPrompts {
        SettingsNote(NativeStrings.Prompts.limit(PromptLibrary.maxPrompts))
      }
    }
    .sheet(item: $editing) { target in
      switch target {
      case .new:
        PromptEditorSheet(model: model, scope: scope, prompt: nil)
      case .edit(let prompt):
        PromptEditorSheet(model: model, scope: scope, prompt: prompt)
      }
    }
    .confirmationDialog(
      NativeStrings.Prompts.deleteConfirm,
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
      titleVisibility: .visible,
      presenting: deleting
    ) { prompt in
      Button(NativeStrings.Prompts.delete, role: .destructive) {
        model.remove(id: prompt.id)
      }
      Button(Strings.App.Common.cancel, role: .cancel) {}
    }
  }

  @ViewBuilder
  private func actions(for prompt: Prompt, in list: [Prompt]) -> some View {
    let position = list.firstIndex(of: prompt) ?? 0

    Button(NativeStrings.Prompts.edit, systemImage: "pencil") {
      editing = .edit(prompt)
    }

    if position > 0 {
      Button(NativeStrings.Prompts.moveUp, systemImage: "arrow.up") {
        model.step(id: prompt.id, by: -1)
      }
    }

    if position < list.count - 1 {
      Button(NativeStrings.Prompts.moveDown, systemImage: "arrow.down") {
        model.step(id: prompt.id, by: 1)
      }
    }

    Button(NativeStrings.Prompts.delete, systemImage: "trash", role: .destructive) {
      deleting = prompt
    }
  }
}

/// One prompt in a list: its title, the first line of its text, and the fields it asks for.
struct PromptRow: View {
  let prompt: Prompt

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: prompt.title)
        .foregroundStyle(Color.primary)

      Text(verbatim: PromptWords.preview(prompt.text))
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)

      if !prompt.fields.isEmpty {
        Text(verbatim: PromptWords.fieldList(prompt.fields))
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
  }
}

extension PromptWords {
  /// The first line of a prompt's text, short.
  static func preview(_ text: String) -> String {
    let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""

    return String(line.trimmingCharacters(in: .whitespaces).prefix(80))
  }

  /// `{topic} {tone}`
  static func fieldList(_ fields: [String]) -> String {
    fields.map { "{\($0)}" }.joined(separator: " ")
  }
}

// MARK: - The editor

/// A prompt's title and text, for a new one or an existing one. The fields the text asks for are listed
/// as it is typed, so a misspelt brace is seen before it is saved.
struct PromptEditorSheet: View {
  let model: PromptsModel
  let scope: PromptScope
  let prompt: Prompt?

  @Environment(\.dismiss) private var dismiss
  @State private var title: String
  @State private var text: String
  @FocusState private var focused: Field?

  private enum Field {
    case title
    case text
  }

  init(model: PromptsModel, scope: PromptScope, prompt: Prompt?) {
    self.model = model
    self.scope = scope
    self.prompt = prompt
    _title = State(initialValue: prompt?.title ?? "")
    _text = State(initialValue: prompt?.text ?? "")
  }

  private var fields: [String] { PromptTemplate.fields(in: text) }

  private var canSave: Bool { PromptLibrary.cleaned(title: title, text: text) != nil }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField(
            NativeStrings.Prompts.fieldTitle, text: $title, prompt: Text(NativeStrings.Prompts.titlePlaceholder)
          )
          .focused($focused, equals: .title)
          .submitLabel(.next)
          .onSubmit { focused = .text }
          .accessibilityIdentifier("hermie.prompts.editor.title")
        }

        Section {
          TextEditor(text: $text)
            .frame(minHeight: 160)
            .focused($focused, equals: .text)
            .accessibilityLabel(NativeStrings.Prompts.fieldText)
            .accessibilityIdentifier("hermie.prompts.editor.text")
        } header: {
          Text(NativeStrings.Prompts.fieldText)
        } footer: {
          VStack(alignment: .leading, spacing: 6) {
            SettingsNote(NativeStrings.Prompts.help)

            if !fields.isEmpty {
              SettingsNote(NativeStrings.Prompts.fields(PromptWords.fieldList(fields)))
                .accessibilityIdentifier("hermie.prompts.editor.fields")
            }
          }
        }
      }
      .formStyle(.grouped)
      .navigationTitle(prompt == nil ? NativeStrings.Prompts.new : NativeStrings.Prompts.edit)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.cancel) { dismiss() }
            .accessibilityIdentifier("hermie.prompts.editor.cancel")
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(NativeStrings.Prompts.save, action: save)
            .disabled(!canSave)
            .accessibilityIdentifier("hermie.prompts.editor.save")
        }
      }
      .onAppear { focused = prompt == nil ? .title : .text }
    }
    #if os(macOS)
      .frame(minWidth: 460, idealWidth: 500, minHeight: 440, idealHeight: 480)
    #endif
    .accessibilityIdentifier("hermie.prompts.editor")
  }

  private func save() {
    if var existing = prompt {
      existing.title = title
      existing.text = text
      model.update(existing)
    } else {
      model.add(title: title, text: text, scope: scope)
    }

    dismiss()
  }
}
