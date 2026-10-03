import HermieCore
import HermieTranscript
import SwiftUI

/**
 The models the gateway offers, one section per provider, with a search. Choosing one pins the bot
 to it and goes back; a guarded model (an expensive one) asks first, on the page behind this one.

 Every name here is the gateway's and untrusted: plain text.
 */
struct ModelPicker: View {
  @Bindable var model: BotSettingsModel
  let choices: [BotModelChoice]

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  var body: some View {
    let current = model.details?.model ?? BotModelPin()

    List {
      ForEach(ModelChoiceList.sections(of: ModelChoiceList.matching(choices, query: query))) { section in
        Section {
          ForEach(section.choices) { choice in
            Button {
              Task { await model.chooseModel(choice) }
              dismiss()
            } label: {
              row(choice, current: ModelChoiceList.isCurrent(choice, pin: current))
            }
            .foregroundStyle(.primary)
            .accessibilityIdentifier("hermie.botSettings.model.\(choice.id)")
          }
        } header: {
          Text(verbatim: section.name)
        }
      }
    }
    .searchable(text: $query, prompt: Strings.Chat.Options.modelSearch)
    .navigationTitle(Strings.Chat.Options.model)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
  }

  private func row(_ choice: BotModelChoice, current: Bool) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: prettyModelName(choice.model))
        Text(verbatim: choice.model)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
      }

      Spacer(minLength: 0)

      if current {
        Image(systemName: "checkmark")
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
      }
    }
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(current ? .isSelected : [])
  }
}

/// What the picker lists: pure functions over the gateway's choices, apart from the view so they run
/// anywhere.
enum ModelChoiceList {
  struct ProviderSection: Identifiable, Equatable {
    var id: String
    var name: String
    var choices: [BotModelChoice]
  }

  /// The choices a search lets through: the model's id, its pretty name or its provider's name.
  static func matching(_ choices: [BotModelChoice], query: String) -> [BotModelChoice] {
    let words = query.lowercased().split(separator: " ").map(String.init)

    guard !words.isEmpty else {
      return choices
    }

    return choices.filter { choice in
      let haystack = [choice.model, prettyModelName(choice.model), choice.providerName, choice.provider]
        .joined(separator: " ").lowercased()

      return words.allSatisfy { haystack.contains($0) }
    }
  }

  /// One section per provider, in the order the gateway lists them.
  static func sections(of choices: [BotModelChoice]) -> [ProviderSection] {
    var sections: [ProviderSection] = []

    for choice in choices {
      if let index = sections.firstIndex(where: { $0.id == choice.provider }) {
        sections[index].choices.append(choice)
      } else {
        sections.append(ProviderSection(id: choice.provider, name: choice.providerName, choices: [choice]))
      }
    }

    return sections
  }

  /// Whether this is the model the bot is pinned to. The gateway stores the bare model id, so both
  /// spellings count.
  static func isCurrent(_ choice: BotModelChoice, pin: BotModelPin) -> Bool {
    guard pin.isPinned, pin.provider == choice.provider else {
      return false
    }

    return pin.model == choice.model || pin.model == choice.qualified
  }
}
