import ExpoModulesCore
import UIKit

/**
 A host whose scrolling child keeps its own edges: no automatic scroll edge effect.

 ## What the effect is, and what it did here

 iOS 26 gives every `UIScrollView` a scroll edge effect — a soft blur UIKit draws where content
 passes under a bar, so the bar's glass has something to sit on. It is automatic: an app built
 against the iOS 26 SDK gets one per scroll view without asking, and the only way out is
 `UIScrollEdgeEffect.isHidden` on the scroll view itself, which React Native does not expose.

 On the Mac build that effect is what turned the whole conversation blurry as soon as the pointer
 entered it, and the shape of the bug is worth writing down because it survived two fixes aimed at
 the wrong thing:

 - the effect's view is the size of the WHOLE scroll view, not of a band at its edge — a
   `ScrollEdgeEffectView` of 990×924 over a transcript of 990×924, holding a backdrop with a
   `gaussianBlur` filter on it;
 - it sits at `alpha` 0 and fades to 1 when the POINTER enters the scroll view, which is why it
   looked like a hover effect and why nothing showed on an iPad or in a screenshot taken without a
   mouse;
 - the sidebar and the floating header stayed sharp because they are not inside that scroll view.

 Observed rather than reasoned: a debug build walked the live view hierarchy while a synthetic
 `CGEvent` moved the pointer onto the transcript, and the ONLY difference between the resting and
 the hovered hierarchy was that view's alpha. The two earlier attempts changed
 `UIPointerInteraction` and `UIHoverStyle` on `HermieContextMenuView`, which are a different
 mechanism on a per-ROW view, and could not have touched it.

 ## Why the app wants none of it anywhere

 Hermie draws its own glass: a floating header over the top of the transcript and a composer over
 the bottom, both `GlassSurface`s with the real material. UIKit's effect is a second, uninvited blur
 for the same purpose, and it has no way of knowing where those two surfaces are — it is told
 nothing, because the header and the composer are siblings that overlap the list rather than bars
 the scroll view was given as insets.

 ## Why a wrapper rather than a prop

 The scroll view belongs to React Native. `RCTScrollViewComponentView` creates the
 `RCTEnhancedScrollView` inside it and exposes no seam for this, so the nearest honest handle is the
 view that CONTAINS the list: this one finds the outermost scroll view under it and takes the effect
 off. Breadth first, because a text view is a scroll view too and one inside a message must not be
 mistaken for the list.

 `layoutSubviews` rather than `didMoveToWindow`: the children arrive on their own schedule and a
 recycled list can hand over a different scroll view later, so the answer is re-checked where it is
 free to check and only written where it is not already true.
 */
public final class HermieScrollEdgeView: ExpoView {
  public override func layoutSubviews() {
    super.layoutSubviews()

    guard #available(iOS 26.0, *), let scroll = outermostScrollView() else {
      return
    }

    // Already ours: the common case on every layout pass after the first.
    guard !scroll.topEdgeEffect.isHidden || !scroll.bottomEdgeEffect.isHidden else {
      return
    }

    scroll.topEdgeEffect.isHidden = true
    scroll.bottomEdgeEffect.isHidden = true
    scroll.leftEdgeEffect.isHidden = true
    scroll.rightEdgeEffect.isHidden = true
  }

  /**
   The first scroll view under this one, nearest first.

   Breadth first on purpose. `RCTUITextView` is a `UIScrollView`, and so is every list inside a
   card, so a depth-first walk down the first branch could return something from inside a row
   instead of the row's own list.
   */
  private func outermostScrollView() -> UIScrollView? {
    var queue = subviews

    while !queue.isEmpty {
      let view = queue.removeFirst()

      if let scroll = view as? UIScrollView {
        return scroll
      }

      queue.append(contentsOf: view.subviews)
    }

    return nil
  }
}
