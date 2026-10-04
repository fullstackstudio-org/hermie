import AVFoundation
import Foundation

/// A PCM buffer handed from the task that made it to the one that plays it: filled once, then only read.
struct PCMChunk: @unchecked Sendable {
  let buffer: AVAudioPCMBuffer
}

/// Turning what the gateway sends into PCM buffers the player can take. Plain functions on plain values,
/// run on whatever task fetches the audio: never the main actor, never the audio thread.
enum GatewayAudioDecoding {
  enum DecodeError: Error, Equatable {
    /// Not audio the system can read (an Ogg file, say).
    case unreadable
    case empty
  }

  /// The streamed route's audio: raw signed 16-bit little-endian PCM, in frames of any size. A frame
  /// may end between the two bytes of a sample, so the odd byte waits for the next.
  struct PCM16Stream {
    let format: AVAudioFormat
    private let channels: Int
    private var carry: [UInt8] = []

    /// Nil for a rate or channel count no sane gateway sends.
    init?(sampleRate: Double, channels: Int) {
      guard (8_000...96_000).contains(sampleRate), (1...2).contains(channels),
        let format = AVAudioFormat(
          commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)
      else {
        return nil
      }

      self.format = format
      self.channels = channels
    }

    /// The whole samples of `data` (and of what was carried), as one buffer; nil when there are none yet.
    mutating func append(_ data: Data) -> AVAudioPCMBuffer? {
      var bytes = carry
      bytes.append(contentsOf: data)

      let frameBytes = 2 * channels
      let usable = bytes.count / frameBytes * frameBytes
      carry = Array(bytes[usable...])

      let frames = usable / frameBytes

      guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
        let out = buffer.floatChannelData?[0]
      else {
        return nil
      }

      bytes.withUnsafeBytes { raw in
        for frame in 0..<frames {
          var sum: Float = 0

          for channel in 0..<channels {
            let offset = (frame * channels + channel) * 2
            let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: offset, as: Int16.self))
            sum += Float(sample) / 32_768
          }

          out[frame] = sum / Float(channels)
        }
      }

      buffer.frameLength = AVAudioFrameCount(frames)
      return buffer
    }
  }

  /// The longest clip read in one go, in frames: a sentence is seconds, and a gateway that sends
  /// something enormous is not one to be believed.
  static let maxFrames: AVAudioFrameCount = 48_000 * 120

  /// A clip from `POST /api/audio/speak` (mp3, wav, m4a, …) as buffers of about a second each.
  static func decode(_ clip: GatewayAudioClip) throws -> [AVAudioPCMBuffer] {
    guard !clip.data.isEmpty else {
      throw DecodeError.empty
    }

    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("hermie-speech-\(UUID().uuidString)")
      .appendingPathExtension(fileExtension(for: clip.mimeType))

    try clip.data.write(to: url, options: .atomic)
    defer { try? FileManager.default.removeItem(at: url) }

    let file: AVAudioFile

    do {
      file = try AVAudioFile(forReading: url)
    } catch {
      throw DecodeError.unreadable
    }

    let total = AVAudioFrameCount(clamping: max(0, file.length))

    guard total > 0, total <= maxFrames else {
      throw DecodeError.empty
    }

    let chunk = AVAudioFrameCount(max(4_096, file.processingFormat.sampleRate))
    var buffers: [AVAudioPCMBuffer] = []

    while file.framePosition < file.length {
      let remaining = AVAudioFrameCount(file.length - file.framePosition)
      guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: min(chunk, remaining)) else {
        throw DecodeError.unreadable
      }

      try file.read(into: buffer)

      if buffer.frameLength == 0 {
        break
      }

      buffers.append(buffer)
    }

    guard !buffers.isEmpty else {
      throw DecodeError.empty
    }

    return buffers
  }

  /// The file extension the system's reader goes by.
  static func fileExtension(for mimeType: String) -> String {
    switch mimeType.split(separator: ";").first.map({ $0.lowercased() }) ?? "" {
    case "audio/wav", "audio/wave", "audio/x-wav": "wav"
    case "audio/mp4", "audio/m4a", "audio/x-m4a": "m4a"
    case "audio/aac": "aac"
    case "audio/flac": "flac"
    case "audio/ogg", "audio/opus": "ogg"
    default: "mp3"
    }
  }
}
