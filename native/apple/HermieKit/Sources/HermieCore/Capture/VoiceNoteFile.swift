import AVFoundation
import Foundation

/// The file a voice note is uploaded as: a fresh MP4 container written from the audio of the recording and nothing
/// else (`contract/requests/README.md` §5.1).
///
/// A container can carry more than sound: an MP4 audio file may hold a location atom (`loci`, `©xyz`) or a
/// location in its metadata, and creation times. What the app records itself carries no location, but the file is
/// written again all the same: the compressed audio is copied as it is (no second encoding, no loss) into a new
/// container that is given no metadata, so whatever the recorder or a system update put around the sound does not
/// leave the device. A recording the person PICKS is not touched (it is sent as it is, and the sheet says it may
/// carry such details).
public enum VoiceNoteFile {
  /// The type a voice note is sent as: no parameters (`audio/mp4`, not `audio/mp4;codecs=mp4a.40.2`).
  public static let mimeType = "audio/mp4"
  /// The extension of the file.
  public static let fileExtension = "m4a"

  public enum Failure: Error, Sendable, Equatable {
    /// There is no audio in the file.
    case noAudio
    /// The file could not be read or written.
    case failed
  }

  /// Write the audio of `source` into a new container at `destination`, which must not exist. The samples are
  /// copied as they are; the new file has no metadata of its own beyond what the container needs to play. Throws
  /// `Failure`, and leaves no file behind when it does. (Untyped, not `throws(Failure)`: a typed error across this
  /// function's suspension points crashes the runtime's stack allocator in Swift 6.)
  public static func freshCopy(of source: URL, to destination: URL) async throws {
    do {
      try await copy(source, to: destination)
    } catch let failure as Failure {
      try? FileManager.default.removeItem(at: destination)
      throw failure
    } catch {
      try? FileManager.default.removeItem(at: destination)
      throw Failure.failed
    }
  }

  private static func copy(_ source: URL, to destination: URL) async throws {
    let asset = AVURLAsset(url: source)

    guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
      throw Failure.noAudio
    }

    let formats = try await track.load(.formatDescriptions)
    let job = Job(asset: asset, track: track, format: formats.first)

    // The reading and writing run on a queue of their own, in plain synchronous code: AVAssetReader walks the
    // calling thread's stack when it reports an error, and it must not find a Swift async frame there.
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      queue.async {
        do {
          try job.run(to: destination)
          continuation.resume()
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private static let queue = DispatchQueue(label: "dev.hermie.voice-note-file", qos: .userInitiated)

  /// The AVFoundation objects of one copy, handed to the queue that uses them and to no other.
  private final class Job: @unchecked Sendable {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let format: CMFormatDescription?

    init(asset: AVURLAsset, track: AVAssetTrack, format: CMFormatDescription?) {
      self.asset = asset
      self.track = track
      self.format = format
    }

    func run(to destination: URL) throws {
      let reader = try AVAssetReader(asset: asset)
      // No output settings: the compressed samples come out as they are.
      let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)

      guard reader.canAdd(output) else {
        throw Failure.failed
      }

      reader.add(output)

      let writer = try AVAssetWriter(outputURL: destination, fileType: .m4a)
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: format)

      guard writer.canAdd(input) else {
        throw Failure.failed
      }

      writer.add(input)
      // Nothing of the source's: not its location, its title or its tool.
      writer.metadata = []

      guard reader.startReading() else {
        throw reader.error ?? Failure.failed
      }

      guard writer.startWriting() else {
        reader.cancelReading()
        throw writer.error ?? Failure.failed
      }

      writer.startSession(atSourceTime: .zero)

      while reader.status == .reading {
        guard input.isReadyForMoreMediaData else {
          usleep(2_000)
          continue
        }

        guard let sample = output.copyNextSampleBuffer() else {
          break
        }

        if !input.append(sample) {
          break
        }
      }

      input.markAsFinished()

      if reader.status == .failed {
        writer.cancelWriting()
        throw reader.error ?? Failure.failed
      }

      // Finishing is asynchronous; this queue waits for it.
      let finished = DispatchSemaphore(value: 0)
      writer.finishWriting { finished.signal() }
      finished.wait()

      guard writer.status == .completed else {
        throw writer.error ?? Failure.failed
      }
    }
  }

  /// How long the audio in `url` runs, in seconds; nil when it cannot be read.
  public static func duration(of url: URL) async -> Double? {
    guard let time = try? await AVURLAsset(url: url).load(.duration), time.isNumeric else {
      return nil
    }

    return max(0, time.seconds)
  }

  /// Bytes that mark a location in an MP4 audio file: the 3GPP location box, the QuickTime copyright-location atom,
  /// the metadata key of a location and the `uiso` key space. A test looks for them; the writer above leaves them
  /// out.
  public static let locationMarkers: [Data] = [
    Data("loci".utf8), Data([0xA9, 0x78, 0x79, 0x7A]), Data("location.ISO6709".utf8), Data("ISO6709".utf8)
  ]
}
