import SwiftUI
import WidgetKit

/**
 The pieces every family draws: an avatar, a bead, a row, and the empty state.

 Kept together because the three widgets are three croppings of one design rather than three
 designs, and a bead that is 8pt on the small widget and 9pt on the medium one is the kind of drift
 nobody reports and everybody sees.
 */

/** The bot's own picture, or the initials on its chat colour — the same fallback `Avatar` has. */
struct HermieAvatar: View {
  let bot: HermieBot
  var size: CGFloat = 38

  var body: some View {
    let image = HermieWidgetStore.avatar(at: bot.avatarPath)

    ZStack {
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
      } else {
        Color(hexString: bot.colour)
        Text(bot.initials)
          .font(.system(size: size * 0.44, weight: .semibold))
          // White, because `snapshot.ts` sends the accent value white is AA on.
          .foregroundStyle(.white)
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
  }
}

/** The four-state bead, drawn on the avatar the way the chat list draws it. */
struct HermiePresenceBead: View {
  let presence: String
  let colors: HermieColors
  var size: CGFloat = 11

  var body: some View {
    Circle()
      .fill(colors.presence(presence))
      .frame(width: size, height: size)
      // The ring is the surface colour rather than a border, so the bead reads as sitting ON the
      // avatar rather than as a hole in it — which is what it looks like against a dark picture.
      .overlay(Circle().stroke(colors.surface, lineWidth: 2))
  }
}

/** Avatar plus bead, as one unit, so the bead's offset is decided once. */
struct HermieAvatarWithBead: View {
  let bot: HermieBot
  let colors: HermieColors
  var size: CGFloat = 38

  var body: some View {
    HermieAvatar(bot: bot, size: size)
      .overlay(alignment: .bottomTrailing) {
        HermiePresenceBead(presence: bot.presence, colors: colors, size: size * 0.29)
          .offset(x: 1, y: 1)
      }
  }
}

/**
 The badge on the medium widget: an unread count, or a dot for "needs input".

 Needs input wins over a count, for the reason `presence.ts` gives: a question aimed at a person
 outranks the fact that some messages arrived. Nothing is drawn when there is neither, rather than
 a zero.
 */
struct HermieBadge: View {
  let bot: HermieBot
  let colors: HermieColors

  var body: some View {
    if bot.needsInput {
      Circle()
        .fill(colors.presence("needsInput"))
        .frame(width: 10, height: 10)
    } else if bot.unread > 0 {
      Text(bot.unread > 99 ? "99+" : "\(bot.unread)")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(colors.accent))
    }
  }
}

/** One conversation on the medium widget. */
struct HermieRow: View {
  let bot: HermieBot
  let colors: HermieColors

  var body: some View {
    HStack(spacing: 9) {
      HermieAvatarWithBead(bot: bot, colors: colors, size: 30)

      VStack(alignment: .leading, spacing: 1) {
        Text(bot.displayName)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(colors.text)
          .lineLimit(1)

        Text(bot.lastLine.isEmpty ? " " : bot.lastLine)
          .font(.system(size: 12))
          .foregroundStyle(colors.muted)
          .lineLimit(1)
      }

      Spacer(minLength: 4)

      HermieBadge(bot: bot, colors: colors)
    }
  }
}

/**
 What is drawn when there is no snapshot.

 Three different situations produce it — the app has not run since the widget was added, the App
 Group did not reach one of the signed binaries, or the file's version moved — and the widget
 cannot tell them apart. So it says the one thing that is true of all three and is also the thing
 to do about it.
 */
struct HermieEmpty: View {
  let colors: HermieColors

  var body: some View {
    VStack(spacing: 4) {
      Text("Hermie")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(colors.text)
      Text("Open Hermie to fill this in.")
        .font(.system(size: 12))
        .foregroundStyle(colors.muted)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

extension View {
  /**
   The widget's own background, which iOS 17 requires a widget to declare.

   A flat colour and not a material: a widget is composited onto the reader's wallpaper by the
   system and gets no blur of its own, so the Liquid Glass surfaces the app draws have nothing to
   be glass against here. This is the `e1` rung those surfaces fall back to everywhere else that
   has no blur — Android, Reduce Transparency, a test renderer — so it is the same answer rather
   than a new one.
   */
  func hermieContainerBackground(_ colors: HermieColors) -> some View {
    containerBackground(for: .widget) {
      colors.surface
    }
  }
}
