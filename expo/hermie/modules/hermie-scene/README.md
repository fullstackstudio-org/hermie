# hermie-scene

One Swift class, no JavaScript: the `UIWindowSceneDelegate` that lets the app launch on iOS 27.

## Why it exists

iOS 27 made the UIKit scene life cycle mandatory for anything linked against its SDK. While the first
scene connects, UIKit runs `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, and with
no `UIApplicationSceneManifest` in the bundle it traps:

```
EXC_BREAKPOINT (SIGTRAP), main thread
UIKitCore ___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke
UIKitCore -[UIApplication workspace:didCreateScene:withTransitionContext:completion:]
"Application failed to launch: UIScene life cycle is required for apps built with this SDK."
```

Nothing of ours is on that stack and no JavaScript has run, which is why it reads as an app that
never started. Expo SDK 54's template is an application-life-cycle app: `AppDelegate` creates the
`UIWindow` and starts React Native into it, and there is no `UIApplicationSceneManifest` anywhere in
the tree. Expo adopted scenes in SDK 58 and back-ported an opt-in to SDK 57.0.23
(`expo-build-properties`' `ios.enableSceneSupport`); neither reaches this SDK line, so this module
is the local equivalent until the app upgrades — see
[docs/adr/0001-expo-sdk-54-rn-081.md](../../../../docs/adr/0001-expo-sdk-54-rn-081.md).

## Why a module and not a file in the Xcode project

`Info.plist` names the scene delegate by class, and UIKit resolves that name through the Objective-C
runtime, so the class does not have to be in the app target — Expo ships its own
`EXExpoAppSceneDelegate` from the `expo` pod exactly this way. A local module under
`expo/hermie/modules/` is autolinked with no configuration, so `ios/` stays fully generated and
nothing has to be inserted into `project.pbxproj` and re-inserted after every
`expo prebuild --clean`.

Two details keep that working:

- **`-ObjC`.** Nothing references `HermieSceneDelegate` at compile time; it is found by a string. In a
  static library that is exactly the object file a linker drops. The app target's `OTHER_LDFLAGS`
  already carries `-ObjC` (CocoaPods puts it there), which loads every object file that defines an
  Objective-C class, and `@objc(HermieSceneDelegate)` makes this one of them.
- **`expo-module.config.json` declares no modules.** `apple.modules` is an empty list, so autolinking
  links the pod and registers nothing with `ExpoModulesCore`; there is no JavaScript side to register.
  The podspec therefore does not depend on `ExpoModulesCore` either.

The manifest half lives in
[`plugins/with-ios-scene-lifecycle.js`](../../plugins/with-ios-scene-lifecycle.js), which also fails
the prebuild if the generated `AppDelegate` stops having the shape this class adopts.

## What it does, and the one thing it does not

It adopts the window the app delegate already made — it does not create one. The upstream migration
and React Native's own template move window creation into `scene(_:willConnectTo:options:)`, and on
SDK 54 that is a crash rather than an improvement: `ExpoDevLauncherAppDelegateSubscriber` looks for
`UIApplication.shared.delegate?.window` during `application(_:didFinishLaunchingWithOptions:)` and
calls `fatalError` when there is none. A scene connects after that returns, so every Debug build
would die on the dev client instead of on UIKit.

Keeping the window where SDK 54 puts it is also what keeps expo-splash-screen handing over (it
attaches the launch storyboard to the React _root view_, never to the window) and what keeps
expo-system-ui finding a window at all.

So `scene(_:willConnectTo:options:)` attaches that window to the connecting window scene, sizes it to
the scene, and makes it key. The rest of the class re-feeds the app delegate the events UIKit stops
sending it once a scene delegate exists: URLs, user activities and the four life-cycle callbacks.
`AppState` needs none of that — `RCTAppState` listens to `UIApplicationDidBecomeActive` and its
siblings on `NotificationCenter`, and those keep being posted under the scene life cycle.
