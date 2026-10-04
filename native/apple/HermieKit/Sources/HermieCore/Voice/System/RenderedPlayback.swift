import AVFoundation
import Foundation

/// The player's side of a reply: the renderer's buffers, converted to the player's format and
/// scheduled, and the end marked by a short silence whose playback is the completion. A token says
/// which reply is wanted; anything else is dropped.
final class RenderedPlayback: @unchecked Sendable {
  private let player: AVAudioPlayerNode
  private let format: AVAudioFormat
  private let lock = NSLock()
  private var token = -1
  private var converter: AVAudioConverter?

  init(player: AVAudioPlayerNode, format: AVAudioFormat) {
    self.player = player
    self.format = format
  }

  func begin(_ token: Int) {
    lock.withLock {
      self.token = token
      converter?.reset()
    }
  }

  func play(_ buffer: AVAudioPCMBuffer?, token: Int, finished: @escaping @Sendable () -> Void) {
    lock.withLock {
      guard token == self.token else {
        return
      }

      guard let buffer else {
        // The end: a moment of silence, and when it has been heard, the reply has.
        if let tail = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 512) {
          tail.frameLength = 512
          player.scheduleBuffer(tail, completionCallbackType: .dataPlayedBack) { _ in finished() }
        } else {
          finished()
        }
        return
      }

      if let converted = convert(buffer) {
        player.scheduleBuffer(converted, completionHandler: nil)
      }
    }
  }

  private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if buffer.format == format {
      return buffer
    }

    if converter == nil || converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: format)
    }

    guard let converter else {
      return nil
    }

    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)

    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      return nil
    }

    let source = SourceOnce(buffer)
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      source.next(status)
    }

    return error == nil && output.frameLength > 0 ? output : nil
  }

  /// Hands a converter one buffer, then says there is nothing more for now.
  private final class SourceOnce: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?

    init(_ buffer: AVAudioPCMBuffer) {
      self.buffer = buffer
    }

    func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
      guard let buffer else {
        status.pointee = .noDataNow
        return nil
      }

      self.buffer = nil
      status.pointee = .haveData
      return buffer
    }
  }
}
