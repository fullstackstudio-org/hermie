import ExpoModulesCore
import GameController
import UIKit

/**
 The three things JavaScript cannot find out for itself about a desktop keyboard.

 **`isMac`** — whether this process is the iOS app running on an Apple Silicon Mac.
 `ProcessInfo.processInfo.isiOSAppOnMac` is the only API that answers it, and React Native exposes
 nothing equivalent: `Platform.isMacCatalyst` reads the compile-time `TARGET_OS_MACCATALYST` flag,
 which is false for the unmodified iOS binary macOS runs as "Designed for iPad". A constant, because
 the answer is fixed for the lifetime of the process and the first render already needs it.

 **`isShiftDown`** — read synchronously while handling a Return, to tell Shift+Return from Return.
 UIKit will not say: a text field's `onKeyPress` payload carries no modifier state on iOS, and by the
 time it fires the insertion has already been accepted. GameController answers from the HID state
 instead, which is independent of the responder chain and of what happens to be first responder.

 **`onEscape`** — for the same reason, inverted. Escape inserts no text, so it never reaches a
 `UITextView` delegate at all, and a `UIKeyCommand` would have to live in the responder chain, which a
 presented `Modal` leaves — exactly the case that matters most, since a sheet is the main thing Escape
 should close. `keyChangedHandler` is below all of that.

 Nothing here needs an entitlement or an Info.plist key; GameController only asks to be linked, which
 the podspec does.

 **`onShortcut`** is the same mechanism as `onEscape`, widened to an allow-list of desktop
 shortcuts — ⌘K, ⌘,, ⌘W, ⌘⇧S, ⌘1…9, ⌘↑/↓ and ⌃Tab. It is deliberately NOT a general key event:
 nothing is emitted unless Command (or Control, for Tab and for ⌃⇧S) is held, so ordinary typing
 never crosses into JavaScript and a keystroke cannot be read off this seam. GameController rather
 than `UIKeyCommand` for the same reason Escape is: a presented `Modal` leaves the responder chain,
 and a shortcut that stops working while a sheet is open is a shortcut nobody trusts. The menu bar's
 own items reach the same place — see `HermieMenuBar`.

 Two things were added to it after the owner reported, on build 163, that typing `k` into the theme
 editor moved the caret to the chat list's search field:

 - **A modifier is not believed unless this process watched it go down.** `isPressed` is HID state
   and does not care which app is in front, so a Command released over another window stays down
   here for ever — and then every bare `k` is a ⌘K. That is the same failure the Shift latch was
   written for, one modifier over; it is now one mechanism for every modifier (`heldModifiers`).
 - **The event says whether a text input has the caret** (`typing`). This handler sits below the
   responder chain by design, which is what makes it survive a presented `Modal` — and also what
   means it cannot tell a shortcut from a keystroke. It does not decide: it reports, and
   `src/ui/useShortcut.ts` decides. The menu bar's own path reports `typing: false`, because a
   `UIKeyCommand` IS in the responder chain and the focused view has already declined it.

 **`readPasteboardAttachment`** answers the one thing ⌘V's report cannot carry: what is actually on
 `UIPasteboard.general`. It is a second step rather than part of `onShortcut` itself, because reading
 an image off the pasteboard only means something to the one caller that has somewhere to put one —
 see `HermiePasteboard` for the reasoning and `src/platform/native-paste.ts` for the JavaScript side.
 It never intercepts the paste itself: a plain-text ⌘V has already landed in the focused `UITextView`
 through the ordinary responder chain by the time this runs.

 **`devLaunchArguments`** is the last thing, and the only one that is not about keyboards. It is
 this process's own `ProcessInfo.processInfo.arguments`, which is how `xcrun simctl launch` can tell a
 running app to open on a particular screen — see `src/dev/launch-intent.ts` and the "Driving a
 simulator" section of docs/platform-notes.md. It is inside `#if DEBUG`, so a Release build has no
 such constant: the array is not merely empty, the key is absent, and `launch-intent.ts` then has
 nothing to read even before `__DEV__` gates it. That is deliberate belt and braces — a screen-opening
 back door is not something to leave one flag away from a shipped build.
 */
public class HermieMacModule: Module {
  private var connectObserver: NSObjectProtocol?
  private var activationObservers: [NSObjectProtocol] = []

  /**
   Every modifier this process has watched go DOWN and not yet watched come up.

   The polled HID state is not enough on its own, and the owner's report is what it looks like when
   it is trusted twice over. The first report was Return: it starts inserting a newline instead of
   sending, and pressing Shift once fixes it. The second was `k`: typed into a text field, it moved
   the focus to the chat list's search field, because Command was believed to be held.

   Both are the same fact. GameController delivers key changes to the app that is in front, so a
   modifier held while the window loses focus — ⇧-clicking something else, a ⌘-Tab away — has its
   key-UP delivered somewhere else, and `isPressed` stays true until the next press of that key
   corrects it. Nothing in the app can distinguish that from a modifier genuinely being held.

   So the answer is the AND of two sources that fail in different directions: the polled state,
   which can stick ON, and this set, which is cleared whenever the window becomes active again.
   Both must agree. A stale entry is impossible because activation clears it; a stale poll no
   longer reaches JavaScript because the set is empty until a modifier is pressed with this window
   in front.

   It was one `Bool` for Shift until build 163. Making it a set is not a generalisation for its own
   sake: Command was the one that shipped the bug, and a second copy of this reasoning for a second
   modifier is how the first one got missed.

   `UIKey.modifierFlags` in `pressesBegan` would be authoritative per event and was NOT used: the
   first responder while typing is React Native's own `RCTUITextView`, so reading the flag off the
   keystroke would mean subclassing or swizzling a renderer-owned class, and the failure this is
   about is the latch going stale rather than the poll being wrong in principle.
   */
  private var heldModifiers: Set<GCKeyCode> = []

  /** Every key this latch tracks. Anything outside it is not a modifier and is not latched. */
  private static let modifierKeys: Set<GCKeyCode> = [
    .leftShift, .rightShift,
    .leftControl, .rightControl,
    .leftGUI, .rightGUI,
    .leftAlt, .rightAlt
  ]

  public func definition() -> ModuleDefinition {
    Name("HermieMac")

    Events("onEscape", "onShortcut")

    #if DEBUG
      Constants([
        "isMac": ProcessInfo.processInfo.isiOSAppOnMac,
        "devLaunchArguments": ProcessInfo.processInfo.arguments
      ])
    #else
      Constants([
        "isMac": ProcessInfo.processInfo.isiOSAppOnMac
      ])
    #endif

    OnCreate {
      self.watchForKeyboards()
      self.watchForActivation()

      // The menu bar's items and the keyboard's shortcuts are the same actions, so they land on the
      // same event. `install()` is a no-op anywhere but a Mac, where the menu bar exists.
      // `typing: false`, whatever has the caret. A menu item's key equivalent is a `UIKeyCommand`
      // in the responder chain: the focused text view was offered this keystroke first and did not
      // take it, so the arbitration the keyboard path has to ask JavaScript for has already
      // happened here. See the class comment and `src/platform/desktop-shortcuts.ts`.
      HermieMenuBar.onCommand = { [weak self] action in
        self?.sendEvent("onShortcut", ["action": action, "typing": false])
      }
      HermieMenuBar.install()
    }

    OnDestroy {
      if let observer = self.connectObserver {
        NotificationCenter.default.removeObserver(observer)
        self.connectObserver = nil
      }
      for observer in self.activationObservers {
        NotificationCenter.default.removeObserver(observer)
      }
      self.activationObservers = []
      GCKeyboard.coalesced?.keyboardInput?.keyChangedHandler = nil
      HermieMenuBar.onCommand = nil
    }

    /**
     A secondary click's menu, as the platform draws it. See `HermieContextMenuView`.

     `items` is `[Any]` rather than a typed record because a menu is a tree; `HermieMenuNode` walks
     it. A malformed node is dropped rather than thrown: a menu with one line missing is recoverable
     and a chat list that throws while rendering a row is not.
     */
    View(HermieContextMenuView.self) {
      Events("onSelect")

      Prop("items") { (view: HermieContextMenuView, items: [Any]?) in
        view.setItems(items ?? [])
      }

      Prop("menuTitle") { (view: HermieContextMenuView, title: String?) in
        view.setMenuTitle(title)
      }

      Prop("enabled") { (view: HermieContextMenuView, enabled: Bool?) in
        view.setEnabled(enabled ?? true)
      }

      // Defaults to ON, because the view was built for list rows and that is what a row wants. The
      // transcript is the one caller that turns it off; see `setHoverEffect`.
      Prop("hoverEffect") { (view: HermieContextMenuView, hoverEffect: Bool?) in
        view.setHoverEffect(hoverEffect ?? true)
      }

      // The radius the row is drawn with, so UIKit's highlight is cut to the same shape instead of
      // laying a square block under a rounded row.
      Prop("cornerRadius") { (view: HermieContextMenuView, radius: Double?) in
        view.setCornerRadius(radius)
      }

      // Defaults to OFF, for the reason `setPassThroughButtons` gives: a list row IS the button, and
      // excluding it would exclude the whole row. `TranscriptList` is the one caller that turns it
      // on, because a transcript row's `Pressable`s — `Show more`, a tool card's own toggle — are
      // small controls inside a much larger menu target instead of being the target themselves.
      Prop("passThroughButtons") { (view: HermieContextMenuView, value: Bool?) in
        view.setPassThroughButtons(value ?? false)
      }
    }

    /**
     A message as ONE selectable rich text. See `HermieSelectableTextView`.

     `runs` is `[[String: Any]]` rather than a typed record for the same reason the menu's items
     are: the shape is produced by `src/markdown/attributed.ts` and will grow a field before this
     signature does, and a run whose keys are not the ones expected should lose its styling rather
     than take a panel down.
     */
    View(HermieSelectableTextView.self) {
      Prop("runs") { (view: HermieSelectableTextView, runs: [[String: Any]]?) in
        view.setRuns(runs ?? [])
      }

      Prop("fontSize") { (view: HermieSelectableTextView, size: Double?) in
        view.setFontSize(size)
      }

      Prop("textColor") { (view: HermieSelectableTextView, color: UIColor?) in
        view.setTextColor(color)
      }

      Prop("mutedColor") { (view: HermieSelectableTextView, color: UIColor?) in
        view.setMutedColor(color)
      }

      Prop("linkColor") { (view: HermieSelectableTextView, color: UIColor?) in
        view.setLinkColor(color)
      }

      Prop("codeBackground") { (view: HermieSelectableTextView, color: UIColor?) in
        view.setCodeBackground(color)
      }
    }

    /**
     The Hermie menu in the Mac's menu bar, spelled in the app's own language.

     Titles rather than a structure: the shape is fixed and lives in `HermieMenuBar`, and what
     JavaScript owns is the wording and which chats are visible. Async because it asks UIKit to
     rebuild the menu bar.
     */
    AsyncFunction("setMenuBar") { (titles: [String: String], chats: [String]) -> Void in
      HermieMenuBar.setMenuBar(titles: titles, chats: chats)
    }
    .runOnQueue(.main)

    /**
     A list that keeps its own edges. See `HermieScrollEdgeView`.

     No props: the view does one thing to the scroll view inside it, and a flag to turn that off
     would only ever be set one way. The call site is the wrapper itself.
     */
    View(HermieScrollEdgeView.self) {}

    /**
     Whether this binary registers `HermieScrollEdgeView`.

     The same probe `supportsSelectableText` is, for the same reason, added in the same change as
     the view it answers for.
     */
    Function("supportsPlainScrollEdges") { () -> Bool in
      true
    }

    /**
     Whether this binary registers `HermieSelectableTextView`.

     A probe, not a capability: it exists so JavaScript can ask the MODULE instead of asking for the
     view, because `requireNativeView` throws for one that is not registered and an older binary
     installed over a newer bundle is exactly the case that would hit it. Added in the same change as
     the view, so the answer is never wrong in the direction that throws.
     */
    Function("supportsSelectableText") { () -> Bool in
      true
    }

    /** Whether the menu bar hook reached the app delegate's class. Reported on the developer screen. */
    Function("isMenuBarInstalled") { () -> Bool in
      HermieMenuBar.isInstalled
    }

    /**
     Preview a file the way the platform previews files.

     `QLPreviewController`, presented over whatever is on screen — see `HermieQuickLook` for why it
     is presented from here rather than handed over as a view, and for what happens to a remote URL.

     Answers whether it was actually shown, so the caller can fall back to the share sheet for the
     refusals that are expected rather than exceptional: an unreadable path, a type with no
     previewer, a fetch that failed. It never throws, for the same reason — a rejected promise would
     make the caller tell those apart by reading a message.

     iOS API, not a Mac one: the phones and the iPad get the same previewer, which is what they
     should have had instead of a share sheet all along. The Mac is only what made it obvious.
     */
    AsyncFunction("previewFile") { (uri: String, name: String?) async -> Bool in
      // No `.runOnQueue(.main)`: an `async` closure builds a `ConcurrentFunctionDefinition`, which
      // has no such modifier at all — it runs on Swift's own executor. The main-thread hop happens
      // inside instead, because `HermieQuickLook` is `@MainActor`, which is the stronger guarantee:
      // the isolation is on the type that touches UIKit rather than on the call site.
      await HermieQuickLook.present(uri: uri, title: name)
    }

    /**
     Whether this binary can preview a file at all.

     The same kind of probe `supportsSelectableText` is, added in the same change as the function it
     answers for: an older binary under a newer bundle would otherwise have `previewFile` reject as
     a missing function, and the caller cannot tell that from a file it could not show.
     */
    Function("supportsQuickLook") { () -> Bool in
      true
    }

    /**
     Put text on the pasteboard.

     Here rather than through React Native's `Clipboard`, which is extracted from core and logs a
     deprecation warning on first access, and rather than through a new dependency for two lines of
     UIKit. The context menus' Copy items are the only callers.
     */
    Function("setClipboardString") { (text: String) -> Void in
      UIPasteboard.general.string = text
    }

    /**
     Empty the URL cache.

     There is exactly one caller and one reason. `URLCache` is keyed by bundle identifier and
     OUTLIVES the app: deleting Hermie and installing it again leaves the cache in place, so a 301
     stored when a gateway moved from one domain to another was still being served months later, to
     a fresh install, on its very first probe. The owner typed a correct address, the probe silently
     reached the host it had been redirected to, and the failure named the address they had typed.

     Called when a gateway is forgotten, which is the moment nothing cached for it is wanted any
     more. `removeAllCachedResponses` rather than a per-host removal, because a redirect is stored
     against the request that produced it and the app has no way to enumerate those.

     Foundation has no equivalent on a system with no shared cache, so the return value says whether
     there was one to empty rather than pretending.
     */
    Function("clearUrlCache") { () -> Bool in
      URLCache.shared.removeAllCachedResponses()

      return true
    }

    /**
     Whether either Shift key is down right now.

     Polled rather than pushed, deliberately: the caller already knows a Return happened and only
     needs the modifier that went with it, and a pushed modifier event would have to be raced against
     the Return it belongs to. `false` when nothing is plugged in, which is the honest answer on a
     phone and the reason this needs no platform check of its own.
     */
    Function("isShiftDown") { () -> Bool in
      // Both sources have to agree; see `heldModifiers` for why one of them alone is a bug the
      // owner can feel — Return stops sending until Shift is tapped once.
      guard let input = GCKeyboard.coalesced?.keyboardInput else {
        return false
      }

      return self.modifierIsDown(.leftShift, .rightShift, input: input)
    }

    /** Whether a hardware keyboard is attached at all. Reported on the developer screen. */
    Function("hasHardwareKeyboard") { () -> Bool in
      GCKeyboard.coalesced?.keyboardInput != nil
    }

    /**
     What the general pasteboard is holding, as an image or a file — never as text.

     Called from JavaScript after `onShortcut` reports ⌘V, not instead of the ordinary paste: see
     `HermiePasteboard` for why nothing here needs to intercept anything, and `src/platform/native-paste.ts`
     for the seam this answers. Each item is copied into the app's own tmp directory first, because the
     upload this feeds starts several turns later than the keystroke that produced it.
     */
    AsyncFunction("readPasteboardAttachment") { () -> [[String: Any]] in
      HermiePasteboard.attachments()
    }
    .runOnQueue(.main)

    /**
     Stop a MOUSE drag from scrolling the scroll view behind `viewTag`, without touching the wheel.

     On a Mac the owner drags across the transcript expecting to select text, and the list pans
     instead. That is UIKit doing what it is told: a "Designed for iPad" app gets full pointer
     support, an indirect-pointer drag is delivered to `UIScrollView` as a touch, and
     `panGestureRecognizer` accepts every touch type by default — so press-and-drag scrolls.

     Restricting `allowedTouchTypes` to `.direct` is the whole fix. It is the narrowest lever
     available: it tells that ONE recognizer to ignore a pointer while still accepting a finger, and
     a mouse wheel or a trackpad two-finger scroll never reaches it at all. Those arrive as scroll
     events, gated by `allowedScrollTypesMask`, which this does not touch — which is why the fix can
     stop the drag without also breaking the way everybody actually scrolls.

     Runs on the main queue because it reads the view registry and mutates a view. Returns whether a
     scroll view was actually found, so the caller can be tested and the developer screen can say.
     Never throws: a tag that resolves to nothing is a `false`, not an error, because this is called
     from a `ref` callback during layout and a broken reading surface is worse than an unfixed drag.
     */
    AsyncFunction("useDirectTouchPanOnly") { (viewTag: Int) -> Bool in
      guard let view = self.appContext?.findView(withTag: viewTag, ofType: UIView.self),
            let scrollView = Self.scrollView(for: view) else {
        return false
      }

      scrollView.panGestureRecognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]

      return true
    }
    .runOnQueue(.main)
  }

  /**
   The `UIScrollView` a React Native scroll component's view tag stands for.

   The tag belongs to the wrapper, not to the scroller: under Fabric it resolves to
   `RCTScrollViewComponentView`, whose single subview is the `RCTEnhancedScrollView` that actually
   scrolls, and under the old renderer to `RCTScrollView` with the same shape one level down. Both are
   covered by taking the SHALLOWEST `UIScrollView` at or below the tagged view.

   Shallowest, and depth-capped, on purpose. A transcript row can hold scroll views of its own — a
   wide code block, a markdown table — and an unbounded search would hand back one of those instead of
   the list, which would leave the list panning and quietly break the code block as well.
   */
  private static func scrollView(for view: UIView) -> UIScrollView? {
    if let scrollView = view as? UIScrollView {
      return scrollView
    }

    var level = view.subviews

    for _ in 0..<2 {
      if let scrollView = level.first(where: { $0 is UIScrollView }) as? UIScrollView {
        return scrollView
      }

      level = level.flatMap { $0.subviews }
    }

    return nil
  }

  /**
   Is a modifier REALLY down?

   The poll and the latch have to agree; see `heldModifiers` for the two ways each one lies. Either
   side of a pair satisfies it, because no shortcut on the table distinguishes left from right.
   */
  private func modifierIsDown(_ codes: GCKeyCode..., input: GCKeyboardInput) -> Bool {
    codes.contains { heldModifiers.contains($0) && input.button(forKeyCode: $0)?.isPressed == true }
  }

  /**
   Does a text view or a text field hold the caret right now?

   Walked from the key window's root rather than asked of UIKit, which has no public accessor for
   the first responder. `UITextInput` rather than the two concrete classes: React Native's own
   `RCTUITextView` is a `UITextView` and a `UISearchBar`'s field is neither, and what the question
   is really about is "would this keystroke have gone into something the reader is typing in".

   A read of the view hierarchy, so it runs on the main queue — which `keyChangedHandler` already
   does (`keyboard.handlerQueue = .main`).
   */
  private static func isTextInputFocused() -> Bool {
    guard let window = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .flatMap({ $0.windows })
      .first(where: { $0.isKeyWindow })
    else {
      return false
    }

    return firstResponder(in: window) is UITextInput
  }

  private static func firstResponder(in view: UIView) -> UIResponder? {
    if view.isFirstResponder {
      return view
    }

    for subview in view.subviews {
      if let found = firstResponder(in: subview) {
        return found
      }
    }

    return nil
  }

  /**
   A keyboard can arrive after launch — an iPad in a case, a Mac waking a Bluetooth keyboard — and the
   handler belongs to the keyboard rather than to the app, so it has to be reinstalled when one
   connects. All keyboards coalesce into a single object, so this fires once rather than per device.
   */
  private func watchForKeyboards() {
    connectObserver = NotificationCenter.default.addObserver(
      forName: NSNotification.Name.GCKeyboardDidConnect,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      // A keyboard that has just arrived cannot be holding a key this process watched go down, and
      // the state it reports for one is not this app's to trust.
      self?.heldModifiers = []
      self?.installEscapeHandler()
    }

    installEscapeHandler()
  }

  /**
   Forget every held modifier whenever this window becomes the active one.

   The key-UP for anything held while the window was in the background went to whatever was in
   front instead, so on the way back in the only honest state is "nothing is held". Both
   notifications are observed because they are not the same event: `UIScene.didActivateNotification`
   is per window — which on a Mac is the one that fires when the owner clicks back into Hermie — and
   `UIApplication.didBecomeActiveNotification` covers the process-level return that a scene-less
   path would take.
   */
  private func watchForActivation() {
    for name in [UIScene.didActivateNotification, UIApplication.didBecomeActiveNotification] {
      let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
        [weak self] _ in
        self?.heldModifiers = []
      }

      activationObservers.append(observer)
    }
  }

  private func installEscapeHandler() {
    guard let keyboard = GCKeyboard.coalesced, let input = keyboard.keyboardInput else {
      return
    }

    // The handler would otherwise run on GameController's own queue, and the event crosses into
    // JavaScript from here.
    keyboard.handlerQueue = .main

    input.keyChangedHandler = { [weak self] keyboardInput, _, keyCode, pressed in
      // Tracked for BOTH directions and before the guards below, because a release is exactly the
      // half the polled state can miss. Only while this app is in front: a modifier pressed for
      // another window is not a modifier this app should honour.
      if Self.modifierKeys.contains(keyCode) {
        if pressed, UIApplication.shared.applicationState == .active {
          self?.heldModifiers.insert(keyCode)
        } else {
          self?.heldModifiers.remove(keyCode)
        }
      }

      guard pressed else {
        return
      }

      // HID state does not care which app is in front. Without this guard, a keystroke meant for
      // another window could dismiss a sheet nobody is looking at.
      guard UIApplication.shared.applicationState == .active else {
        return
      }

      if keyCode == .escape {
        self?.sendEvent("onEscape", [:])

        return
      }

      if let action = self?.shortcut(for: keyCode, input: keyboardInput) {
        // Reported, not acted on. This handler is below the responder chain — which is what makes
        // it survive a presented `Modal` — so it cannot tell a shortcut from a keystroke meant for
        // the field the caret is in. `src/ui/useShortcut.ts` decides; see the type's comment.
        self?.sendEvent("onShortcut", ["action": action, "typing": Self.isTextInputFocused()])
      }
    }
  }

  /**
   The one desktop shortcut this key press stands for, or nothing.

   An ALLOW-LIST, and the reason is privacy rather than tidiness: this handler sees every key on the
   keyboard, below the responder chain and regardless of what is focused. Requiring a modifier and
   then matching a fixed table means a password typed into the composer produces no events at all —
   there is no path from a letter to JavaScript through here.

   Shift disqualifies everything EXCEPT the one shortcut that is defined with it. ⌘⇧K is not ⌘K, and
   a shortcut that fired for both would steal a keystroke some other part of the app may want later —
   so the sidebar's ⌘⇧S is matched on the whole combination FIRST, before that rule runs, rather than
   by loosening it. The table stays closed: ⇧ plus anything else still produces nothing.

   ⌃Tab is the one non-Command entry, because that is what it is on every platform, and ⌃⇧S is
   accepted alongside ⌘⇧S because an iPad with a PC keyboard in a case has no Command key to press.

   This table is a TRANSCRIPTION of `src/platform/desktop-shortcuts.shared.ts`'s `SHORTCUTS`, which
   is where a chord is decided. It cannot be generated from it — GameController hands over a
   `GCKeyCode` and nothing bridges that to a string on this side — but it is not allowed to drift in
   silence either: `__tests__/shortcut-table.test.ts` reads this file and fails when an action exists
   here and not there, or the other way round.

   An instance method since build 163, because a modifier is only believed when the poll and
   `heldModifiers` agree — and an allow-list that trusts the poll alone turns every bare letter on
   the table into its own chord the first time a Command is released over another window.
   */
  private func shortcut(for keyCode: GCKeyCode, input: GCKeyboardInput) -> String? {
    let shift = modifierIsDown(.leftShift, .rightShift, input: input)
    let control = modifierIsDown(.leftControl, .rightControl, input: input)
    let command = modifierIsDown(.leftGUI, .rightGUI, input: input)

    if keyCode == .keyS, shift, command || control {
      return "toggleSidebar"
    }

    if shift {
      return nil
    }

    if keyCode == .tab, control {
      return "nextChat"
    }

    // Bare ↑, ↓ and Tab, for the composer's slash list — the only unmodified keys on this table.
    // They can be here without weakening what it is for: none of the three inserts a character, so
    // nothing typed into a field still crosses into JavaScript. All three are ignored there unless a
    // suggestion list is actually open.
    if !command, !control {
      switch keyCode {
      case .upArrow:
        return "suggestionUp"
      case .downArrow:
        return "suggestionDown"
      case .tab:
        return "suggestionAccept"
      default:
        break
      }
    }

    guard command else {
      return nil
    }

    switch keyCode {
    case .keyK:
      return "search"
    case .comma:
      return "settings"
    case .keyW:
      return "close"
    case .keyN:
      return "newConversation"
    case .upArrow:
      return "previousChat"
    case .downArrow:
      return "nextChat"
    case .one:
      return "chat1"
    case .two:
      return "chat2"
    case .three:
      return "chat3"
    case .four:
      return "chat4"
    case .five:
      return "chat5"
    case .six:
      return "chat6"
    case .seven:
      return "chat7"
    case .eight:
      return "chat8"
    case .nine:
      return "chat9"
    case .keyV:
      return "paste"
    default:
      return nil
    }
  }
}
