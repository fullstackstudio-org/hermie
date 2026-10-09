import SwiftUI

/// The shape the composer has: a pill at rest, a card when it is in use.
///
/// At rest (the caret is not in the field, it holds no words or files, and the microphone is not open)
/// the composer is one floating capsule with everything on one line. As soon as the reader focuses the
/// field, or there is something in it, it opens into a card: the field on top and a row of buttons under
/// it. Where the device has a pointer (the Mac) it is the card always (`alwaysCard`).
enum ComposerPresentation: Equatable, Sendable {
  case pill, card

  static func resolve(focused: Bool, hasContent: Bool, listening: Bool, alwaysCard: Bool) -> Self {
    alwaysCard || focused || hasContent || listening ? .card : .pill
  }
}

/// The part a composer view plays in `ComposerCardLayout`.
enum ComposerSlotRole: Sendable {
  /// The text field: the middle of the pill, the top of the card.
  case field
  /// The plus: at the leading end of the pill, of the card's lower row.
  case leading
  /// Dictation and the round button: at the trailing end, in the order they are given.
  case trailing
}

private struct ComposerSlotKey: LayoutValueKey {
  static let defaultValue = ComposerSlotRole.field
}

extension View {
  /// Which part of the composer's capsule this view is.
  func composerSlot(_ role: ComposerSlotRole) -> some View {
    layoutValue(key: ComposerSlotKey.self, value: role)
  }
}

/// Lays the composer's views out as a pill or as a card (`ComposerPresentation`), from the same four
/// views: the field is never rebuilt, so it keeps its caret and the keyboard while the shape changes
/// under it, and SwiftUI animates the views from one place to the other.
///
/// - The pill: one row, `[leading] [field] [trailing…]`, as tall as one line of the field plus the
///   inset on both sides, and centred on that line.
/// - The card: the field across the full width above a row with the leading button at the left and
///   the trailing buttons at the right. The field grows and the row stays under it.
struct ComposerCardLayout: Layout {
  var card: Bool
  /// The height of one line of the field.
  var lineHeight: CGFloat
  /// The size of the round buttons.
  var buttonSize: CGFloat
  /// The room between the edge and what is inside it.
  var inset: CGFloat

  /// A width to answer a probe (none, or an infinite one) with.
  private static let probeWidth: CGFloat = 320

  /// Where everything goes, for a width.
  struct Frames {
    var field: CGRect
    var leading: [CGRect]
    var trailing: [CGRect]
    var height: CGFloat
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = Self.usable(proposal.width)
    return CGSize(width: width, height: frames(width: width, subviews: subviews).height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let frames = frames(width: bounds.width, subviews: subviews)
    var leading = frames.leading[...]
    var trailing = frames.trailing[...]

    for subview in subviews {
      let frame: CGRect
      switch subview[ComposerSlotKey.self] {
      case .field:
        frame = frames.field
      case .leading:
        frame = leading.popFirst() ?? .zero
      case .trailing:
        frame = trailing.popFirst() ?? .zero
      }

      subview.place(
        at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
        proposal: ProposedViewSize(width: frame.width, height: frame.height))
    }
  }

  private static func usable(_ width: CGFloat?) -> CGFloat {
    guard let width, width.isFinite, width > 0 else { return probeWidth }
    return width
  }

  private func frames(width: CGFloat, subviews: Subviews) -> Frames {
    let field = subviews.first { $0[ComposerSlotKey.self] == .field }
    let leadingSizes = subviews.filter { $0[ComposerSlotKey.self] == .leading }.map { $0.sizeThatFits(.unspecified) }
    let trailingSizes = subviews.filter { $0[ComposerSlotKey.self] == .trailing }.map { $0.sizeThatFits(.unspecified) }
    let leadingWidth = leadingSizes.reduce(0) { $0 + $1.width }
    let trailingWidth = trailingSizes.reduce(0) { $0 + $1.width }
    let rowHeight = card ? buttonSize : lineHeight

    // The row of buttons, left and right, centred on `centreY`.
    func row(centreY: CGFloat) -> (leading: [CGRect], trailing: [CGRect]) {
      var x = inset
      let leading = leadingSizes.map { size -> CGRect in
        defer { x += size.width }
        return CGRect(x: x, y: centreY - size.height / 2, width: size.width, height: size.height)
      }

      x = width - inset - trailingWidth
      let trailing = trailingSizes.map { size -> CGRect in
        defer { x += size.width }
        return CGRect(x: x, y: centreY - size.height / 2, width: size.width, height: size.height)
      }

      return (leading, trailing)
    }

    if card {
      let fieldWidth = max(0, width - inset * 2)
      let fieldHeight = field?.sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil)).height ?? lineHeight
      let rowTop = inset + fieldHeight
      let buttons = row(centreY: rowTop + rowHeight / 2)

      return Frames(
        field: CGRect(x: inset, y: inset, width: fieldWidth, height: fieldHeight),
        leading: buttons.leading, trailing: buttons.trailing,
        height: rowTop + rowHeight + inset)
    }

    let fieldX = inset + leadingWidth
    let fieldWidth = max(0, width - fieldX - trailingWidth - inset)
    let fieldHeight = field?.sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil)).height ?? lineHeight
    let height = max(fieldHeight, rowHeight) + inset * 2
    let buttons = row(centreY: height / 2)

    return Frames(
      field: CGRect(x: fieldX, y: (height - fieldHeight) / 2, width: fieldWidth, height: fieldHeight),
      leading: buttons.leading, trailing: buttons.trailing, height: height)
  }
}

/// The composer's round button, ChatGPT's: the app's accent blue with a white glyph (an arrow to send,
/// a square to stop, a waveform to talk), and when there is nothing to send a quiet grey disc whose
/// glyph is still plainly there (a disabled prominent button drew dark on the dark bar and all but
/// vanished).
struct SendButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(isEnabled ? AnyShapeStyle(Color.white) : AnyShapeStyle(.secondary))
      .background(fill, in: .circle.inset(by: Self.discInset))
      // Glass only on the grey disc: glass over the solid blue lightened it under the white glyph
      // until the accessibility audit failed its contrast (the coloured button is plain).
      .glassEffect(isEnabled ? .identity : .regular, in: .circle.inset(by: Self.discInset))
      .opacity(configuration.isPressed ? 0.75 : 1)
      .contentShape(.circle)
  }

  private var fill: AnyShapeStyle {
    isEnabled ? AnyShapeStyle(BubblePalette.outgoing) : AnyShapeStyle(.fill.secondary)
  }

  /// The disc is a little smaller than the touch target it sits in.
  static let discInset: CGFloat = 2

  /// A deeper red than the system's: white on it is 5.4:1 (on the system red, 3.6:1). The microphone's
  /// while it listens.
  static let stopRed = Color(red: 0xD7 / 255, green: 0x00 / 255, blue: 0x15 / 255)
}

/// The plus beside the field: a plain glyph with no disc, as ChatGPT draws it, the colour of the text.
/// Dimmed, not recoloured, when it is disabled.
struct AttachButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(.primary)
      .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.4)
      .contentShape(.circle)
  }
}
