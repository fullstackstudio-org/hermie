import Foundation
import HermieCore

/// The New bot sheet's own sentences, from `Resources/Native.xcstrings`. What the Expo app says in the
/// same words (the labels, hints and the model and clone rows) is read from the shared catalogue
/// through `Strings.Profiles.New`.
extension NativeStrings {
  enum NewBot {
    /// New Bot… (the menu item)
    static var menuTitle: String { String(localized: "native.newBot.menuTitle", table: "Native", bundle: .module) }
    /// Makes a new bot on this gateway. (the hint of the chat list's button)
    static var open: String { String(localized: "native.newBot.open", table: "Native", bundle: .module) }
    /// A bot needs a handle.
    static var handleEmpty: String { String(localized: "native.newBot.handleEmpty", table: "Native", bundle: .module) }
    /// 'default' is the built-in bot and cannot be created again.
    static var handleBuiltIn: String {
      String(localized: "native.newBot.handleBuiltIn", table: "Native", bundle: .module)
    }
    /// Use lowercase letters, numbers, '-' or '_' … (for example: {suggestion}).
    static func handleShape(_ suggestion: String) -> String {
      String(
        localized: "native.newBot.handleShape",
        defaultValue:
          "Use lowercase letters, numbers, '-' or '_', starting with a letter or number, up to 64 characters (for example: \(suggestion)).",
        table: "Native", bundle: .module)
    }
    /// '{handle}' is reserved: it collides with Hermes itself or with a common system command.
    static func handleReserved(_ handle: String) -> String {
      String(
        localized: "native.newBot.handleReserved",
        defaultValue: "'\(handle)' is reserved: it collides with Hermes itself or with a common system command.",
        table: "Native", bundle: .module)
    }
    /// '{handle}' already exists.
    static func handleTaken(_ handle: String) -> String {
      String(
        localized: "native.newBot.handleTaken", defaultValue: "'\(handle)' already exists.", table: "Native",
        bundle: .module)
    }
    /// This is also a hermes command, so its shortcut in the shell will not be created.
    static var subcommandWarning: String {
      String(localized: "native.newBot.subcommandWarning", table: "Native", bundle: .module)
    }
    /// The gateway made {name} but did not list it. Try again in a moment.
    static func notListed(_ name: String) -> String {
      String(
        localized: "native.newBot.notListed",
        defaultValue: "The gateway made \(name) but did not list it. Try again in a moment.", table: "Native",
        bundle: .module)
    }
    /// There is no connection to the gateway right now.
    static var offline: String { String(localized: "native.newBot.offline", table: "Native", bundle: .module) }
    /// This gateway cannot make bots from here.
    static var unsupported: String {
      String(localized: "native.newBot.unsupported", table: "Native", bundle: .module)
    }
    /// This account may not make bots on this gateway.
    static var readOnly: String { String(localized: "native.newBot.readOnly", table: "Native", bundle: .module) }
    /// {name} is ready.
    static func ready(_ name: String) -> String {
      String(localized: "native.newBot.ready", defaultValue: "\(name) is ready.", table: "Native", bundle: .module)
    }
    /// Open chat
    static var openChat: String { String(localized: "native.newBot.openChat", table: "Native", bundle: .module) }
  }
}

/// What the New bot sheet says about a handle and a failure, in the reader's language.
enum NewBotText {
  static func problem(_ problem: ProfileName.Problem) -> String {
    switch problem {
    case .empty: NativeStrings.NewBot.handleEmpty
    case .builtIn: NativeStrings.NewBot.handleBuiltIn
    case .shape(let suggestion): NativeStrings.NewBot.handleShape(suggestion)
    case .reserved(let handle): NativeStrings.NewBot.handleReserved(handle)
    case .taken(let handle): NativeStrings.NewBot.handleTaken(handle)
    }
  }

  static func warning(_ warning: ProfileName.Warning) -> String {
    switch warning {
    case .subcommand: NativeStrings.NewBot.subcommandWarning
    }
  }

  /// The failure, as the sheet's line: the gateway's own words (untrusted) go through the catalogue's
  /// "Could not make the bot: {reason}".
  static func failure(_ failure: NewBotModel.Failure) -> String {
    switch failure {
    case .notListed(let name):
      return NativeStrings.NewBot.notListed(name)
    case .request(let request):
      switch request {
      case .offline: return NativeStrings.NewBot.offline
      case .unsupported: return NativeStrings.NewBot.unsupported
      case .forbidden: return NativeStrings.NewBot.readOnly
      case .refused(let reason), .notFound(let reason):
        return Strings.Profiles.New.failed(reason: reason)
      case .notApplied, .lastToolset:
        return Strings.Profiles.New.failed(reason: "")
      }
    }
  }
}
