import AppIntents

/**
 The phrases somebody can say, and the actions that appear without being built.

 An `AppShortcutsProvider` is what puts an action in the Shortcuts app's
 gallery, in Spotlight's suggestions, and in Siri's vocabulary without anybody
 assembling a Shortcut first. It has to be in the APP's target — which is why
 the XcodeGen template compiles `Extensions/Intents` into the app rather than
 into an extension.

 ## `applicationName` is in every phrase, and that is not optional

 Siri matches a phrase only when it contains the app's name, and the
 `.applicationName` token is how that name follows a localisation or a rename.
 A phrase without it is silently never matched — no error, no warning, it just
 never works, which is the failure mode this whole file is most likely to hit.
 The translated phrases (`AppShortcuts.strings` in each language's folder under `Resources`) carry it too.

 ## Why the phrases are short

 Every one of them is the shortest thing a person would actually say. The
 parameterised forms ("Ask ⟨bot⟩ in Hermie …") let Siri fill the bot in from
 what was heard, resolved by `HermieBotEntityQuery.entities(matching:)`.

 ## Five is the cap

 The system takes at most ten App Shortcuts per app, and shows far fewer. These
 five are the ones worth spending on: the two that send, the two that open (one to
 read, one to write in), and the one that answers without opening anything.
 */
struct HermieAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: HermieAskIntent(),
      phrases: [
        "Ask \(\.$bot) in \(.applicationName)",
        "Ask my \(.applicationName) bot",
        "\(.applicationName) ask \(\.$bot)"
      ],
      shortTitle: "Ask a bot",
      systemImageName: "bubble.left.and.bubble.right"
    )

    AppShortcut(
      intent: HermieSendIntent(),
      phrases: [
        "Send to \(\.$bot) in \(.applicationName)",
        "Send a message with \(.applicationName)"
      ],
      shortTitle: "Send to a bot",
      systemImageName: "paperplane"
    )

    AppShortcut(
      intent: HermieOpenChatIntent(),
      phrases: [
        "Open \(\.$bot) in \(.applicationName)",
        "Open a chat in \(.applicationName)"
      ],
      shortTitle: "Open a chat",
      systemImageName: "text.bubble"
    )

    AppShortcut(
      intent: HermieAskBotIntent(),
      phrases: [
        "Write to \(\.$bot) in \(.applicationName)",
        "Chat with \(\.$bot) in \(.applicationName)",
        "Write to a bot in \(.applicationName)"
      ],
      shortTitle: "Write to a bot",
      systemImageName: "square.and.pencil"
    )

    AppShortcut(
      intent: HermieNeedsInputIntent(),
      phrases: [
        "What is waiting in \(.applicationName)",
        "\(.applicationName) bots needing input"
      ],
      shortTitle: "Bots needing input",
      systemImageName: "questionmark.circle"
    )
  }
}
