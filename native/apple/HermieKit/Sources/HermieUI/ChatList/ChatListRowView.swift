import HermieCore
import SwiftUI

/// One bot in the chat list: avatar and presence bead, name, time, the last message, the unread
/// count, and the marks beside the name (pinned, muted, needs input).
///
/// Compared on its values, so a summary that changed one bot's row redraws that row only. At the
/// accessibility text sizes the time moves under the name instead of squeezing it.
struct ChatListRowView: View, Equatable {
  let row: ChatListRow
  let gatewayReady: Bool
  var pinned = false
  var muted = false
  /// The colour this bot's chat was given (`BotIdentity`).
  var accent: BotAccent = .default

  @Environment(\.dynamicTypeSize) private var typeSize

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.row == rhs.row && lhs.gatewayReady == rhs.gatewayReady && lhs.pinned == rhs.pinned && lhs.muted == rhs.muted
      && lhs.accent == rhs.accent
  }

  var body: some View {
    let presence = row.presence(gatewayReady: gatewayReady)
    let large = typeSize.isAccessibilitySize
    let limit = large ? ChatListFormat.accessibilityPreviewLimit : ChatListFormat.previewLimit
    let preview = ChatListFormat.preview(row, presence: presence, limit: limit)
    let stamp = ChatListFormat.stamp(row, presence: presence)

    HStack(alignment: large ? .top : .center, spacing: 12) {
      BotAvatar(name: row.bot.displayName, avatar: row.avatar, presence: presence.state, accent: accent)

      VStack(alignment: .leading, spacing: 2) {
        if large {
          name
          if !stamp.isEmpty { time(stamp) }
        } else {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            name
              .frame(maxWidth: .infinity, alignment: .leading)
            marks
            if !stamp.isEmpty { time(stamp) }
          }
        }

        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(preview.text)
            .font(.subheadline)
            .italic(preview.quiet)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)

          if large { marks }
          badge
        }
      }
    }
    .padding(.vertical, 4)
    .contentShape(.rect)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(ChatListFormat.accessibilityLabel(row, presence: presence, pinned: pinned, muted: muted))
    .accessibilityValue([preview.text, stamp].filter { !$0.isEmpty }.joined(separator: ", "))
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("hermie.chatList.row.\(row.bot.name)")
  }

  /// One line, cut at the end, never hyphenated over two: the full name is in the row's label. It
  /// gets the room before the time does.
  private var name: some View {
    let companion = row.companionName

    // The other name (the handle, or the name when the handle leads) follows in a quieter voice, so a
    // bot can be told apart from another with the same name and gives way first when the row is
    // narrow; "Hide profile name" leaves it out.
    return HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(row.bot.displayName)
        .font(.headline)
        .fontWeight(row.unread || row.unreadCount > 0 ? .bold : .semibold)
        .lineLimit(1)
        .truncationMode(.tail)
        .layoutPriority(1)

      if !companion.isEmpty {
        Text(companion)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
    }
    .layoutPriority(1)
  }

  private func time(_ stamp: String) -> some View {
    Text(stamp)
      .font(.caption)
      .monospacedDigit()
      .foregroundStyle(.secondary)
      .fixedSize()
  }

  @ViewBuilder private var marks: some View {
    if pinned {
      Image(systemName: "pin.fill")
        .foregroundStyle(.secondary)
        .imageScale(.small)
        .accessibilityHidden(true)
    }

    if muted {
      Image(systemName: "bell.slash.fill")
        .foregroundStyle(.secondary)
        .imageScale(.small)
        .accessibilityHidden(true)
        .accessibilityIdentifier("hermie.chatList.muted.\(row.bot.name)")
    }

    if row.needsInput {
      Image(systemName: "exclamationmark.bubble.fill")
        .foregroundStyle(.orange)
        .imageScale(.small)
        .accessibilityHidden(true)
    }
  }

  @ViewBuilder private var badge: some View {
    if row.unreadCount > 0 {
      Text(row.unreadCount > 99 ? "99+" : String(row.unreadCount))
        .font(.caption.weight(.semibold))
        .monospacedDigit()
        .foregroundStyle(.white)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(Color.accentColor.mix(with: .black, by: 0.25), in: .capsule)
        .accessibilityHidden(true)
    } else if row.unread {
      Circle()
        .fill(.tint)
        .frame(width: 10, height: 10)
        .accessibilityHidden(true)
    }
  }
}
