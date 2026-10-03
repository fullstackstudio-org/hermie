import HermieCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
  import AVFoundation
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// How what the reader picks, drops or pastes becomes a staged file: each is copied out of its
/// security scope into the app's own staging folder (`AttachmentStaging`) before the tray sees it,
/// off the main actor, because a picked movie can be 100 MiB.
enum AttachmentIntake {
  /// What a batch came to: the files that are staged, and the first reason one was not.
  struct Outcome: Sendable {
    var files: [PickedFile] = []
    var failure: String?
  }

  /// The MIME type a file name implies, nil when the system does not know the extension.
  static func mimeType(forFileNamed name: String) -> String? {
    let ext = (name as NSString).pathExtension

    return ext.isEmpty ? nil : UTType(filenameExtension: ext)?.preferredMIMEType
  }

  /// Files the reader picked in the file importer, or dropped, or pasted from the Finder.
  static func stage(urls: [URL]) async -> Outcome {
    await Task.detached(priority: .userInitiated) {
      var outcome = Outcome()

      for url in urls {
        do {
          outcome.files.append(
            try AttachmentStaging.stage(copying: url, mimeType: mimeType(forFileNamed: url.lastPathComponent)))
        } catch {
          outcome.failure = outcome.failure ?? (error as NSError).localizedDescription
        }
      }

      return outcome
    }.value
  }

  /// Bytes with no file behind them: a pasted screenshot, a dropped picture.
  static func stage(image data: Data, type: UTType, suggestedName: String? = nil) async -> Outcome {
    await Task.detached(priority: .userInitiated) {
      let ext = type.preferredFilenameExtension ?? "png"
      let base = suggestedName.flatMap { $0.isEmpty ? nil : $0 } ?? Self.defaultImageName()
      let name = base.lowercased().hasSuffix(".\(ext)") ? base : "\(base).\(ext)"

      do {
        return Outcome(files: [try AttachmentStaging.stage(data: data, name: name, mimeType: type.preferredMIMEType)])
      } catch {
        return Outcome(failure: (error as NSError).localizedDescription)
      }
    }.value
  }

  /// "Image 2026-10-03 at 14.05.09": what a nameless picture is called.
  static func defaultImageName(now: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
    formatter.locale = Locale(identifier: "en_US_POSIX")

    return "Image \(formatter.string(from: now))"
  }

  static func stage(paste items: [PasteItem]) async -> Outcome {
    var merged = Outcome()

    for item in items {
      let outcome: Outcome

      switch item {
      case .file(let url): outcome = await stage(urls: [url])
      case .image(let data, let type): outcome = await stage(image: data, type: type)
      }

      merged.files += outcome.files
      merged.failure = merged.failure ?? outcome.failure
    }

    return merged
  }

  /// What the Photos picker handed over.
  static func stage(photos items: [PhotosPickerItem]) async -> Outcome {
    var outcome = Outcome()

    for item in items {
      do {
        if let photo = try await item.loadTransferable(type: PickedPhoto.self) {
          outcome.files.append(photo.file)
        }
      } catch {
        outcome.failure = outcome.failure ?? (error as NSError).localizedDescription
      }
    }

    return outcome
  }

  /// Dropped on the composer: files from the Finder or Files, and pictures dragged out of a page.
  @MainActor static func stage(dropped providers: [NSItemProvider]) async -> Outcome {
    var merged = Outcome()

    for provider in providers {
      let outcome: Outcome

      if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier), let url = await fileURL(of: provider) {
        outcome = await stage(urls: [url])
      } else if let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .image) }),
        let data = await data(of: provider, type: type)
      {
        outcome = await stage(image: data, type: type, suggestedName: provider.suggestedName)
      } else {
        continue
      }

      merged.files += outcome.files
      merged.failure = merged.failure ?? outcome.failure
    }

    return merged
  }

  @MainActor private static func fileURL(of provider: NSItemProvider) async -> URL? {
    await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: URL.self) { url, _ in
        continuation.resume(returning: url)
      }
    }
  }

  @MainActor private static func data(of provider: NSItemProvider, type: UTType) async -> Data? {
    await withCheckedContinuation { continuation in
      provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
        continuation.resume(returning: data)
      }
    }
  }
}

/// A photo or a movie out of the Photos picker, copied into the staging folder. The picker is asked
/// for the compatible encoding, so a HEIC photograph arrives as a JPEG: the gateway reads that as
/// an image, and has no extension for HEIC.
struct PickedPhoto: Transferable {
  let file: PickedFile

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      PickedPhoto(file: try copy(received))
    }
    FileRepresentation(importedContentType: .movie) { received in
      PickedPhoto(file: try copy(received))
    }
  }

  private static func copy(_ received: ReceivedTransferredFile) throws -> PickedFile {
    let name = received.file.lastPathComponent

    return try AttachmentStaging.stage(
      copying: received.file, name: name, mimeType: AttachmentIntake.mimeType(forFileNamed: name))
  }
}

#if os(iOS)
  /// The camera, as the system's own picker: one photo, as a JPEG, then closed.
  struct CameraPicker: UIViewControllerRepresentable {
    let onPhoto: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    /// Whether this device has a camera the reader has not switched off for the app.
    static var isAvailable: Bool {
      guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
        return false
      }

      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .denied, .restricted: return false
      default: return true
      }
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
      let picker = UIImagePickerController()
      picker.sourceType = .camera
      picker.mediaTypes = [UTType.image.identifier]
      picker.delegate = context.coordinator
      return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
      Coordinator(self)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
      let parent: CameraPicker

      init(_ parent: CameraPicker) {
        self.parent = parent
      }

      func imagePickerController(
        _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
      ) {
        if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
          parent.onPhoto(data)
        }

        parent.dismiss()
      }

      func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        parent.dismiss()
      }
    }
  }
#endif
