import HermieCore
import SwiftUI

/// The commands that could follow what is typed, in a card above the message field while the field
/// holds a command being written (`ComposerModel.suggestionsOpen`).
///
/// Each line is the command, what it takes, and what the gateway says it does. On the Mac the arrow
/// keys move and Return or Tab take the line, Esc closes the list (`ComposerTextField` hands the
/// keys to `ComposerModel.handle(_:)`); on iPhone and iPad a tap takes the line. Taking one puts it
/// in the field and the list moves on to what could follow it. Under the lines, what the command
/// being filled in takes (`/model [model]`).
///
/// Everything the gateway wrote here (names, descriptions, usage lines) is plain text.
struct SlashCompletionList: View {
  let model: ComposerModel
  /// Called after a line is taken by a tap or a click: the caret goes back to the field.
  let onAccept: () -> Void

  /// Eight lines or so, then the list scrolls: a bot with fifty skills would otherwise fill the chat.
  static let maxListHeight: CGFloat = 232

  @State private var contentHeight: CGFloat = 44

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !model.suggestions.isEmpty {
        list
      } else if let failure = model.suggestionsFailure {
        note(Strings.Chat.Composer.slashUnavailable(method: failure))
      } else if model.suggestionsLoading {
        note(Strings.Chat.Composer.slashLoading)
      }

      if let hint = model.argumentHint {
        if !model.suggestions.isEmpty {
          Divider().padding(.horizontal, 10)
        }

        hintRow(hint)
      }
    }
    .padding(.vertical, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .glassEffect(.regular.tint(ComposerView.fieldTint), in: .rect(cornerRadius: 16))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Strings.Chat.Composer.slashHint)
    .accessibilityIdentifier("composer.commands")
  }

  // MARK: The lines

  private var list: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(model.suggestions.enumerated()), id: \.element.id) { index, item in
            row(item, index: index)
          }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
      }
      .scrollBounceBehavior(.basedOnSize)
      .frame(height: min(max(contentHeight, 1), Self.maxListHeight))
      .onChange(of: model.selectedSuggestion) { _, index in
        if model.suggestions.indices.contains(index) {
          proxy.scrollTo(model.suggestions[index].id)
        }
      }
    }
  }

  private func row(_ item: SlashSuggestion, index: Int) -> some View {
    let selected = index == model.selectedSuggestion

    return Button {
      model.acceptSuggestion(at: index)
      onAccept()
    } label: {
      VStack(alignment: .leading, spacing: 1) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(verbatim: item.label)
            .font(.callout.weight(.semibold))
          if let hint = item.hint {
            Text(verbatim: hint)
              .font(.callout.monospaced())
              .foregroundStyle(.secondary)
          }
          if let alias = item.alias {
            Text(verbatim: alias)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          if item.kind == .skill {
            Text(NativeStrings.Composer.Commands.skill)
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.secondary)
              .padding(.horizontal, 5)
              .padding(.vertical, 1)
              .background(.fill.tertiary, in: .capsule)
          }
          Spacer(minLength: 0)
        }

        if !item.detail.isEmpty {
          Text(verbatim: item.detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        selected ? AnyShapeStyle(Color.accentColor.opacity(0.18)) : AnyShapeStyle(.clear),
        in: .rect(cornerRadius: 10))
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .id(item.id)
    .padding(.horizontal, 4)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Self.spoken(item))
    .accessibilityHint(NativeStrings.Composer.Commands.insertHint)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("composer.command.\(index)")
  }

  private func note(_ text: String) -> some View {
    Text(verbatim: text)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func hintRow(_ hint: SlashArgumentHint) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(verbatim: hint.command)
          .font(.callout.weight(.semibold))
        if let usage = hint.usage {
          Text(verbatim: usage)
            .font(.callout.monospaced())
            .foregroundStyle(.secondary)
        }
      }

      if !hint.summary.isEmpty {
        Text(verbatim: hint.summary)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("composer.commands.hint")
  }

  /// What VoiceOver reads for a line: the name, what it takes, what it does.
  static func spoken(_ item: SlashSuggestion) -> String {
    [item.label, item.hint, item.detail]
      .compactMap { $0 }
      .filter { !$0.isEmpty }
      .joined(separator: ", ")
  }
}
