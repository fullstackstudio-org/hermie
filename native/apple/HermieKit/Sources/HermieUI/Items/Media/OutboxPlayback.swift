import AVFoundation
import CoreGraphics
import Foundation
import HermieCore
import HermieGateway
import HermieTranscript
import Observation

/// Lets one sound or video play at a time, and none while something else has the audio.
///
/// Whoever wants to start asks (`claim`): the one that was playing is paused, and a player that asks while
/// the arbiter is blocked (a voice call has the audio) is told no and does not start. A player that stops by
/// itself (paused, ended) says so (`release`). Closing the chat stops them all (`stopAll`).
@MainActor
final class PlaybackArbiter {
  /// Whether nothing may start now. Read at every `claim`.
  var isBlocked: () -> Bool
  /// Called when the last player stopped: the device's audio can be given back.
  var onIdle: (@MainActor () -> Void)?
  /// Called when a player is about to start while nothing else played: the device's audio is taken.
  var onBusy: (@MainActor () -> Void)?
  /// Called whenever a player is let start: what else uses the audio (reading a reply aloud) stops.
  var onStart: (@MainActor () -> Void)?

  private(set) var activeID: String?
  private var pauseActive: (@MainActor () -> Void)?

  init(isBlocked: @escaping () -> Bool = { false }) {
    self.isBlocked = isBlocked
  }

  /// `id` wants to play. `pause` is what stops it again. False when nothing may start now.
  func claim(_ id: String, pause: @escaping @MainActor () -> Void) -> Bool {
    guard !isBlocked() else { return false }
    onStart?()

    if let activeID, activeID != id {
      let previous = pauseActive
      self.activeID = nil
      pauseActive = nil
      previous?()
    } else if activeID == nil {
      onBusy?()
    }

    activeID = id
    pauseActive = pause
    return true
  }

  /// `id` stopped by itself. Nothing is done for a player that is not the one playing.
  func release(_ id: String) {
    guard activeID == id else { return }
    activeID = nil
    pauseActive = nil
    onIdle?()
  }

  /// Pause whoever plays.
  func stopAll() {
    guard let pause = pauseActive else { return }
    activeID = nil
    pauseActive = nil
    pause()
    onIdle?()
  }
}

/// The device's audio, for playing a sound the person asked for: on a phone the silent switch does not
/// mute it, and it is given back when the last one stops.
@MainActor
enum MediaAudioSession {
  static func begin() {
    #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, mode: .default)
      try? session.setActive(true)
    #endif
  }

  static func end() {
    #if os(iOS)
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    #endif
  }
}

/// One sound or video a bot shared, played from the gateway as it is read: the player seeks by byte ranges (the route
/// answers them), each of which `OutboxMediaLoader` fetches through the chat's session. The asset's address names a single
/// sound or video type, never a playlist, so the player itself makes no request: the credential is never handed to
/// AVFoundation, and never follows a redirect.
///
/// Every stop, pause and dismissal bumps `generation`: a `play()` still waiting for its player when one comes does not
/// start after it.
@MainActor
@Observable
final class MediaPlayback: Identifiable {
  enum Phase: Equatable {
    /// Nothing asked yet.
    case idle
    /// The player is being made, the file's length read.
    case preparing
    case ready
    /// `404`: the gateway no longer has it.
    case gone
    /// Over what this device takes.
    case tooLarge
    /// Anything else; another try can work.
    case failed
  }

  let attachment: OutboxAttachment
  private(set) var phase = Phase.idle
  private(set) var isPlaying = false
  /// Seconds.
  private(set) var position: Double = 0
  /// Seconds, once the player has read it.
  private(set) var duration: Double?
  /// The first frame of a video, once it is read.
  private(set) var poster: CGImage?
  private(set) var player: AVPlayer?

  nonisolated var id: String { attachment.id }

  @ObservationIgnored private let files: OutboxFiles
  @ObservationIgnored private let arbiter: PlaybackArbiter
  @ObservationIgnored private var timeObserver: Any?
  @ObservationIgnored private var endObserver: (any NSObjectProtocol)?
  @ObservationIgnored private var statusObserver: NSKeyValueObservation?
  @ObservationIgnored private var asset: AVURLAsset?
  /// Serves `asset`; the asset holds it weakly.
  @ObservationIgnored private var loader: OutboxMediaLoader?
  @ObservationIgnored private var preparing: Task<Void, Never>?
  @ObservationIgnored private var posterAttempted = false
  /// Bumped by every stop, pause and dismissal.
  @ObservationIgnored private var generation = 0
  /// The generation a `play()` that waits for its player started in.
  @ObservationIgnored private var startingIn: Int?

  init(attachment: OutboxAttachment, files: OutboxFiles, arbiter: PlaybackArbiter) {
    self.attachment = attachment
    self.files = files
    self.arbiter = arbiter
  }

  isolated deinit {
    teardown()
  }

  // MARK: Preparing

  /// Make the player and read how long the file is. Safe to call again: one preparation at a time, none once ready.
  func prepare() async {
    if let preparing {
      await preparing.value
      return
    }
    guard player == nil else { return }

    // An answer that is final, or one the reader has to ask to try again (`play`, `retry`), is not asked for again
    // just because a row came back into view.
    switch phase {
    case .gone, .tooLarge, .failed: return
    case .idle, .preparing, .ready: break
    }

    phase = .preparing
    let task = Task { await self.makePlayer() }
    preparing = task
    await task.value
    // A stop in the meantime let this one go, and another may have started since.
    if preparing == task { preparing = nil }
  }

  private func makePlayer() async {
    let loader: OutboxMediaLoader
    do {
      loader = try files.mediaLoader(for: attachment)
    } catch {
      phase = Self.phase(after: error)
      return
    }

    // Kept from the start, so a stop while the file is read closes what is on its way.
    let asset = loader.makeAsset()
    self.loader = loader
    self.asset = asset

    do {
      let (length, playable) = try await asset.load(.duration, .isPlayable)
      // Stopped while it was read: what was made is let go, and the phase is the stop's.
      guard !Task.isCancelled, self.loader === loader else { return }

      guard playable else {
        release(loader, asset)
        phase = .failed
        return
      }

      let item = AVPlayerItem(asset: asset)
      let player = AVPlayer(playerItem: item)
      self.player = player
      duration = length.isNumeric && length.seconds.isFinite && length.seconds > 0 ? length.seconds : nil
      observe(player, item)
      phase = .ready
    } catch {
      guard !Task.isCancelled, self.loader === loader else { return }
      release(loader, asset)
      phase = Self.phase(after: error, served: loader.failure)
    }
  }

  /// Let a loader and its asset go: nothing more is read for them.
  private func release(_ loader: OutboxMediaLoader, _ asset: AVURLAsset) {
    asset.cancelLoading()
    loader.close()
    if self.loader === loader {
      self.loader = nil
      self.asset = nil
    }
  }

  /// What a failed preparation or playback means: a `404` is final, a cap is final, anything else can be tried again.
  /// `served` is what the gateway itself answered, when the loader knows it.
  nonisolated static func phase(after error: any Error, served: FileDownloadError? = nil) -> Phase {
    switch served {
    case .notFound?: return .gone
    case .tooLarge?: return .tooLarge
    default: break
    }
    if (error as? FileDownloadError) == .tooLarge { return .tooLarge }
    return isNotFound(error) ? .gone : .failed
  }

  /// Whether `error`, or anything it wraps, says the gateway answered `404`: the system's own "file does not
  /// exist" for a URL, or the media framework's `HTTP 404` (`CoreMediaErrorDomain` -12938).
  nonisolated static func isNotFound(_ error: any Error) -> Bool {
    var pending: [NSError] = [error as NSError]

    while let next = pending.popLast() {
      if next.domain == NSURLErrorDomain && next.code == NSURLErrorFileDoesNotExist { return true }
      if next.domain == "CoreMediaErrorDomain" && next.code == -12938 { return true }
      if next.domain == AVFoundationErrorDomain && next.code == AVError.fileFormatNotRecognized.rawValue,
        next.localizedFailureReason?.contains("404") == true
      {
        return true
      }
      if let underlying = next.userInfo[NSUnderlyingErrorKey] as? NSError { pending.append(underlying) }
    }

    return false
  }

  private func observe(_ player: AVPlayer, _ item: AVPlayerItem) {
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
    ) { [weak self] time in
      MainActor.assumeIsolated { self?.tick(time) }
    }
    endObserver = NotificationCenter.default.addObserver(
      forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.ended() }
    }
    // The system's own controls (the full-screen player's, the Mac's media keys) start and stop the player without
    // asking: each change is put to the arbiter as a press of the row's own button would be.
    statusObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in self?.timeControlChanged() }
    }
  }

  /// The player started or stopped. One that starts without having asked (the system's controls) asks now, and is
  /// paused again when the arbiter says no; one that stops lets go.
  private func timeControlChanged() {
    guard let player else { return }

    // The status follows what was asked a moment later, and the change is handled later still, on the main actor. What
    // was asked is `rate`, which `play()` and `pause()` set at once: a player that was paused (the arbiter let another
    // start) can still read as playing here and must not take the audio back from the one that took it, and one that was
    // just started can still read as paused. The change that follows the status catching up is handled as its own.
    switch player.timeControlStatus {
    case .playing, .waitingToPlayAtSpecifiedRate:
      guard player.rate != 0 else { return }

      if arbiter.activeID == attachment.id {
        if !isPlaying { isPlaying = true }
        return
      }
      if arbiter.claim(attachment.id, pause: { [weak self] in self?.pauseWithoutRelease() }) {
        isPlaying = true
      } else {
        player.pause()
        isPlaying = false
      }
    case .paused:
      guard player.rate == 0 else { return }

      if isPlaying { isPlaying = false }
      arbiter.release(attachment.id)
    @unknown default:
      break
    }
  }

  private func tick(_ time: CMTime) {
    if time.isNumeric, time.seconds.isFinite { position = max(0, time.seconds) }

    if let player, let item = player.currentItem {
      if item.status == .failed, let error = item.error {
        failedWhilePlaying(error)
        return
      }
      if duration == nil, item.duration.isNumeric, item.duration.seconds.isFinite, item.duration.seconds > 0 {
        duration = item.duration.seconds
      }
      let playing = player.rate != 0 || player.timeControlStatus == .waitingToPlayAtSpecifiedRate
      if playing != isPlaying { isPlaying = playing }
    }
  }

  private func ended() {
    isPlaying = false
    position = 0
    player?.seek(to: .zero)
    arbiter.release(attachment.id)
  }

  private func failedWhilePlaying(_ error: any Error) {
    pause()
    teardown()
    phase = Self.phase(after: error)
  }

  // MARK: Playing

  /// Start (or go on). A voice call, a failure to prepare, or a stop, pause or dismissal while the player was being
  /// made (the chat was left, the full-screen video closed) keeps it from starting.
  func play() async {
    // Pressing play after a failure is asking again.
    if phase == .failed { phase = .idle }
    let ticket = generation
    startingIn = ticket
    defer { if startingIn == ticket { startingIn = nil } }

    await prepare()
    guard ticket == generation, !Task.isCancelled, phase == .ready, let player else { return }

    if let duration, position >= duration - 0.05 {
      await player.seek(to: .zero)
      guard ticket == generation, !Task.isCancelled, self.player === player else { return }
      position = 0
    }

    let claimed = arbiter.claim(attachment.id) { [weak self] in self?.pauseWithoutRelease() }
    guard claimed else { return }

    player.play()
    isPlaying = true
  }

  func pause() {
    pauseWithoutRelease()
    arbiter.release(attachment.id)
  }

  /// The arbiter's own way to stop it: it has already let go of it. A `play()` still waiting does not start after it.
  private func pauseWithoutRelease() {
    generation += 1
    player?.pause()
    isPlaying = false
  }

  /// Play or pause, as the button of a row does: a second press while the player is still being made is a pause.
  func toggle() {
    if isPlaying || startingIn == generation {
      pause()
    } else {
      Task { await play() }
    }
  }

  func seek(to seconds: Double) {
    guard let player, seconds.isFinite else { return }
    let target = max(0, min(seconds, duration ?? seconds))
    position = target
    player.seek(to: CMTime(seconds: target, preferredTimescale: 600))
  }

  /// Ask again after a failure.
  func retry() {
    guard phase == .failed || phase == .idle else { return }
    teardown()
    phase = .idle
    Task { await prepare() }
  }

  /// Pause and let the player go (the chat closed): playing again makes a new one. A player still being made is let go
  /// too, and nothing it was waiting for starts.
  func stop() {
    pause()
    preparing?.cancel()
    preparing = nil
    teardown()
    phase = .idle
  }

  private func teardown() {
    statusObserver?.invalidate()
    statusObserver = nil
    if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
    timeObserver = nil
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    endObserver = nil
    player?.pause()
    player = nil
    asset?.cancelLoading()
    asset = nil
    loader?.close()
    loader = nil
    isPlaying = false
    position = 0
  }

  // MARK: The poster of a video

  /// The first frame, for the card of a video. Read once; a video that gives none is a card without a picture. The
  /// generator reads the same asset, so the frame comes through the same loader as the player's bytes.
  func loadPoster() async {
    guard poster == nil, !posterAttempted else { return }
    await prepare()
    guard phase == .ready, let asset else { return }
    posterAttempted = true

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 960, height: 960)
    poster = try? await generator.image(at: .zero).image
  }
}

/// What one chat's sounds and videos are: the players, one at a time, and the video that is up full screen.
@MainActor
@Observable
final class MediaPlaybackCenter {
  let arbiter: PlaybackArbiter
  /// The video that is up full screen, while one is.
  private(set) var video: MediaPlayback?

  @ObservationIgnored private let files: OutboxFiles
  @ObservationIgnored private var playbacks: [String: MediaPlayback] = [:]

  init(files: OutboxFiles, arbiter: PlaybackArbiter = PlaybackArbiter()) {
    self.files = files
    self.arbiter = arbiter
    arbiter.onBusy = { MediaAudioSession.begin() }
    arbiter.onIdle = { MediaAudioSession.end() }
  }

  /// The player of `attachment`: the one already made for its token, or a new one.
  func playback(for attachment: OutboxAttachment) -> MediaPlayback {
    if let known = playbacks[attachment.id] { return known }
    let made = MediaPlayback(attachment: attachment, files: files, arbiter: arbiter)
    playbacks[attachment.id] = made
    return made
  }

  /// Bring a video up full screen; it plays from there.
  func present(video playback: MediaPlayback) {
    video = playback
  }

  /// The full-screen video was closed: it stops, and one still being made does not start after.
  func dismissVideo() {
    video?.pause()
    video = nil
  }

  /// Stop everything (the chat is closing, or a call starts) and let the players go.
  func stopAll() {
    arbiter.stopAll()
    video = nil
    for playback in playbacks.values { playback.stop() }
  }
}
