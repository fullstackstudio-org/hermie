import ExpoModulesCore
import UIKit

/**
 A view whose secondary click — and whose long press — opens the PLATFORM's context menu.

 This exists because React Native has no secondary-click event at all. `Pressable` offers
 `onLongPress` and nothing else, so before this the chat list's row menu could only be a bottom
 sheet opened by a press and hold: a right click on a Mac or an iPad trackpad did not reach the app,
 and the sheet that did open was our own drawing rather than the menu the rest of the system uses.

 `UIContextMenuInteraction` is the whole answer, and it is worth being explicit about what comes
 free with it, because every one of these is something a custom sheet would have had to reimplement
 and get wrong:

 - a secondary click opens it immediately, a press and hold opens it after the system's own delay,
   and a trackpad's secondary click counts as the former;
 - the menu is the system's glass, at the system's size, in the system's position — including
   flipping above the row near the bottom of a window;
 - arrow keys move the highlight, Return selects, Escape dismisses, and none of that is our code;
 - the view under the pointer lifts into a preview, which is what makes "this menu belongs to THAT
   row" legible without a title.

 ## Children, and why this is a plain `ExpoView`

 The view draws nothing itself. It is a host: React lays its children out through Fabric exactly as
 it would inside a `View`, and the interaction is attached to the host. So the call site wraps what
 it already had rather than replacing it, and the fallback path is the same tree with the wrapper
 taken away.

 ## The menu is built on every open, not on every prop change

 `items` is stored and the `UIMenu` is assembled inside the action provider. A chat row's menu
 carries the row's own state — which colour is ticked, whether it says Archive or Unarchive, which
 sections exist — and that state changes while the menu is closed far more often than the menu is
 opened. Building late means the menu cannot be stale; building early would mean holding a
 `UIMenu` that has to be invalidated by hand.

 ## What it deliberately does not do

 There is no `onOpen`/`onClose` pair. Nothing in the app needs to know, and a JavaScript round trip
 per open is a round trip that can arrive after the menu has already gone.
 */
public final class HermieContextMenuView: ExpoView, UIContextMenuInteractionDelegate, UIPointerInteractionDelegate {
  private let onSelect = EventDispatcher()

  private var items: [HermieMenuNode] = []
  private var menuTitle = ""
  private var enabled = true
  private var hoverEffect = true
  private var cornerRadius: CGFloat = 0
  /** Held so it can be taken away again; a prop can turn the effect off after it was on. */
  private var pointerInteraction: UIPointerInteraction?
  /** Off by default; see `setPassThroughButtons` for what turns it on and why. */
  private var passThroughButtons = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    addInteraction(UIContextMenuInteraction(delegate: self))
    // The pointer interaction is NOT added here. It is added only where the effect is wanted —
    // see `setHoverEffect`, and the note there about what a pointer interaction on a view the size
    // of a transcript actually draws.
    applyHoverStyle()
  }

  func setItems(_ raw: [Any]) {
    items = HermieMenuNode.parse(raw)
  }

  func setMenuTitle(_ title: String?) {
    menuTitle = title ?? ""
  }

  func setEnabled(_ value: Bool) {
    enabled = value
  }

  /**
   Whether the pointer may draw anything on this view while it merely passes over.

   ON for a LIST ROW, which is what this view was built for: a chat row, a cron row, a bot in the
   sidebar. A row-sized highlight under the pointer is what tells a reader the row is a thing they
   can act on, and it is the same effect the rest of the system draws.

   OFF for a TRANSCRIPT row, and the owner's report is why: a transcript row is as wide as the
   window and as tall as a reply, so the same effect is a blurred platter the size of the message,
   appearing and disappearing as the mouse crosses the conversation. Nothing about a paragraph of
   text is a button, and a reader moving the pointer towards the composer should not set off a
   highlight on the way past.

   Two levers, because the effect has two halves: the pointer style, answered below, and the
   highlight preview UIKit composites behind the view — which is the blur itself, and is cleared by
   handing back preview parameters with no background.
   */
  func setHoverEffect(_ value: Bool) {
    hoverEffect = value
    applyHoverStyle()
  }

  /**
   The two levers that decide whether a pointer may draw anything here, set together.

   This is the fix for "the whole conversation goes blurry when the mouse enters the window", and
   the shape of that bug is worth writing down because the previous attempt looked right:

   - The view had a `UIPointerInteraction` added in `init`, unconditionally, and answered
     `styleFor:` with `UIPointerStyle.system()` where the effect was meant to be OFF. That is not
     "no effect" — it is the system's own hover treatment, which for a view with a context menu is
     a highlight platter composited from a `UITargetedPreview` of the WHOLE view. The whole view,
     here, is the transcript: one host wraps the list, so the platter was a blurred copy of every
     bubble at once. The sidebar and the floating header stayed sharp because they are different
     views, which is exactly what the screenshot showed.
   - `previewForHighlightingMenuWithConfiguration` could never have corrected it. That delegate
     method belongs to the CONTEXT MENU interaction and is consulted when the menu comes up; the
     pointer effect builds its own preview and never asks.

   So where the effect is off there is now no pointer interaction to ask, and `hoverStyle` — the
   iOS 17 property that is how UIKit applies an automatic hover effect to any view, with or without
   an interaction — is explicitly nil. Where it is on, the same property carries the radius the row
   handed over, which is a better fit than the preview parameters were: it is the hover API saying
   what hover should look like.
   */
  private func applyHoverStyle() {
    if hoverEffect {
      if pointerInteraction == nil {
        let interaction = UIPointerInteraction(delegate: self)

        pointerInteraction = interaction
        addInteraction(interaction)
      }
    } else if let interaction = pointerInteraction {
      removeInteraction(interaction)
      pointerInteraction = nil
    }

    guard #available(iOS 17.0, *) else {
      return
    }

    hoverStyle =
      hoverEffect
        ? UIHoverStyle(shape: cornerRadius > 0 ? .rect(cornerRadius: cornerRadius) : .rect)
        : nil
  }

  public func pointerInteraction(
    _ interaction: UIPointerInteraction,
    styleFor region: UIPointerRegion
  ) -> UIPointerStyle? {
    // Only ever reached where the effect is wanted, and nil there means "UIKit's own", which is
    // the row highlight this view exists to keep. The interaction is not installed at all
    // otherwise — see `applyHoverStyle`.
    nil
  }

  /**
   The corners the platter is cut to, when there is one.

   UIKit's default highlight is a RECTANGLE around the whole host view, and the owner's report is
   what that looks like on a chat row: a square grey block under a row whose own selected state is a
   rounded pill. The row knows its radius and this view does not, so the row hands it over — the
   same `radii.card` its selected surface uses, which is what makes the two states look like one
   control in two moods.

   Zero means "no radius given", and the platter keeps UIKit's square default.
   */
  func setCornerRadius(_ value: Double?) {
    cornerRadius = value.map { CGFloat($0) } ?? 0
    applyHoverStyle()
  }

  /**
   Whether a touch that lands on a nested button should be invisible to this interaction.

   OFF for a LIST ROW, where the row itself IS the button — `BotRow`, a cron row — and a secondary
   click anywhere on it is supposed to open the menu; excluding button-shaped touches there would
   exclude the whole row and leave nothing to right-click at all. ON for a TRANSCRIPT row, whose
   `Pressable`s are small controls INSIDE a much larger menu target: `Show more` on a folded reply,
   a tool card's own disclosure, a reasoning toggle. `TranscriptList` is the one caller that turns
   this on; see `configurationForMenuAtLocation` for the mechanism it enables.
   */
  func setPassThroughButtons(_ value: Bool) {
    passThroughButtons = value
  }

  /**
   Is `location` over a control this interaction should leave alone?

   The owner's report was a mouse click on `Show more` that sometimes did nothing — no menu, no
   fold, nothing UIKit or the fold's own `Pressable` visibly did. `Show more` sits fully inside this
   view's bounds, and a "Designed for iPad" app delivers an indirect-pointer click as a touch (see
   `pointer-drag.ts`), which is exactly the kind of touch `UIContextMenuInteraction` also has to
   evaluate — even a plain click can turn into the press-and-hold that opens the menu, so this
   delegate is asked about a location before UIKit knows which one the reader meant. Answering
   `nil` there is not a workaround: it is the documented way to tell the interaction a location is
   not its concern, and it is what stops it competing with the `Pressable` underneath for the same
   touch AT ALL, rather than racing it and sometimes losing.

   Walked from the HIT view up to (but not including) this one, because the touch lands on whatever
   is drawn on top — the toggle's own `Text`, say — and the `.button` trait is set on the `Pressable`
   above it, not on every descendant. `UIControl` is checked too for a control that is not React
   Native's, though nothing in this app currently renders one inside a transcript row.
   */
  private func isOverPassedThroughButton(at location: CGPoint) -> Bool {
    guard passThroughButtons, let hit = hitTest(location, with: nil) else {
      return false
    }

    var view: UIView? = hit

    while let current = view, current !== self {
      if current.accessibilityTraits.contains(.button) || current is UIControl {
        return true
      }

      view = current.superview
    }

    return false
  }

  /**
   The platter UIKit draws behind the view while the MENU is coming up.

   Only the menu. It was once believed to cover the pointer's hover platter as well, and that
   belief is what let the hover bug survive a round: the pointer effect builds its own preview and
   never calls this. Hover is `applyHoverStyle` above; this is the lift under an opening menu.

   `nil` hands back UIKit's own: the whole view, on a SQUARE background.
   */
  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    // No effect at all, and no radius worth having: leave UIKit its default.
    guard !hoverEffect || cornerRadius > 0 else {
      return nil
    }

    let parameters = UIPreviewParameters()

    // Clear where the effect is off — nothing is drawn behind the view at all. Where it is ON, the
    // platter stays and only its corners change, because the platter IS the affordance on a row.
    if !hoverEffect {
      parameters.backgroundColor = .clear
    }

    parameters.visiblePath =
      cornerRadius > 0
        ? UIBezierPath(roundedRect: bounds, cornerRadius: cornerRadius)
        : UIBezierPath(rect: bounds)

    return UITargetedPreview(view: self, parameters: parameters)
  }

  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    // No items is not an empty menu, it is no menu: returning a configuration would put an empty
    // grey rectangle under the pointer and swallow the gesture. A button this view was told to
    // pass through is the same answer for a different reason — see `isOverPassedThroughButton`.
    guard enabled, !items.isEmpty, !isOverPassedThroughButton(at: location) else {
      return nil
    }

    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      guard let self else {
        return nil
      }

      return UIMenu(
        title: self.menuTitle,
        children: self.items.map { node in
          node.element { id in
            // The dictionary is the event payload; `id` is what the call site switches on.
            self.onSelect(["id": id])
          }
        }
      )
    }
  }
}
