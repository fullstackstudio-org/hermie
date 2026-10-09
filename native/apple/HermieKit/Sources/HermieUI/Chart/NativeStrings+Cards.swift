import Foundation
import HermieMarkdown
import SwiftUI

/// The words of a `hermie-cards` block and of the callouts, from `Resources/Native.xcstrings`
/// (`native.cards.*`, `native.alert.*`, `native.block.*`). The Markdown target owns no string catalog, so it
/// takes them through its environment (`markdownCardsLabels`, `markdownAlertLabels`).
extension NativeStrings {
  enum Cards {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// More options (the "..." button in the corner of a drawn block)
    static var moreOptions: String { string("native.block.moreOptions") }
    /// Cards
    static var label: String { string("native.cards.label") }
    /// Show source
    static var showSource: String { string("native.cards.showSource") }
    /// Show cards
    static var showCards: String { string("native.cards.showCards") }
    /// Copy source
    static var copySource: String { string("native.cards.copySource") }
    /// Copied
    static var copied: String { string("native.cards.copied") }
    /// highlighted
    static var highlighted: String { string("native.cards.highlighted") }

    /// Card {position} of {total}, {title}
    static func card(_ position: Int, _ total: Int, _ title: String) -> String {
      String(
        localized: "native.cards.card", defaultValue: "Card \(position) of \(total), \(title)", table: "Native",
        bundle: .module)
    }
    /// tags {tags}
    static func tags(_ tags: String) -> String {
      String(localized: "native.cards.tags", defaultValue: "tags \(tags)", table: "Native", bundle: .module)
    }
    /// then: {label}
    static func then(_ label: String) -> String {
      String(localized: "native.cards.then", defaultValue: "then: \(label)", table: "Native", bundle: .module)
    }
  }

  enum Alert {
    /// Note / Tip / Important / Warning / Caution
    static func name(_ kind: MarkdownAlertKind) -> String {
      switch kind {
      case .note: String(localized: "native.alert.note", table: "Native", bundle: .module)
      case .tip: String(localized: "native.alert.tip", table: "Native", bundle: .module)
      case .important: String(localized: "native.alert.important", table: "Native", bundle: .module)
      case .warning: String(localized: "native.alert.warning", table: "Native", bundle: .module)
      case .caution: String(localized: "native.alert.caution", table: "Native", bundle: .module)
      }
    }
  }
}

extension MarkdownCardsLabels {
  /// The labels in the reader's language. Read when a block is drawn (a view's body), never at import: a
  /// language switch has to reach the next one.
  @MainActor static var localized: MarkdownCardsLabels {
    MarkdownCardsLabels(
      name: NativeStrings.Cards.label,
      words: HermieCardsSpeech.Words(
        card: { NativeStrings.Cards.card($0, $1, $2) },
        highlighted: NativeStrings.Cards.highlighted,
        tags: { NativeStrings.Cards.tags($0) },
        then: { NativeStrings.Cards.then($0) }),
      copySource: NativeStrings.Cards.copySource,
      moreOptions: NativeStrings.Cards.moreOptions,
      code: MarkdownCodeStrings(
        copy: NativeStrings.Cards.copySource, copied: NativeStrings.Cards.copied,
        showSource: NativeStrings.Cards.showSource, showRendered: NativeStrings.Cards.showCards))
  }
}

extension MarkdownAlertLabels {
  @MainActor static var localized: MarkdownAlertLabels {
    MarkdownAlertLabels { NativeStrings.Alert.name($0) }
  }
}
