import HermieMarkdown
import HermieTranscript
import SwiftUI

/// A person's turn. The owner's own turns sit on the trailing side in the app's
/// tint; in a shared chat a turn by someone else sits on the leading side with
/// their name and initial, coloured by their author id (never by name, which
/// two people can share).
///
/// The chat is shared when the item carries an `author` that is not the owner;
/// the builder tells the view whether this turn opens a run by its author, so
/// the name shows once per run.
struct UserBubbleView: View {
  let item: UserItem
  let presentation: Presentation
  let markdown: MarkdownDocument?
  let opensAuthorRun: Bool

  @Environment(\.transcriptItemActions) private var actions
  @Environment(\.transcriptOwnAuthorID) private var ownAuthorID
  @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 28

  /// Someone other than the owner wrote this.
  private var foreignAuthor: MessageAuthor? {
    guard let author = item.author, let ownAuthorID, author.id != ownAuthorID else { return nil }
    return author
  }

  var body: some View {
    switch presentation {
    case .hiddenPlaceholder:
      EmptyView()
    case .chip:
      ItemChip(text: ItemFormat.preview(item.text, limit: 80), systemImage: "person")
    case .full, .collapsed:
      if let author = foreignAuthor {
        foreignBubble(author)
      } else {
        ownBubble
      }
    }
  }

  private var ownBubble: some View {
    VStack(alignment: .trailing, spacing: 4) {
      // The tint, darkened a quarter: white body text on the plain system
      // blue is about 4:1, under the 4.5:1 the accessibility audit asks for.
      bubble(fill: AnyShapeStyle(Color.accentColor.mix(with: .black, by: 0.25)), foreground: .white)
      meta
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 48)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText(sender: nil))
    .accessibilityActions { copyAction }
  }

  private func foreignBubble(_ author: MessageAuthor) -> some View {
    let name = author.name ?? Self.strippedID(author.id)
    let tint = ItemFormat.authorTint(author.id)
    return HStack(alignment: .top, spacing: 8) {
      Group {
        if opensAuthorRun {
          Text(ItemFormat.initial(name))
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: avatarSize, height: avatarSize)
            .background(tint, in: .circle)
        } else {
          Color.clear.frame(width: avatarSize, height: 1)
        }
      }
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        if opensAuthorRun {
          Text(name)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
        }
        bubble(fill: AnyShapeStyle(.fill.secondary), foreground: .primary)
        meta
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.trailing, 48)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText(sender: name))
    .accessibilityActions { copyAction }
  }

  private func bubble(fill: AnyShapeStyle, foreground: Color) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if !item.text.isEmpty {
        if let markdown {
          MarkdownView(markdown)
        } else {
          MarkdownView(MarkdownDocument(item.text))
        }
      }
      if let attachments = item.attachments, !attachments.isEmpty {
        AttachmentSummary(references: attachments, onOpen: actions.openAttachment)
      }
    }
    .foregroundStyle(foreground)
    .tint(foreground == .white ? .white : nil)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(fill, in: .rect(cornerRadius: 18))
    .opacity(item.pending == true ? 0.7 : 1)
  }

  @ViewBuilder private var meta: some View {
    let clock = ItemFormat.clock(item.ts)
    let steered = item.displayKind == .steer
    if clock != nil || steered || item.pending == true {
      HStack(spacing: 4) {
        if steered {
          Text(Strings.Chat.Queue.steeredMarker)
        }
        if item.pending == true {
          Text(Strings.Chat.Receipt.sending)
        } else if let clock {
          Text(clock)
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }

  @ViewBuilder private var copyAction: some View {
    Button(Strings.Chat.Menu.copyText) { actions.copy(item.text) }
  }

  private func accessibilityText(sender: String?) -> String {
    var parts: [String] = []
    if let sender { parts.append(sender) }
    if !item.text.isEmpty { parts.append(item.text) }
    if let attachments = item.attachments {
      parts.append(contentsOf: attachments.map(ItemFormat.attachmentName))
    }
    if item.pending == true { parts.append(Strings.Chat.Receipt.sending) }
    return parts.joined(separator: ", ")
  }

  /// `author.id` without its provider prefix (`telegram:123` → `123`).
  static func strippedID(_ id: String) -> String {
    guard let colon = id.lastIndex(of: ":") else { return id }
    return String(id[id.index(after: colon)...])
  }
}

/// The files and pictures a turn carries, by name. Opening one is the screen's
/// business.
struct AttachmentSummary: View {
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  let references: [String]
  let onOpen: @MainActor @Sendable (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(references.enumerated()), id: \.offset) { _, reference in
        Button {
          onOpen(reference)
        } label: {
          Label {
            Text(ItemFormat.attachmentName(reference))
              .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
              .truncationMode(.middle)
          } icon: {
            Image(systemName: ItemFormat.isImageAttachment(reference) ? "photo" : "doc")
          }
          .font(.callout)
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(.fill.tertiary, in: .rect(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityHint(Strings.Chat.Viewer.openHint)
      }
    }
  }
}

extension EnvironmentValues {
  /// The owner's author id in a shared chat; `nil` when the chat is not shared,
  /// which draws every user turn as the owner's.
  @Entry public var transcriptOwnAuthorID: String? = nil
}
