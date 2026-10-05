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
  #if DEBUG
    @Environment(AppLaunch.self) private var launch: AppLaunch?
  #endif

  var body: some View {
    let current = model.details?.model ?? BotModelPin()

    List {
      ForEach(ModelChoiceList.sections(of: ModelChoiceList.matching(choices, query: query))) { section in
        Section {
          ForEach(section.choices) { choice in
            Button {
              pick(choice)
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
    .modifier(ModelSearch(query: $query))
    .navigationTitle(Strings.Chat.Options.model)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    #if DEBUG
      .task {
        // `-HermieSelectModel`: a tap on that model's row, a moment after the page is up.
        guard let wanted = launch?.environment.testHooks?.selectModel,
          let choice = choices.first(where: { $0.model == wanted })
        else { return }

        fputs("hermie-drill: picker is up, choosing \(choice.id)\n", stderr)
        try? await Task.sleep(for: .seconds(2))
        pick(choice)
        fputs("hermie-drill: chose \(choice.id)\n", stderr)
      }
    #endif
  }

  /// Choosing a model pins the bot to it and goes back.
  private func pick(_ choice: BotModelChoice) {
    Task { await model.chooseModel(choice) }
    dismiss()
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

/**
 Where the picker's search field goes.

 On the Mac a `.searchable` on a page pushed in the detail column asks the window's one `NSToolbar`
 for a search item, while the chat list in the sidebar already holds one. Two search items in one
 toolbar make AppKit raise an exception while it inserts the second (`-[NSToolbar
 _insertNewItemWithItemIdentifier:…]`, from SwiftUI's toolbar update), which is not caught and ends
 the app, on the layout pass that opens the picker. So on the Mac the field is a row of the page itself;
 on iPhone and iPad the navigation bar's own search field is used, which has no such neighbour.
 */
enum ModelSearchPlacement: Equatable {
  /// The navigation bar's search field (`.searchable`).
  case navigationBar
  /// A field above the list, part of the page and nothing the window's toolbar knows about.
  case inline

  static var current: ModelSearchPlacement {
    #if os(macOS)
      .inline
    #else
      .navigationBar
    #endif
  }
}

/// A search field in the place `ModelSearchPlacement` says: the model picker's, and the capability
/// pages' (toolsets, skills, MCP servers), which are long enough to need one.
struct ModelSearch: ViewModifier {
  @Binding var query: String
  var prompt: String = Strings.Chat.Options.modelSearch
  var identifier = "hermie.botSettings.model.search"
  /// Whether the field is drawn at all (a short list needs none).
  var enabled = true

  @ViewBuilder func body(content: Content) -> some View {
    if !enabled {
      content
    } else {
      switch ModelSearchPlacement.current {
      case .navigationBar:
        content.searchable(text: $query, prompt: prompt)
      case .inline:
        content.safeAreaInset(edge: .top, spacing: 0) {
          HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
              .foregroundStyle(.secondary)
              .accessibilityHidden(true)
            TextField(prompt, text: $query)
              .textFieldStyle(.plain)
              .accessibilityIdentifier(identifier)
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 7)
          .background(.quaternary, in: .rect(cornerRadius: 8))
          .padding(.horizontal)
          .padding(.vertical, 8)
        }
      }
    }
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

  /// Whether this is the model the bot is pinned to: the same provider and the same id, as the
  /// gateway stored it.
  static func isCurrent(_ choice: BotModelChoice, pin: BotModelPin) -> Bool {
    pin.isPinned && pin.provider == choice.provider && pin.model == choice.model
  }
}
