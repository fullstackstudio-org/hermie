import HermieCore
import SwiftUI

/**
 The prompt button's list: the prompts offered in this chat, the bot's own first, then the ones for every
 bot. Picking one is `ComposerModel.use(_:)`: it goes into the message field (after its form, when it
 has fields), and nothing is sent.

 The pick is handed back through `pick` and acted on once the sheet has gone (`ComposerView`'s
 `onDismiss`): a second sheet raised while the first is still leaving is dropped by the system.
 */
struct PromptPickerSheet: View {
  let model: ComposerModel
  /// Called with the prompt that was chosen; the sheet closes itself.
  let pick: (Prompt) -> Void

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let own = model.prompts?.prompts(of: model.bot) ?? []
    let shared = model.prompts?.global ?? []

    NavigationStack {
      List {
        if own.isEmpty && shared.isEmpty {
          Text(NativeStrings.Prompts.Composer.empty)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("composer.prompts.empty")
        }

        if !own.isEmpty {
          Section(NativeStrings.Prompts.forBot(model.botDisplayName)) {
            rows(own)
          }
        }

        if !shared.isEmpty {
          Section(NativeStrings.Prompts.global) {
            rows(shared)
          }
        }
      }
      .navigationTitle(NativeStrings.Prompts.Composer.button)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(role: .close) { dismiss() }
            .accessibilityIdentifier("composer.prompts.close")
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 380, idealWidth: 420, minHeight: 320, idealHeight: 420)
    #endif
    .accessibilityIdentifier("composer.prompts.sheet")
  }

  private func rows(_ prompts: [Prompt]) -> some View {
    ForEach(prompts) { prompt in
      Button {
        pick(prompt)
        dismiss()
      } label: {
        PromptRow(prompt: prompt)
      }
      .buttonStyle(.plain)
      .accessibilityHint(NativeStrings.Prompts.Composer.insertHint)
      .accessibilityIdentifier("composer.prompts.row.\(prompt.id)")
    }
  }
}

/**
 The form a prompt with fields asks for: one line for each field, named as the prompt names it, and
 what the prompt will say below, as it fills in. Insert puts the filled-in text in the message field
 (nothing is sent); a field left empty fills in as nothing.
 */
struct PromptFillSheet: View {
  let prompt: Prompt
  let insert: ([String: String]) -> Void
  let cancel: () -> Void

  @State private var values: [String: String] = [:]
  @FocusState private var focused: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          ForEach(prompt.fields, id: \.self) { name in
            TextField(
              name,
              text: Binding(get: { values[name] ?? "" }, set: { values[name] = $0 }),
              axis: .vertical
            )
            .lineLimit(1...6)
            .focused($focused, equals: name)
            .accessibilityIdentifier("composer.prompts.field.\(name)")
          }
        } header: {
          Text(verbatim: prompt.title)
        }

        Section {
          Text(verbatim: prompt.filled(with: values))
            .font(.callout)
            .foregroundStyle(.secondary)
            .lineLimit(8)
            .textSelection(.enabled)
            .accessibilityIdentifier("composer.prompts.preview")
        } header: {
          Text(NativeStrings.Prompts.preview)
        }
      }
      .formStyle(.grouped)
      .navigationTitle(NativeStrings.Prompts.fillTitle)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.cancel, action: cancel)
            .accessibilityIdentifier("composer.prompts.cancel")
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(NativeStrings.Prompts.insert) { insert(values) }
            .keyboardShortcut(.defaultAction)
            .accessibilityIdentifier("composer.prompts.insert")
        }
      }
      .onAppear { focused = prompt.fields.first }
    }
    #if os(macOS)
      .frame(minWidth: 420, idealWidth: 460, minHeight: 360, idealHeight: 420)
    #endif
    .accessibilityIdentifier("composer.prompts.fill")
  }
}
