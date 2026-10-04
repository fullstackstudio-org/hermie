import SwiftUI

/// What a transcript list knows about its own scrolling, and the commands a
/// screen can give it.
///
/// The chat screen owns one per open chat and hands it to `TranscriptList`. It
/// is the whole contract between the two, so the list's implementation can
/// change (see "Transcript list" in docs/native.md) without the screen noticing.
///
/// Only `isAtBottom` is observed by views: it changes when the reader crosses
/// the threshold, not on every scrolled point, so the jump pill reading it does
/// not re-render while the list scrolls. Everything else is
/// `@ObservationIgnored` on purpose.
@MainActor
@Observable
public final class TranscriptListState {
  /// The reader is within `bottomThreshold` of the newest row. While this is
  /// true the list follows a reply as it grows; while it is false the pill
  /// shows and nothing moves under the reader.
  public internal(set) var isAtBottom = true

  /// How close to the bottom still counts as "at the bottom", in points. 32 is
  /// what the Expo app's pill uses.
  @ObservationIgnored public var bottomThreshold: CGFloat = 32

  /// How close to the top, in points, asks for older history.
  @ObservationIgnored public var nearTopThreshold: CGFloat = 800

  /// Called once each time the reader comes within `nearTopThreshold` of the
  /// top, to load older history. Prepending rows keeps the reader's place.
  @ObservationIgnored public var onNearTop: (@MainActor () -> Void)?

  /// The list has laid its rows out, so a scroll to a row it is asked for will be carried out. The
  /// collection view on iPhone and iPad loads its first rows only once it is in a window with a width,
  /// and drops a command for a row it does not have yet: it says so here (false until then), and a
  /// screen that wants a row scrolled to waits for it. The other lists are ready as they are made.
  @ObservationIgnored public internal(set) var rowsLaidOut = true

  /// The id of the row at the top of the viewport, as the list last reported
  /// it. Not observed: read it when you need it.
  @ObservationIgnored public internal(set) var topVisibleID: AnyHashable?

  /// A command waiting for the list to carry it out.
  enum Command: Equatable {
    case bottom(animated: Bool)
    case item(AnyHashable, anchor: UnitPoint, animated: Bool)
    /// Moves the content by this many points, unanimated: the lab's stand-in
    /// for a reader's continuous scrolling.
    case pan(CGFloat)
  }

  /// The content offset as the list last reported it. Debug use only.
  @ObservationIgnored var contentOffset: CGFloat = 0

  /// The list's geometry as one line (bounds, content size, insets, window, rows), for the chat's
  /// diagnostics. Set by the collection-view lists; nil for the others.
  @ObservationIgnored var geometry: (@MainActor () -> String)?

  /// Scrolls by `delta` points (positive: towards newer rows), as a finger
  /// would. For the transcript lab's hands-off measurements.
  func pan(by delta: CGFloat) {
    command = .pan(delta)
    commandSerial &+= 1
  }

  @ObservationIgnored var command: Command?
  /// Bumped with every command; the list watches it.
  var commandSerial = 0
  @ObservationIgnored var nearTopArmed = true

  public init() {}

  /// Scrolls to the newest row, and resumes following it.
  public func scrollToBottom(animated: Bool = true) {
    command = .bottom(animated: animated)
    commandSerial &+= 1
  }

  /// The reader sent a message: the list goes to the very bottom and follows
  /// from there, the new bubble and the reply after it included, wherever the
  /// reader had scrolled to. (A message that arrives from elsewhere never moves
  /// a reader who scrolled up; only their own send does.) Animated only when it
  /// is a jump from a place higher up.
  public func followOwnSend() {
    scrollToBottom(animated: !isAtBottom)
  }

  /// Scrolls so the row with `id` sits at `anchor` of the viewport.
  public func scroll(to id: some Hashable & Sendable, anchor: UnitPoint = .top, animated: Bool = true) {
    command = .item(AnyHashable(id), anchor: anchor, animated: animated)
    commandSerial &+= 1
  }

  /// Calls `onNearTop` after the current update, never inside it: the prepend
  /// it starts moves the content and must take its anchor from a settled
  /// layout.
  func callOnNearTopLater() {
    guard onNearTop != nil else { return }
    Task { @MainActor [weak self] in
      self?.onNearTop?()
    }
  }

  func take() -> Command? {
    defer { command = nil }
    return command
  }
}
