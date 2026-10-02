import ExpoModulesCore

/**
 One question: what URL was this process launched by?

 It exists because `Linking.getInitialURL()` cannot answer it under the UIKit scene life cycle, and
 `HermieSceneDelegate.launchURL` explains at length why — the short version is that a cold-start URL
 arrives at the scene rather than in the launch options, and both things that see it before
 JavaScript does will drop it.

 `consumeLaunchURL` rather than a constant or a property, and the CONSUMING is the whole design. A
 launch URL is true for the life of the process, so anything that merely reads it hands the same
 answer to every caller forever: a hook that remounts would reopen the launch chat, and a Fast
 Refresh would too. Reading it once and clearing it makes "the app was launched by this link" an
 event with exactly one recipient, which is what it is.

 Answers `nil` on every launch that was not opened by a URL, which is almost all of them.
 */
public class HermieSceneModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HermieScene")

    Function("consumeLaunchURL") { () -> String? in
      let url = HermieSceneDelegate.launchURL
      HermieSceneDelegate.launchURL = nil

      return url?.absoluteString
    }
  }
}
