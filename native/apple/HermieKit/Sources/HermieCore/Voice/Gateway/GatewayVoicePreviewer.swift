import Foundation
import Observation

/**
 Hearing a gateway voice before choosing it: one play button per voice, one sample at a time.

 The screen owns one of these for as long as it is shown. A tap fetches the sample (its recording, or
 a sentence spoken in the voice: `GatewaySpeechAccess.previewClip`), plays it, and a second tap on the
 same voice, another voice, or leaving the screen (`stop`) stops it. A fetched clip is kept for the
 screen's lifetime, so hearing a voice twice asks the gateway once. A failure is held for the voice it
 happened to, for the row to say. Nothing here changes which voice is chosen, and nothing plays while a
 call has the audio.
 */
@MainActor
@Observable
public final class GatewayVoicePreviewer {
  /// What one voice's button shows.
  public enum Phase: Sendable, Equatable {
    case idle
    /// The sample is being fetched or read.
    case loading
    case playing
  }

  /// Why a voice could not be heard.
  public enum Failure: Sendable, Equatable {
    /// The gateway has no sample of it.
    case noSample
    /// The gateway could not be reached, or refused.
    case unreachable
    /// The audio could not be played.
    case unplayable
    /// A voice call is on.
    case callActive
  }

  public let access: GatewaySpeechAccess

  /// The voice being fetched or played; nil when nothing is.
  public private(set) var activeVoice: String?
  public private(set) var phase: Phase = .idle
  public private(set) var failedVoice: String?
  public private(set) var failure: Failure?

  @ObservationIgnored private let player: any GatewayClipPlaying
  @ObservationIgnored private let sentence: String
  @ObservationIgnored private let callActive: @MainActor () -> Bool
  @ObservationIgnored private var cache: [String: GatewayAudioClip] = [:]
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var task: Task<Void, Never>?

  /// - Parameters:
  ///   - sentence: what a provider that speaks for nothing says in the voice, in the app's language.
  ///   - callActive: a voice call has the audio; by default the call's own flag says so.
  public init(
    access: GatewaySpeechAccess, player: any GatewayClipPlaying, sentence: String,
    callActive: (@MainActor () -> Bool)? = nil
  ) {
    self.access = access
    self.player = player
    self.sentence = sentence
    self.callActive = callActive ?? { SpeechAudioSession.heldByCall }
  }

  /// The app's own player, on its own audio engine.
  public convenience init(access: GatewaySpeechAccess, sentence: String) {
    self.init(access: access, player: GatewayClipPlayer(), sentence: sentence)
  }

  /// A button is offered for `voice`.
  public func offers(_ voice: GatewayVoice) -> Bool {
    access.canPreview(voice)
  }

  /// What `voiceID`'s button shows.
  public func phase(of voiceID: String) -> Phase {
    activeVoice == voiceID ? phase : .idle
  }

  /// Why `voiceID` could not be heard, when that is what last happened to it.
  public func failure(of voiceID: String) -> Failure? {
    failedVoice == voiceID ? failure : nil
  }

  /// The voice's button was tapped: play its sample, or stop it where it is being fetched or played.
  public func toggle(_ voice: GatewayVoice) {
    guard access.canPreview(voice) else {
      return
    }

    if activeVoice == voice.id {
      stop()
      return
    }

    halt()
    failedVoice = nil
    failure = nil

    guard !callActive() else {
      fail(voice.id, .callActive)
      return
    }

    generation += 1
    let current = generation
    activeVoice = voice.id
    phase = .loading

    task = Task { [weak self] in
      await self?.run(voice, current)
    }
  }

  /// Silence, now: the screen was left, or the same voice was tapped again.
  public func stop() {
    halt()
    failedVoice = nil
    failure = nil
  }

  // MARK: Inside

  private func halt() {
    generation += 1
    task?.cancel()
    task = nil
    player.stop()
    activeVoice = nil
    phase = .idle
  }

  private func run(_ voice: GatewayVoice, _ current: Int) async {
    let clip: GatewayAudioClip

    if let kept = cache[voice.id] {
      clip = kept
    } else {
      do {
        clip = try await access.previewClip(for: voice, sentence: sentence)
      } catch {
        if current == generation {
          fail(voice.id, Self.failure(of: error))
        }

        return
      }

      guard current == generation else {
        return
      }

      cache[voice.id] = clip
    }

    // A call may have begun while the sample came in.
    guard !callActive() else {
      fail(voice.id, .callActive)
      return
    }

    do {
      try await player.play(clip) { [weak self] in
        self?.finished(current)
      }
    } catch {
      if current == generation {
        fail(voice.id, Self.failure(of: error))
      }

      return
    }

    if current == generation, phase == .loading {
      phase = .playing
    }
  }

  private func finished(_ current: Int) {
    guard current == generation else {
      return
    }

    activeVoice = nil
    phase = .idle
  }

  private func fail(_ voiceID: String, _ reason: Failure) {
    halt()
    failedVoice = voiceID
    failure = reason
  }

  private static func failure(of error: any Error) -> Failure {
    switch error {
    case GatewayPreviewError.noSample: .noSample
    case GatewayClipError.unreadable, GatewayClipError.noOutput: .unplayable
    default: .unreachable
    }
  }
}
