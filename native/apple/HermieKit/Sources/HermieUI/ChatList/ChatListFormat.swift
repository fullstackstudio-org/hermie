import Foundation
import HermieCore
import HermieTranscript
import SwiftUI

/// The rules the chat list's rows follow, as plain functions so they are tested without a view.
enum ChatListFormat {
  /// Characters of the last message a row shows, flattened to one line without Markdown. The row
  /// wraps them rather than truncating, so nothing is clipped at the largest text sizes, where it
  /// shows fewer so one row does not fill the sidebar.
  static let previewLimit = 90
  static let accessibilityPreviewLimit = 36

  /// `formatListTime`: nothing for no time, "now" under a minute, the clock today, the weekday
  /// within a week, else the date. In the reader's locale and calendar.
  static func listTime(_ unixSeconds: Double, now: Date = .now, calendar: Calendar = .current) -> String {
    guard unixSeconds.isFinite, unixSeconds > 0 else {
      return ""
    }

    let date = Date(timeIntervalSince1970: unixSeconds)
    let age = now.timeIntervalSince(date)

    if age < 60 {
      return date.formatted(.relative(presentation: .named))
    }

    if calendar.isDate(date, inSameDayAs: now) {
      return date.formatted(date: .omitted, time: .shortened)
    }

    if age < 7 * 86_400 {
      return date.formatted(.dateTime.weekday(.abbreviated))
    }

    return date.formatted(.dateTime.day().month(.abbreviated))
  }

  /// The row's second line: the chat's last message, else the bot's description, else "No
  /// messages yet". An offline bot that was heard from says when instead: a stale message under a
  /// dead connection reads as if it had just arrived.
  static func preview(_ row: ChatListRow, presence: Presence, limit: Int = previewLimit) -> (text: String, quiet: Bool) {
    if presence.state == .offline, let seen = presence.lastSeenAt {
      return (Strings.App.Presence.offlineSince(time: listTime(seen)), true)
    }

    if let preview = row.preview, !preview.text.isEmpty {
      let lead = preview.senderName ?? preview.fromHandle.map { "@\($0)" }
      let words = ItemFormat.preview(preview.text, limit: limit)
      let text = lead.map { "\($0): \(words)" } ?? words

      return (text, preview.system)
    }

    if !row.bot.description.isEmpty {
      return (row.bot.description, true)
    }

    return (Strings.App.Bots.noPreview, true)
  }

  /// When the row last moved: the bot's last-seen time while it is offline, else the chat's newest
  /// message.
  static func stamp(_ row: ChatListRow, presence: Presence) -> String {
    if presence.state == .offline, let seen = presence.lastSeenAt {
      return listTime(seen)
    }

    return listTime(row.lastMessageAt)
  }

  static func presenceLabel(_ presence: Presence) -> String {
    switch presence.state {
    case .offline: Strings.App.Presence.offline
    case .needsInput: Strings.App.Presence.needsInput
    case .working: Strings.App.Presence.working
    case .online: Strings.App.Presence.online
    }
  }

  /// The rows in the roster's order, narrowed to the bots whose name or handle contains `query`
  /// (M1 searches names only). Case and diacritics are ignored, as the system's search fields do.
  static func filtered(_ names: [String], rows: [String: ChatListRow], query: String) -> [ChatListRow] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let ordered = names.compactMap { rows[$0] }

    guard !needle.isEmpty else {
      return ordered
    }

    return ordered.filter { row in
      row.bot.displayName.localizedStandardContains(needle) || row.bot.name.localizedStandardContains(needle)
    }
  }

  /// What VoiceOver reads for a row, in the order it is drawn: the names, the presence, the
  /// unread state, the needs-input mark.
  static func accessibilityLabel(_ row: ChatListRow, presence: Presence) -> String {
    var parts = [row.bot.displayName]

    if row.bot.displayName != row.bot.name {
      parts.append(row.bot.name)
    }

    parts.append(presenceLabel(presence))

    if row.unreadCount > 0 {
      parts.append(Strings.App.Bots.unreadLabel(count: row.unreadCount))
    } else if row.unread {
      parts.append(Strings.App.Bots.unread)
    }

    if row.needsInput, presence.state != .needsInput {
      parts.append(Strings.App.Bots.needsInput)
    }

    return parts.joined(separator: ", ")
  }
}
