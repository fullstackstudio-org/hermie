import CoreSpotlight
import UIKit

/**
 Hermie's adoption of the UIKit scene life cycle, and nothing else.

 iOS 27 made the scene life cycle mandatory. While the first scene connects, UIKit runs
 `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, and for an app linked against the
 iOS 27 SDK with no `UIApplicationSceneManifest` in its bundle it traps the process:
 `EXC_BREAKPOINT` on the main thread, "Application failed to launch: UIScene life cycle is required
 for apps built with this SDK". No JavaScript has run at that point and no code of ours is on the
 stack, which is why the crash reads as if the app never started — it never did.

 Expo SDK 54's template is an application-life-cycle app: `AppDelegate` creates the `UIWindow` in
 `application(_:didFinishLaunchingWithOptions:)` and hands it to `startReactNative`. SDK 57.0.23
 and newer can opt in (`expo-build-properties`' `ios.enableSceneSupport`) and SDK 58 does it in the
 template; neither is available on this SDK line, so this class is the local equivalent. It is
 referenced from `Info.plist` by its Objective-C name, which is what
 `plugins/with-ios-scene-lifecycle.js` writes — the same mechanism Expo uses for its own
 `EXExpoAppSceneDelegate`, and the reason this can live in an autolinked module instead of in the
 generated Xcode project.

 ## It adopts the app delegate's window rather than making its own

 The upstream migration (and React Native's own template) moves window creation into
 `scene(_:willConnectTo:options:)`. That is not safe on SDK 54, and the reason is a `fatalError`:
 `ExpoDevLauncherAppDelegateSubscriber` runs inside
 `application(_:didFinishLaunchingWithOptions:)` and does

 ```swift
 guard let window = UIApplication.shared.delegate?.window ?? ... .filter { $0.isKeyWindow }.first else {
   fatalError("Cannot find the keyWindow. Make sure to call `window.makeKeyAndVisible()`.")
 }
 ```

 A scene connects *after* `didFinishLaunching` returns, so a window created here does not exist yet
 when that subscriber looks for one, and every Debug build would die on the dev client instead of on
 UIKit. expo-dev-launcher 6.0.21 cannot be taught otherwise from outside.

 So the window keeps being born where SDK 54 expects it, and this class only finishes the job UIKit
 used to do implicitly: attach that window to the connecting window scene and make it key. Nothing
 about `didFinishLaunching` changes, which is also why expo-splash-screen still hands over (it
 attaches its launch storyboard to the React *root view*, never to the window) and why
 expo-system-ui still finds `UIApplication.shared.delegate?.window`.

 ## Events UIKit stops delivering to the app delegate

 Once a scene delegate exists, UIKit no longer calls the app delegate's URL, user-activity or
 life-cycle methods — it calls the scene's. The generated `AppDelegate` overrides three of those and
 forwards them to `RCTLinkingManager` and to the Expo subscribers, so every scene callback below
 hands the event back to it. That keeps one path through the app delegate rather than two, and it is
 deliberately the app delegate's own method and not `RCTLinkingManager` directly: the override
 already calls `RCTLinkingManager` itself, and calling both would deliver the JavaScript `url` event
 twice.

 `AppState` needs no forwarding: `RCTAppState` observes `UIApplicationDidBecomeActive` and its
 siblings on `NotificationCenter`, and `UIApplication` keeps posting those under the scene life
 cycle. The four scene callbacks are forwarded anyway because an `ExpoAppDelegateSubscriber` that
 implements them would otherwise go quiet without any sign — none of the installed ones do today.
 */
@objc(HermieSceneDelegate)
public class HermieSceneDelegate: UIResponder, UIWindowSceneDelegate {
  /**
   The URL this process was LAUNCHED by, for whoever asks first.

   `Linking.getInitialURL()` reads the app delegate's launch options, and under the scene life cycle
   a cold-start URL is not in them — it is in the scene's connection options, which arrive after
   `startReactNative` has already been handed the launch options. So React Native answers `null` and
   the URL reaches JavaScript, if at all, as a `url` EVENT fired while the bridge is still starting
   and nothing is listening. Measured on a simulator on 2026-09-21: a widget tapped while the app
   was closed opened Hermie on whatever screen it was last on.

   It is worse than "not delivered" in a build that links expo-dev-client, which is every build made
   from this repository today. `ExpoDevLauncherAppDelegateSubscriber` sees the URL first — the
   forward below goes through the app delegate, and `ExpoAppDelegate` offers it to its subscribers
   before `RCTLinkingManager` — and with no bridge started yet the launcher treats it as a bundle
   URL and shows its own screen instead. Also measured, on a Release simulator build.

   So the URL is recorded HERE, before either of those can lose it, and `HermieSceneModule` hands it
   to `src/platform/deep-link.ts`. Recorded rather than acted on: this class knows nothing about
   chats, and what a link MEANS is one narrow parser in TypeScript with a table of refusals.
   */
  public static var launchURL: URL?

  /// UIKit reads this to find the scene's window; the app delegate owns the same instance.
  public var window: UIWindow?

  private var strayWindowObserver: NSObjectProtocol?

  public func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }
    guard let window = UIApplication.shared.delegate?.window ?? nil else {
      fatalError(
        "HermieSceneDelegate found no window on the app delegate. The window is created in "
          + "AppDelegate.application(_:didFinishLaunchingWithOptions:) by the Expo SDK 54 template; "
          + "if that changed, plugins/with-ios-scene-lifecycle.js should have failed the prebuild first."
      )
    }

    // UIKit sizes a window it creates itself (`UIWindow(windowScene:)`) to the scene. This one was
    // built from `UIScreen.main.bounds` before any scene existed, so it is sized here instead —
    // it is the same rectangle on a phone and a different one in an iPad or Mac window.
    window.windowScene = windowScene
    window.frame = windowScene.coordinateSpace.bounds
    window.makeKeyAndVisible()
    self.window = window

    // A URL or a handoff activity that cold-starts the app arrives in the connection options rather
    // than in the app delegate's launch options. React Native's `Linking.getInitialURL()` only reads
    // launch options, and by now `startReactNative` has already been given them, so the app delegate
    // gets the event instead. Hermie never receives links (ADR-0004 keeps the sign-in round trip
    // inside a WebView), but the dev client does — that is how the launcher opens a bundle.
    // Recorded before it is forwarded, because the forward is where it gets lost. See `launchURL`.
    if let first = connectionOptions.urlContexts.first {
      Self.launchURL = first.url
    }

    connectionOptions.urlContexts.forEach {
      open(url: $0.url, options: Self.openURLOptions(from: $0.options))
    }
    connectionOptions.userActivities.forEach { self.continue($0) }

    adoptStrayWindows(into: windowScene)
  }

  public func sceneDidDisconnect(_ scene: UIScene) {
    // Only this delegate's reference. The app delegate keeps holding the window, so a scene that
    // reconnects finds the same React root rather than a blank one.
    window = nil

    if let strayWindowObserver {
      NotificationCenter.default.removeObserver(strayWindowObserver)
      self.strayWindowObserver = nil
    }
  }

  public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    URLContexts.forEach { open(url: $0.url, options: Self.openURLOptions(from: $0.options)) }
  }

  public func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    self.continue(userActivity)
  }

  public func sceneDidBecomeActive(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationDidBecomeActive?(UIApplication.shared)
  }

  public func sceneWillResignActive(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationWillResignActive?(UIApplication.shared)
  }

  public func sceneWillEnterForeground(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationWillEnterForeground?(UIApplication.shared)
  }

  public func sceneDidEnterBackground(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationDidEnterBackground?(UIApplication.shared)
  }

  /**
   Keeps the window the size of its scene.

   Belt and braces: UIKit resizes a scene's full-screen window on rotation and when a Mac or
   Stage Manager window is dragged, and re-setting the same rectangle is a no-op when it does. It is
   here because this window was not created from the scene, so being sized by it is not something to
   assume — and an iPad or Mac window that stopped following its scene would be the failure mode.
   */
  public func windowScene(
    _ windowScene: UIWindowScene,
    didUpdate previousCoordinateSpace: UICoordinateSpace,
    interfaceOrientation previousInterfaceOrientation: UIInterfaceOrientation,
    traitCollection previousTraitCollection: UITraitCollection
  ) {
    window?.frame = windowScene.coordinateSpace.bounds
  }

  /**
   Gives a scene to any window that shows itself without one.

   `UIWindow(frame:)` plus `makeKeyAndVisible()` was how you put a second window on screen before
   scenes, and under the scene life cycle it is a no-op: a window with no `windowScene` belongs to no
   display and UIKit never draws it. expo-dev-menu builds its window exactly that way
   (`DevMenuWindow: super.init(frame: UIScreen.main.bounds)`), so with the manifest in place the dev
   menu opened onto nothing — measured against a copy of this same build with the manifest deleted,
   where it appears. Nothing in expo-dev-menu 6.0.x can be told otherwise from here.

   So watch for a window becoming visible with no scene and hand it this one. The guard makes it
   idempotent: re-showing the window posts the notification again, and by then it has a scene.
   Windows are a UIKit-wide mechanism rather than a dev-only one, so this is not `#if DEBUG` — but in
   practice a Release build creates no second window, and a `Modal` does not use one at all.
   */
  private func adoptStrayWindows(into windowScene: UIWindowScene) {
    strayWindowObserver = NotificationCenter.default.addObserver(
      forName: UIWindow.didBecomeVisibleNotification,
      object: nil,
      queue: .main
    ) { [weak windowScene] notification in
      guard let stray = notification.object as? UIWindow,
        stray.windowScene == nil,
        let windowScene else {
        return
      }
      stray.windowScene = windowScene
      stray.makeKeyAndVisible()
    }
  }

  private func open(url: URL, options: [UIApplication.OpenURLOptionsKey: Any]) {
    _ = UIApplication.shared.delegate?.application?(UIApplication.shared, open: url, options: options)
  }

  private func `continue`(_ userActivity: NSUserActivity) {
    // A tap on a Spotlight result is not a link and React Native does not know
    // what to do with one: `RCTLinkingManager` answers `NSUserActivityTypeBrowsingWeb`
    // and nothing else, so a bot found in search would open the app at whatever
    // screen it was last on. The item's unique identifier IS the deep link —
    // `HermieIntentsModule.indexBots` indexes each bot under its own
    // `hermie://chat/<name>` — so it is turned back into one here, which is the
    // only place both halves of that are visible.
    if userActivity.activityType == CSSearchableItemActionType,
      let identifier = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
      let url = URL(string: identifier) {
      // Recorded as well as forwarded, for the reason `launchURL` gives: on a
      // cold start this runs before JavaScript exists, and the forward is where
      // the event gets lost.
      Self.launchURL = url
      open(url: url, options: [:])

      return
    }

    _ = UIApplication.shared.delegate?.application?(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }

  /// The app delegate's method takes the application-level options, so the scene's are translated.
  private static func openURLOptions(
    from sceneOptions: UIScene.OpenURLOptions
  ) -> [UIApplication.OpenURLOptionsKey: Any] {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let sourceApplication = sceneOptions.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = sceneOptions.annotation {
      options[.annotation] = annotation
    }
    options[.openInPlace] = sceneOptions.openInPlace
    return options
  }
}
