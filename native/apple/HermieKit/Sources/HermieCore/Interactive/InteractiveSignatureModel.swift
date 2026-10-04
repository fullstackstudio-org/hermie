import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// The signature of an `input.signature` request, from the first stroke to the two uploaded files.
///
/// The person reads the statement (verbatim, above the pad), draws, and presses Sign: only then is anything made or
/// sent. Pressing it writes the PNG and the SVG from the strokes (`SignatureFiles`), uploads both through the same
/// path an `input.file` answer takes (`InteractiveFileModel`: the request's bounds are checked before a byte
/// moves), and answers with the two references, the client's clock and the SHA-256 of the statement the request
/// showed (`InteractivePrompt.reply`). The statement is the request's, not the model's: the hash cannot be of
/// anything but what was on the sheet.
@MainActor
@Observable
public final class InteractiveSignatureModel {
  public enum Phase: Sendable, Equatable {
    /// The person is drawing, or can start.
    case drawing
    /// The files are being written from the strokes.
    case preparing
    /// The files are on their way.
    case uploading
    /// Both files are on the gateway; what is left is the answer.
    case uploaded
    /// Signing did not come to an answer: `failure` says why. Drawing on, or Sign again.
    case failed(Failure)
  }

  public enum Failure: Sendable, Equatable {
    /// The files could not be made.
    case files
    /// A file is over what the request allows.
    case tooLarge
    /// An upload failed.
    case upload(AttachmentProblem)
  }

  public let request: SignatureRequest
  public private(set) var ink = SignatureInk()
  public private(set) var phase = Phase.drawing
  /// 0 to 1 over both files.
  public var progress: Double { files.progress }
  /// When the person pressed Sign, in Unix seconds on this device's clock.
  public private(set) var signedAt: Int?

  @ObservationIgnored let files: InteractiveFileModel
  @ObservationIgnored private let clock: @Sendable () -> Date
  /// A signature the strokes of which are being drawn: bumped by every change, so files made for older strokes
  /// are never answered.
  @ObservationIgnored private var generation = 0

  public init(request: SignatureRequest, clock: @escaping @Sendable () -> Date = { Date() }) {
    self.request = request
    self.clock = clock

    // The two files go through the file model: its limits, its upload and its references are the ones of
    // `input.file`. The request's own `upload` is what bounds them.
    self.files = InteractiveFileModel(
      params: InputFileParams(json: ["accept": "image", "multiple": true, "upload": .object(request.upload.json)]))
  }

  // MARK: - Drawing

  /// The ink as drawn so far, from the pad. A change after the files were made throws them away.
  public func setInk(_ drawn: SignatureInk) {
    guard phase != .preparing, phase != .uploading, drawn != ink else {
      return
    }

    ink = drawn
    invalidate()
  }

  public func clear() {
    setInk(SignatureInk())
  }

  private func invalidate() {
    generation += 1
    files.discardAll()
    signedAt = nil
    phase = .drawing
  }

  /// There is a signature to sign with, and nothing is on its way.
  public var canSign: Bool {
    guard ink.isSignature else {
      return false
    }

    switch phase {
    case .drawing, .failed, .uploaded: return true
    case .preparing, .uploading: return false
    }
  }

  /// The pad is not to be drawn on while the files are made or sent.
  public var isBusy: Bool { phase == .preparing || phase == .uploading }

  // MARK: - Signing

  /// Write the files, upload them, and say how to answer, or nil when it did not come to that (the person
  /// cancelled, or `phase` says what failed). Files already on the gateway for these strokes are not sent twice.
  public func sign(through uploader: @escaping InteractiveUploader) async -> InteractiveAnswer? {
    guard canSign else {
      return nil
    }

    if phase == .uploaded, !files.uploaded.isEmpty, let signedAt {
      return .signature(files: files.uploaded, signedAt: signedAt)
    }

    let current = generation
    let strokes = ink

    // The time is the person's pressing Sign; a retry of the same strokes keeps it.
    let pressed = signedAt ?? Int(clock().timeIntervalSince1970)
    signedAt = pressed
    phase = .preparing
    files.discardAll()

    let made = await Task.detached(priority: .userInitiated) { () -> Result<(png: Data, svg: Data), SignatureFiles.Failure> in
      do throws(SignatureFiles.Failure) {
        return .success(try SignatureFiles.make(from: strokes))
      } catch {
        return .failure(error)
      }
    }.value

    guard current == generation else {
      return nil
    }

    guard case .success(let both) = made else {
      phase = .failed(.files)
      return nil
    }

    do {
      let png = try AttachmentStaging.stage(data: both.png, name: "signature.png", mimeType: "image/png")
      let svg = try AttachmentStaging.stage(data: both.svg, name: "signature.svg", mimeType: "image/svg+xml")

      // Each file is checked against the request's bounds as it is added; one that does not fit leaves neither.
      guard files.add(png), files.add(svg) else {
        files.discardAll()
        phase = .failed(.tooLarge)
        return nil
      }
    } catch {
      files.discardAll()
      phase = .failed(.files)
      return nil
    }

    phase = .uploading

    guard let uploaded = await files.upload(through: uploader), current == generation else {
      if current == generation {
        phase = files.failure.map { .failed(.upload($0)) } ?? .drawing
      }

      return nil
    }

    phase = .uploaded
    return .signature(files: uploaded, signedAt: pressed)
  }

  /// Stop an upload on its way. Nothing is answered.
  public func cancelUpload() {
    files.cancel()
  }

  /// The sheet goes: the staged files are deleted and nothing is kept.
  public func discard() {
    generation += 1
    files.discardAll()
  }
}
