import HermieCore
import SwiftUI

/// One bot in the chat list: avatar and presence bead, name, time, the last message, the unread
/// count and the needs-input mark.
///
/// Compared on its values, so a summary that changed one bot's row redraws that row only. At the
/// accessibility text sizes the time moves under the name instead of squeezing it.
struct ChatListRowView: View, Equatable {
  let row: ChatListRow
  let gatewayReady: Bool

  @Environment(\.dynamicTypeSize) private var typeSize

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.row == rhs.row && lhs.gatewayReady == rhs.gatewayReady
  }

  var body: some View {
    let presence = row.presence(gatewayReady: gatewayReady)
    let large = typeSize.isAccessibilitySize
    let limit = large ? ChatListFormat.accessibilityPreviewLimit : ChatListFormat.previewLimit
    let preview = ChatListFormat.preview(row, presence: presence, limit: limit)
    let stamp = ChatListFormat.stamp(row, presence: presence)

    HStack(alignment: large ? .top : .center, spacing: 12) {
      ZStack(alignment: .bottomTrailing) {
        BotAvatar(name: row.bot.displayName, avatar: row.avatar)
        PresenceDot(state: presence.state)
          .offset(x: 2, y: 2)
      }

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
    .accessibilityLabel(ChatListFormat.accessibilityLabel(row, presence: presence))
    .accessibilityValue([preview.text, stamp].filter { !$0.isEmpty }.joined(separator: ", "))
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("hermie.chatList.row.\(row.bot.name)")
  }

  private var name: some View {
    Text(row.bot.displayName)
      .font(.headline)
      .fontWeight(row.unread || row.unreadCount > 0 ? .bold : .semibold)
      .fixedSize(horizontal: false, vertical: true)
  }

  private func time(_ stamp: String) -> some View {
    Text(stamp)
      .font(.caption)
      .monospacedDigit()
      .foregroundStyle(.secondary)
      .fixedSize()
  }

  @ViewBuilder private var marks: some View {
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
