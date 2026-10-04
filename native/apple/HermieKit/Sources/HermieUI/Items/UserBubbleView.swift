import HermieCore
import HermieMarkdown
import HermieTranscript
import SwiftUI

/// A person's turn, as Messages draws it. The owner's own turns sit on the
/// trailing side in a flat blue bubble with white text; in a shared chat a
/// turn by someone else sits on the leading side in the grey bubble, with
/// their picture (`PersonAvatar`: the gateway's, else their initial coloured by
/// their author id, never by name, which two people can share) beside the
/// group's last bubble, and their name next to the
/// time under it: "Sam · 21:42" (`metaLine`). The owner's own bubbles keep
/// the time alone.
///
/// A turn an agent sent on a person's behalf (`author.via`, `contract/gateway/mcp.md`) is never
/// drawn as the person alone, in the owner's bubble or a colleague's: the line under it reads
/// "Robin via Example Agent · 21:42" (`metaLine`).
///
/// The chat is shared when the item carries an `author` that is not the owner;
/// the builder tells the view where the bubble sits in its group
/// (`BubbleLayout`): only the last bubble of a group has the tail and the time
/// under it.
struct UserBubbleView: View {
  let item: UserItem
  let presentation: Presentation
  let markdown: MarkdownDocument?
  let opensAuthorRun: Bool
  var bubble: BubbleLayout?

  @Environment(\.transcriptItemActions) private var actions
  @Environment(\.transcriptOwnAuthorID) private var ownAuthorID
  @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 28

  /// Someone other than the owner wrote this.
  private var foreignAuthor: MessageAuthor? {
    guard let author = item.author, let ownAuthorID, author.id != ownAuthorID else { return nil }
    return author
  }

  /// The owner's own name, for an own turn an agent sent: its label is `<name> via <client>`, and a
  /// turn without the marker names nobody. `nil` when the gateway sent no name (the label is then
  /// `via <client>`).
  private var ownViaName: String? {
    item.author?.via == nil ? nil : item.author?.name
  }

  /// The last bubble of its group (a row outside the chat's builder is a group of its own).
  private var closesGroup: Bool { bubble?.closesGroup ?? true }

  var body: some View {
    switch presentation {
    case .hiddenPlaceholder:
      EmptyView()
    case .chip:
      ItemChip(text: ItemFormat.preview(item.text, limit: 80), systemImage: "person")
    case .full, .collapsed:
      VStack(spacing: 0) {
        if let ts = bubble?.timeHeader {
          BubbleTimeHeader(ts: ts)
        }
        if let author = foreignAuthor {
          foreignBubble(author)
        } else {
          ownBubble
        }
      }
    }
  }

  private var ownBubble: some View {
    VStack(alignment: .trailing, spacing: ChatSpacing.bubbleCaption) {
      BubbleColumn(side: .outgoing, width: .text) {
        MessageBubble(side: .outgoing, tail: closesGroup, fill: BubblePalette.outgoing) {
          words(foreground: BubblePalette.outgoingText)
        }
        .messageMenu(for: .user(item))
        .opacity(item.pending == true ? 0.7 : 1)
      }
      meta(sender: ownViaName, via: item.author?.via)
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText(sender: ownViaName, via: item.author?.via))
    .accessibilityActions { MessageMenuItems(item: .user(item), flattensLinks: true) }
  }

  private func foreignBubble(_ author: MessageAuthor) -> some View {
    let name = author.name ?? Self.strippedID(author.id)
    return HStack(alignment: .bottom, spacing: 8) {
      Group {
        // The avatar stands by the group's last bubble, as Messages puts it.
        if closesGroup {
          PersonAvatar(id: author.id, name: name, size: avatarSize)
        } else {
          Color.clear.frame(width: avatarSize, height: 1)
        }
      }
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: ChatSpacing.bubbleCaption) {
        BubbleColumn(side: .incoming, width: .text) {
          MessageBubble(side: .incoming, tail: closesGroup, fill: BubblePalette.incoming) {
            words(foreground: .primary)
          }
          .messageMenu(for: .user(item))
          .opacity(item.pending == true ? 0.7 : 1)
        }
        meta(sender: name, via: author.via)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText(sender: name, via: author.via))
    .accessibilityActions { MessageMenuItems(item: .user(item), flattensLinks: true) }
  }

  /// The words and the attachments, in the bubble's text colour, as wide as they need.
  private func words(foreground: Color) -> some View {
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
    .environment(\.markdownFillsWidth, false)
    #if os(iOS)
      // A long press on the bubble is the message's menu, not the start of a selection.
      .environment(\.markdownSelectable, false)
    #endif
    .foregroundStyle(foreground)
    .tint(foreground == .white ? .white : nil)
  }

  /// The time under the group's last bubble, on a line of its own (never on the words' last line),
  /// with the sender's name before it when someone else wrote it; "Sending…" and the steered
  /// marker under any bubble that has them.
  @ViewBuilder private func meta(sender: String?, via: AuthorVia?) -> some View {
    let clock = closesGroup ? ItemFormat.clock(item.ts) : nil
    let steered = item.displayKind == .steer
    if clock != nil || steered || item.pending == true {
      HStack(spacing: 4) {
        if steered {
          Text(Strings.Chat.Queue.steeredMarker)
        }
        if item.pending == true {
          Text(Strings.Chat.Receipt.sending)
        } else if let clock {
          Text(verbatim: Self.metaLine(sender: sender, via: via, clock: clock))
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      .font(.caption2)
      .foregroundStyle(.secondary)
      .padding(.horizontal, ChatSpacing.captionInset)
    }
  }

  /// The longest sender's name shown next to the time, in characters.
  static let senderLimit = 40
  /// The longest agent name shown next to it, in characters (the gateway cleans to the same cap).
  static let viaClientLimit = 80

  /// The line under a group's last bubble: the time, after the sender's name when someone else
  /// wrote it ("Sam · 21:42"), or after `<name> via <client>` when an agent sent it for them
  /// ("Robin via Example Agent · 21:42"). Both names are the gateway's untrusted text, so each goes
  /// through `SecurePrompt.displayText` (no control or direction characters, one line, at most
  /// `senderLimit` or `viaClientLimit` characters) and is isolated with FIRST STRONG ISOLATE … POP
  /// DIRECTIONAL ISOLATE, so a right-to-left name cannot reorder the time or the word between them.
  static func metaLine(sender: String?, via: AuthorVia? = nil, clock: String) -> String {
    guard let label = senderLabel(name: sender, via: via, isolated: true) else { return clock }
    return "\(label) · \(clock)"
  }

  /// The sender as one label: the name, or `<name> via <client>` for an agent's turn, `nil` when
  /// there is neither. `isolated` wraps each part for drawing; VoiceOver gets it plain.
  static func senderLabel(name: String?, via: AuthorVia?, isolated: Bool) -> String? {
    func shown(_ raw: String?, limit: Int) -> String {
      let line = SecurePrompt.displayText(raw, limit: limit).replacingOccurrences(of: "\n", with: " ")
      return line.isEmpty || !isolated ? line : "\u{2068}\(line)\u{2069}"
    }

    let who = shown(name, limit: senderLimit)
    let client = shown(via?.client, limit: viaClientLimit)

    // A marker with no client left once cleaned says nothing: the sender is the name alone.
    guard let via, !client.isEmpty else { return who.isEmpty ? nil : who }
    return authorLabel(via: AuthorVia(kind: via.kind, client: client), who)
  }

  private func accessibilityText(sender: String?, via: AuthorVia?) -> String {
    var parts: [String] = []
    if let label = Self.senderLabel(name: sender, via: via, isolated: false) { parts.append(label) }
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
