import AVFoundation
import Foundation

/// Plays one short clip of the gateway's audio (a voice's sample), outside a call.
@MainActor
public protocol GatewayClipPlaying: AnyObject {
  /// Decode `clip` and start it. Returns once it is playing; `finished` is called when it has been heard
  /// to its end, and not for a clip `stop()` cut. Throws where the clip cannot be read or played.
  func play(_ clip: GatewayAudioClip, finished: @escaping @MainActor @Sendable () -> Void) async throws
  /// Silence, now.
  func stop()
}

/// What `GatewayClipPlayer` cannot do.
public enum GatewayClipError: Error, Equatable, Sendable {
  /// The audio is not something the system can read.
  case unreadable
  /// There is no audio output to play on.
  case noOutput
}

/**
 `GatewayClipPlaying` on an engine of its own, the one reading a reply aloud uses
 (`EngineOutput`): started for the clip and stopped when it is over. The decoding is the one a spoken
 sentence's file goes through (`GatewayAudioDecoding`), so a sample is read exactly as a reply is.
 */
@MainActor
public final class GatewayClipPlayer: GatewayClipPlaying {
  private let makeOutput: () -> any RenderedOutput
  private var made: (any RenderedOutput)?
  private var token = 0
  private var open = false

  /// The engine is built when a clip is first played, not with the screen that may never play one.
  public convenience init() {
    self.init(output: { EngineOutput() })
  }

  init(output: @escaping () -> any RenderedOutput) {
    makeOutput = output
  }

  private var output: any RenderedOutput {
    if let made {
      return made
    }

    let output = makeOutput()
    made = output
    return output
  }

  public func play(_ clip: GatewayAudioClip, finished: @escaping @MainActor @Sendable () -> Void) async throws {
    halt()
    let current = token

    // Decoding writes the clip to a file and reads it back: off the main actor.
    let chunks: [PCMChunk]

    do {
      chunks = try await Task.detached { try GatewayAudioDecoding.decode(clip).map(PCMChunk.init(buffer:)) }.value
    } catch {
      throw GatewayClipError.unreadable
    }

    // Stopped, or another clip asked for, while it was being read.
    guard current == token else {
      throw CancellationError()
    }

    guard output.open() else {
      throw GatewayClipError.noOutput
    }

    open = true
    let playing = output.playing
    playing.begin(current)

    for chunk in chunks {
      playing.play(chunk.buffer, token: current, finished: {})
    }

    playing.play(
      nil, token: current,
      finished: { [weak self] in
        Task { @MainActor in self?.ended(current, finished) }
      })
  }

  public func stop() {
    halt()
  }

  /// Ownership first: what the player still reports is about nothing wanted.
  private func halt() {
    token += 1
    made?.playing.begin(-1)

    if open {
      open = false
      made?.close()
    }
  }

  private func ended(_ finishedToken: Int, _ finished: @MainActor @Sendable () -> Void) {
    guard finishedToken == token else {
      return
    }

    if open {
      open = false
      made?.close()
    }

    finished()
  }
}
