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

  private(set) var activeID: String?
  private var pauseActive: (@MainActor () -> Void)?

  init(isBlocked: @escaping () -> Bool = { false }) {
    self.isBlocked = isBlocked
  }

  /// `id` wants to play. `pause` is what stops it again. False when nothing may start now.
  func claim(_ id: String, pause: @escaping @MainActor () -> Void) -> Bool {
    guard !isBlocked() else { return false }

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

/// One sound or video a bot shared, played from the gateway as it is read: the player seeks by byte ranges
/// (the route answers them), and the credential goes in the request's headers (`AVURLAssetHTTPHeaderFieldsKey`),
/// never in the address.
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
  @ObservationIgnored private var asset: AVURLAsset?
  @ObservationIgnored private var preparing: Task<Void, Never>?
  @ObservationIgnored private var posterAttempted = false

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
    preparing = nil
  }

  private func makePlayer() async {
    do {
      let request = try await files.mediaRequest(for: attachment)
      var options: [String: Any] = [:]

      // The credential rides in the headers of the player's own requests, and only for a gateway address. The key is
      // `AVURLAssetHTTPHeaderFieldsKey`: AVFoundation honours it on every request the asset makes (the length, each
      // byte range), but the SDK does not export the constant to Swift, so it is spelled out.
      if !request.url.isFileURL {
        options["AVURLAssetHTTPHeaderFieldsKey"] = request.headers
      }

      let asset = AVURLAsset(url: request.url, options: options)
      let (length, playable) = try await asset.load(.duration, .isPlayable)

      guard playable else {
        phase = .failed
        return
      }

      let item = AVPlayerItem(asset: asset)
      let player = AVPlayer(playerItem: item)
      self.asset = asset
      self.player = player
      duration = length.isNumeric && length.seconds.isFinite && length.seconds > 0 ? length.seconds : nil
      observe(player, item)
      phase = .ready
    } catch {
      phase = Self.phase(after: error)
    }
  }

  /// What a failed preparation or playback means: a `404` is final, a cap is final, anything else can be tried again.
  nonisolated static func phase(after error: any Error) -> Phase {
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

  /// Start (or go on). A voice call, or a failure to prepare, keeps it from starting.
  func play() async {
    // Pressing play after a failure is asking again.
    if phase == .failed { phase = .idle }
    await prepare()
    guard phase == .ready, let player else { return }

    let claimed = arbiter.claim(attachment.id) { [weak self] in self?.pauseWithoutRelease() }
    guard claimed else { return }

    if let duration, position >= duration - 0.05 {
      await player.seek(to: .zero)
      position = 0
    }

    player.play()
    isPlaying = true
  }

  func pause() {
    pauseWithoutRelease()
    arbiter.release(attachment.id)
  }

  /// The arbiter's own way to stop it: it has already let go of it.
  private func pauseWithoutRelease() {
    player?.pause()
    isPlaying = false
  }

  /// Play or pause, as the button of a row does.
  func toggle() {
    if isPlaying {
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

  /// Pause and let the player go (the chat closed): playing again makes a new one.
  func stop() {
    pause()
    teardown()
    phase = .idle
  }

  private func teardown() {
    if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
    timeObserver = nil
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    endObserver = nil
    player?.pause()
    player = nil
    asset = nil
    isPlaying = false
    position = 0
  }

  // MARK: The poster of a video

  /// The first frame, for the card of a video. Read once; a video that gives none is a card without a picture.
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

  /// The full-screen video was closed: it stops.
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
