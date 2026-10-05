import Foundation

/**
 What an open chat tells another device of the same Apple ID, so that device can pick it up (Handoff).

 The activity names a place and nothing in it: the payload is one `hermie://` link (`DeepLink`), the
 gateway's key, the bot, and for a past conversation its session id. It never carries a word that was
 typed or received, a draft, or an address: the other device opens the chat and reads it from its own
 gateway session, as a tap on a notification does. Routing goes through the router like any link, so
 what a link may name (`chat` and `conversation`) is decided in one place.

 `NSUserActivityTypes` of both apps' Info.plist lists `type`; Handoff needs the same type on the
 sending and the receiving device, and the same team.

 An activity that arrives from another device is held to the same rules as a link from outside:
 anything that is not exactly a chat or a conversation link is dropped. A share, a Shortcut request
 or a folder names something only the device that made it has.
 */
public enum HandoffActivity {
  /// The activity type: the same string in `NSUserActivityTypes` (both apps) and in the code.
  public static let type = "dev.hermie.activity.chat"

  /// The one key of `userInfo`. `requiredUserInfoKeys` names it, so Handoff carries it and nothing else.
  public static let linkKey = "link"

  public static let requiredUserInfoKeys: Set<String> = [linkKey]

  /// The payload for `link`, or nil when it is not a chat or a conversation, or cannot be written.
  public static func userInfo(for link: DeepLink?) -> [String: String]? {
    guard let link, isHandedOff(link), let text = link.string else {
      return nil
    }

    return [linkKey: text]
  }

  /// The link an activity's `userInfo` carries, or nil for anything else.
  public static func link(from userInfo: [AnyHashable: Any]?) -> DeepLink? {
    guard let text = userInfo?[linkKey] as? String, let link = DeepLink(text), isHandedOff(link) else {
      return nil
    }

    return link
  }

  /// A chat, or one conversation of a bot: places every device of the owner has.
  private static func isHandedOff(_ link: DeepLink) -> Bool {
    switch link {
    case .chat, .conversation:
      true
    case .ask, .share, .intent, .folder:
      false
    }
  }
}
