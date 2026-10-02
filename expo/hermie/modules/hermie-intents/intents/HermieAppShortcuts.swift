import AppIntents

/**
 The phrases somebody can say, and the actions that appear without being built.

 An `AppShortcutsProvider` is what puts an action in the Shortcuts app's
 gallery, in Spotlight's suggestions, and in Siri's vocabulary without anybody
 assembling a Shortcut first. It has to be in the APP's target — Apple's
 documentation is explicit about that — which is why `plugin/with-hermie-intents.js`
 copies this directory into the app's own sources phase rather than letting the
 pod compile it.

 ## `applicationName` is in every phrase, and that is not optional

 Siri matches a phrase only when it contains the app's name, and the
 `.applicationName` token is how that name follows a localisation or a rename.
 A phrase without it is silently never matched — no error, no warning, it just
 never works, which is the failure mode this whole file is most likely to hit.

 ## Why the phrases are short

 Every one of them is the shortest thing a person would actually say. The
 parameterised forms ("Ask ⟨bot⟩ in Hermie …") let Siri fill the bot in from
 what was heard, resolved by `HermieBotEntityQuery.entities(matching:)`.

 ## Four is the cap

 iOS takes at most ten App Shortcuts per app, and shows far fewer. These four
 are the ones worth spending on: the two that send, the one that opens, and the
 one that answers without opening anything.
 */
@available(iOS 16.0, *)
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
