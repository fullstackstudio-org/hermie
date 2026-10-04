import Foundation

/// Who the gateway says this reader is, as far as the title of their own chats goes
/// (`ChatIdentity` in `features/user-chats/user-chat.ts`).
public struct OwnChatIdentity: Sendable, Equatable {
  /// `/api/auth/me`'s `user_id` (or its email), or `owner` on a session-token gateway.
  public var userID: String
  /// `/api/auth/me`'s `display_name`. Often empty; the id then stands in.
  public var displayName: String

  public init(userID: String, displayName: String = "") {
    self.userID = userID
    self.displayName = displayName
  }
}

/**
 The title family of a reader's own chats with a bot (ADR-0007, amended 2026-09-22), the port of
 `userChatTitle` and the own-chat helpers of `features/sessions/session-model.ts` and
 `conversation-list.ts`.

 ADR-0007 gives a bot one forever-chat, the hidden session titled `Bot Chat`, shared by everybody who
 can reach the bot. A reader can have chats of their own beside it, and, exactly as `Bot Chat` and
 `Branch · …` are, the TITLE is the only thing a listing carries that says so:

     Chat · Ada                 the lead: whose chats these are
     Chat · Ada · Trip planning one of them, labelled

 The lead is `Chat · <display name, else user id>`. With no user id there is no title to write, so
 there is no private chat and nothing to switch to: writing somebody's conversation under a name the
 gateway never agreed to is worse than writing none. Every function here is pure, so the rules are
 tested without a socket, and every one of them answers the same title the Expo app and the web
 client write, because one person's chats have to be found by all three.
 */
public enum OwnChatTitle {
  /// What a reader's own chats start with.
  public static let prefix = "Chat"
  /// The separator every generated title in this app joins its parts with.
  public static let separator = " · "
  /// How much of a person's name survives into the lead (`USER_CHAT_TITLE_MAX`): a title is a
  /// registry key here, and one nobody can read on a row is not doing its job.
  public static let leadNameLimit = 48
  /// How much of a label an own chat's title carries (`OWN_CHAT_LABEL_MAX`).
  public static let labelLimit = 48

  /// `Chat · `, the whole start of a lead.
  public static let leadPrefix = prefix + separator

  /// The lead this person's chats carry: the display name when the gateway gave one, the user id
  /// otherwise, in that order and no other. Empty when there is no identity to name.
  public static func lead(for identity: OwnChatIdentity?) -> String {
    let id = collapse(identity?.userID ?? "")

    guard !id.isEmpty else {
      return ""
    }

    let name = collapse(identity?.displayName ?? "")
    let shown = name.isEmpty ? id : name

    return leadPrefix + (shown.count > leadNameLimit ? cutToWord(shown, limit: leadNameLimit) : shown)
  }

  /// `ownChatTitle`: the lead and a label. An empty label is the bare lead itself, which is the
  /// title of a first chat from before a reader could have more than one.
  public static func title(lead: String, label: String) -> String {
    let head = collapse(lead)
    let tail = collapse(label)

    guard !head.isEmpty else {
      return ""
    }

    return tail.isEmpty ? head : head + separator + tail
  }

  /// `isOwnChatTitle`: exactly the lead, or the lead and the separator, never a bare prefix:
  /// `Chat · Ada` must not match `Chat · Adam`'s chats.
  public static func isOwn(_ title: String, lead: String) -> Bool {
    let head = collapse(lead)

    guard !head.isEmpty else {
      return false
    }

    let value = collapse(title)

    return value == head || value.hasPrefix(head + separator)
  }

  /// `ownChatLabel`: what the reader named it, or empty for the bare lead (which the surface calls
  /// "My chat" in the reader's own language).
  public static func label(of title: String, lead: String) -> String {
    let head = collapse(lead)
    let value = collapse(title)

    guard !head.isEmpty, value.hasPrefix(head + separator) else {
      return ""
    }

    return String(value.dropFirst((head + separator).count))
  }

  /// A label as an own chat's name may carry it: whitespace collapsed, cut at the limit.
  public static func cutLabel(_ label: String) -> String {
    let clean = collapse(label)

    guard clean.count > labelLimit else {
      return clean
    }

    return String(clean.prefix(labelLimit)).trimmingCharacters(in: .whitespaces)
  }

  /// `Ideas (2)`: a label with a number after it, still within the limit.
  public static func numbered(_ label: String, _ count: Int) -> String {
    let suffix = " (\(count))"

    return String(label.prefix(labelLimit - suffix.count)).trimmingCharacters(in: .whitespaces) + suffix
  }

  /// `localStamp`: `2026-09-21 23:16` in the reader's own zone, the label a new chat is born with.
  /// `seconds` adds `:ss`, for the one retry after a title clash within the same minute.
  public static func stamp(
    at nowMilliseconds: Double, seconds: Bool = false, calendar: Calendar = .current
  ) -> String {
    let date = Date(timeIntervalSince1970: nowMilliseconds / 1000)
    let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    let pad = { (value: Int?) in String(format: "%02d", value ?? 0) }
    let minute =
      "\(parts.year ?? 0)-\(pad(parts.month))-\(pad(parts.day)) \(pad(parts.hour)):\(pad(parts.minute))"

    return seconds ? "\(minute):\(pad(parts.second))" : minute
  }

  /// Whitespace runs collapsed to one space, the ends trimmed.
  static func collapse(_ value: String) -> String {
    value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  /// As many whole words as fit; the first `limit` characters when one word is longer than the whole
  /// budget: a cut name still names somebody, the bare lead names everybody.
  private static func cutToWord(_ value: String, limit: Int) -> String {
    var out = ""

    for word in value.split(separator: " ") {
      let next = out.isEmpty ? String(word) : out + " " + word

      if next.count > limit {
        break
      }

      out = next
    }

    return out.isEmpty ? String(value.prefix(limit)) : out
  }
}
