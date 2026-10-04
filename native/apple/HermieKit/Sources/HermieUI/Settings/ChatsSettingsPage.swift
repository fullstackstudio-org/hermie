import HermieCore
import HermieTranscript
import SwiftUI

/**
 What the Chats page says about the transcript cache after the reader did something: the switch,
 or "Clear Now". Only the newest action may say its piece: an older clear that settles after it
 must not overwrite it (`run`).
 */
@MainActor
@Observable
final class ChatsPageState {
  enum Message: Equatable {
    case cacheOn
    case cacheOff
    case cleared
    case failed

    var text: String {
      switch self {
      case .cacheOn: NativeStrings.Chats.cacheOn
      case .cacheOff: NativeStrings.Chats.cacheOff
      case .cleared: NativeStrings.Chats.cacheCleared
      case .failed: NativeStrings.Chats.cacheFailed
      }
    }

    var isFailure: Bool { self == .failed }
  }

  private(set) var message: Message?
  private(set) var clearing = false
  /// The newest action's number.
  @ObservationIgnored private var run = 0

  /// The switch. Switching it off clears what is stored too: a setting that stopped new copies and
  /// left the old ones would not mean what it says.
  func keep(_ enabled: Bool, in settings: AppSettings) async {
    settings.setTranscriptCache(enabled)

    guard !enabled else {
      run += 1
      clearing = false
      message = .cacheOn
      return
    }

    await clear(in: settings, done: .cacheOff)
  }

  func clear(in settings: AppSettings, done: Message = .cleared) async {
    run += 1
    let mine = run
    clearing = true

    do {
      try await settings.clearTranscriptCache()

      if mine == run {
        message = done
      }
    } catch {
      if mine == run {
        message = .failed
      }
    }

    if mine == run {
      clearing = false
    }
  }

  /// "Clear Now": says nothing while it works, and ignores a second press meanwhile.
  func clearNow(in settings: AppSettings) async {
    guard !clearing else {
      return
    }

    message = nil
    await clear(in: settings)
  }
}

/**
 Settings → Chats: what a conversation shows until the reader says otherwise, and whether this
 device keeps the transcripts it has read.

 **The defaults** (verbosity, bot-to-bot, thinking) follow the account through ui_meta
 (`AppSettings.synced`); a conversation that has its own view keeps it. Changing them takes effect
 in every open conversation that has none (`GatewaySession.setDefaultVisibility`).

 **The transcript cache** is this device's (`AppSettings.transcriptCache`): where an opened
 conversation and the roster are kept so they paint before the gateway has answered.

 **The folders** (`ChatListFolderSections`) follow below, when a gateway is live.
 */
struct ChatsSettingsPage: View {
  /// The live gateway's session, for the folders; nil when there is none.
  let session: GatewaySession?

  @Environment(AppLaunch.self) private var launch
  @State private var page = ChatsPageState()

  var body: some View {
    let settings = launch.settings
    let defaults = settings.synced.defaults

    Form {
      Section {
        Picker(
          Strings.App.Settings.defaultVerbosity,
          selection: Binding(
            get: { defaults.level },
            set: { settings.setDefaults(VisibilityOptions(level: $0, showBotToBot: defaults.showBotToBot, showThinking: defaults.showThinking)) }
          )
        ) {
          ForEach(Verbosity.knownCases, id: \.self) { level in
            Text(level.label).tag(level)
          }
        }
        .accessibilityIdentifier("hermie.settings.chats.verbosity")

        Toggle(
          Strings.App.Settings.showBotToBot,
          isOn: Binding(
            get: { defaults.showBotToBot },
            set: { settings.setDefaults(VisibilityOptions(level: defaults.level, showBotToBot: $0, showThinking: defaults.showThinking)) }
          )
        )
        .accessibilityIdentifier("hermie.settings.chats.botToBot")

        Toggle(
          Strings.App.Settings.showThinking,
          isOn: Binding(
            get: { defaults.showThinking },
            set: { settings.setDefaults(VisibilityOptions(level: defaults.level, showBotToBot: defaults.showBotToBot, showThinking: $0)) }
          )
        )
        .accessibilityIdentifier("hermie.settings.chats.thinking")
      } header: {
        Text(NativeStrings.Chats.defaultsHeader)
      } footer: {
        SettingsNote("\(Strings.App.Settings.defaultVerbosityHint) \(NativeStrings.Chats.defaultsFooter)")
      }

      Section {
        Toggle(
          NativeStrings.Chats.cacheKeep,
          isOn: Binding(
            get: { settings.transcriptCache },
            set: { enabled in Task { await page.keep(enabled, in: settings) } }
          )
        )
        .accessibilityIdentifier("hermie.settings.chats.cache")

        Button(NativeStrings.Chats.cacheClear) {
          Task { await page.clearNow(in: settings) }
        }
        .accessibilityIdentifier("hermie.settings.chats.clearCache")

        if let message = page.message {
          Text(message.text)
            .foregroundStyle(message.isFailure ? Color.red : Color.primary)
            .accessibilityIdentifier("hermie.settings.chats.cacheMessage")
        }
      } header: {
        Text(NativeStrings.Chats.cacheHeader)
      } footer: {
        SettingsNote(NativeStrings.Chats.cacheFooter)
      }

      if let session {
        ChatListFolderSections(session: session)
      } else {
        Section {
          Text(NativeStrings.ChatList.settingsNoGateway)
            .foregroundStyle(Color.primary)
        }
      }
    }
    .formStyle(.grouped)
    .accessibilityIdentifier("hermie.settings.chats")
  }
}

extension Verbosity {
  var label: String {
    switch self {
    case .quiet: Strings.Chat.Options.VerbosityOptions.quiet
    case .normal: Strings.Chat.Options.VerbosityOptions.normal
    case .verbose: Strings.Chat.Options.VerbosityOptions.verbose
    case .other(let word): word
    }
  }
}
