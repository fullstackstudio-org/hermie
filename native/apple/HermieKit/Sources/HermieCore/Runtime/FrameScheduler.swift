import Foundation
import HermieGateway

/// When the transcript store may publish.
///
/// The store marks chats dirty as it applies events and asks for a frame; the
/// scheduler calls back once, and everything that changed since the last frame
/// goes to the main actor in one hop. However many deltas land between two
/// frames, a view sees one snapshot. Tests drive it by hand
/// (`ManualFrameScheduler` in the tests), production with a fixed interval.
public protocol FrameScheduler: Sendable {
  /// Call `fire` once, at the next frame. Asking again before it fires is the
  /// caller's business: the store asks at most once per pending frame.
  func requestFrame(_ fire: @escaping @Sendable () async -> Void)
}

/// A frame every `interval` (60 Hz by default) on a `ConnectionClock`, so the
/// same injected clock that drives the store's timers can drive its frames.
///
/// Not tied to the display: HermieCore draws nothing and imports no UI
/// framework. A view that wants vsync alignment reads the latest snapshot on
/// its own frame; this only bounds how often the main actor is woken.
public struct ClockFrameScheduler: FrameScheduler {
  public let clock: any ConnectionClock
  public let interval: Duration

  public init(clock: any ConnectionClock = SystemConnectionClock(), interval: Duration = .microseconds(16_667)) {
    self.clock = clock
    self.interval = interval
  }

  public func requestFrame(_ fire: @escaping @Sendable () async -> Void) {
    _ = clock.schedule(after: interval, fire)
  }
}
