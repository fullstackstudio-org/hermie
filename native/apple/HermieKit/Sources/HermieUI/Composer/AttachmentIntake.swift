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

/// How what the reader picks, drops or pastes becomes a staged file.
///
/// Every route does the same two things, in this order:
///
/// 1. At once, on the main actor: one chip per item, marked preparing (`AttachmentTray.prepare`),
///    so the send waits for it from the first moment ("send waits for all") and the reader sees
///    something arrived.
/// 2. Off the main actor: the item is read and copied into the app's staging folder
///    (`AttachmentStaging`), its size first, so a file over the cap becomes a failed chip with no
///    copy made. The result goes to the tray (`AttachmentTray.provide`), which starts it on its
///    road, or deletes the copy when the chip is gone by then (the chat was left, or the reader
///    removed it).
@MainActor
enum AttachmentIntake {
  typealias Staged = Result<PickedFile, StagingFailure>

  // MARK: Names and kinds

  /// The MIME type a file name implies, nil when the system does not know the extension.
  nonisolated static func mimeType(forFileNamed name: String) -> String? {
    let ext = (name as NSString).pathExtension

    return ext.isEmpty ? nil : UTType(filenameExtension: ext)?.preferredMIMEType
  }

  /// Which road a file of this name will take, before anything is known about it.
  nonisolated static func kind(ofFileNamed name: String) -> AttachmentKind {
    AttachmentRules.imageName(for: name, mimeType: mimeType(forFileNamed: name)) == nil ? .file : .image
  }

  /// "Image 2026-10-03 at 14.05.09": what a nameless picture is called.
  nonisolated static func defaultImageName(now: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
    formatter.locale = Locale(identifier: "en_US_POSIX")

    return "Image \(formatter.string(from: now))"
  }

  /// `name` with the extension of `type`, when it has none.
  nonisolated static func named(_ name: String?, as type: UTType?) -> String {
    let base = (name?.isEmpty ?? true) ? defaultImageName() : name!

    guard (base as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension else {
      return base
    }

    return "\(base).\(ext)"
  }

  private nonisolated static func staged(_ body: () throws(StagingFailure) -> PickedFile) -> Staged {
    do {
      return .success(try body())
    } catch {
      return .failure(error)
    }
  }

  /// Run `work` off the main actor and hand its answer to the chip.
  private static func stage(
    _ id: String, in tray: AttachmentTray, _ work: @escaping @Sendable () -> Staged
  ) {
    Task.detached(priority: .userInitiated) {
      let result = work()

      await MainActor.run { tray.provide(id, result) }
    }
  }

  // MARK: Files

  /// Files from the file importer, or pasted from the Finder, or dropped from it.
  static func addFiles(_ urls: [URL], to tray: AttachmentTray) {
    let ids = tray.prepare(urls.map { ($0.lastPathComponent, kind(ofFileNamed: $0.lastPathComponent)) })

    for (id, url) in zip(ids, urls) {
      stage(id, in: tray) {
        staged { () throws(StagingFailure) in
          try AttachmentStaging.stage(copying: url, mimeType: mimeType(forFileNamed: url.lastPathComponent))
        }
      }
    }
  }

  // MARK: Pictures with no file behind them

  /// A pasted screenshot, or a picture copied in a browser.
  static func addImage(_ data: Data, type: UTType, to tray: AttachmentTray) {
    let name = named(nil, as: type)
    let id = tray.prepare([(name, .image)])[0]

    stage(id, in: tray) {
      staged { () throws(StagingFailure) in
        try AttachmentStaging.stage(data: data, name: name, mimeType: type.preferredMIMEType)
      }
    }
  }

  static func addPasted(_ items: [PasteItem], to tray: AttachmentTray) {
    for item in items {
      switch item {
      case .file(let url): addFiles([url], to: tray)
      case .image(let data, let type): addImage(data, type: type, to: tray)
      }
    }
  }

  /// The camera's one photo, already a JPEG with no metadata of its own.
  static func addCameraPhoto(_ data: Data, to tray: AttachmentTray) {
    addImage(data, type: .jpeg, to: tray)
  }

  // MARK: The photo library

  static func addPhotos(_ items: [PhotosPickerItem], to tray: AttachmentTray) {
    let picks = items.map { item -> (name: String, kind: AttachmentKind) in
      item.supportedContentTypes.contains { $0.conforms(to: .movie) }
        ? (NativeStrings.Composer.Attach.video, .file) : (NativeStrings.Composer.Attach.photo, .image)
    }
    let ids = tray.prepare(picks)

    for (id, item) in zip(ids, items) {
      Task {
        let result: Staged

        do {
          if let photo = try await item.loadTransferable(type: PickedPhoto.self) {
            result = .success(photo.file)
          } else {
            result = .failure(.unreadable(message: "The library gave nothing."))
          }
        } catch let failure as StagingFailure {
          result = .failure(failure)
        } catch {
          result = .failure(.unreadable(message: (error as NSError).localizedDescription))
        }

        tray.provide(id, result)
      }
    }
  }

  // MARK: Drops

  /// Whether a dragged item is a file or a picture, as opposed to words or a link, which the
  /// composer does not take as an attachment.
  static func isAttachable(_ provider: NSItemProvider) -> Bool {
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      return true
    }

    return provider.registeredContentTypes.contains { $0.conforms(to: .image) || isFileContent($0) }
  }

  private static func isFileContent(_ type: UTType) -> Bool {
    type.conforms(to: .data) && !type.conforms(to: .text) && !type.conforms(to: .url)
  }

  /// Dropped on the composer. A file URL (the Mac's Finder, files in place) is copied as a picked
  /// file is; anything else (a file from the Files app on an iPad, a picture dragged out of a page)
  /// is asked for as a file by its own type, and copied inside the callback that is given it.
  static func addDropped(_ providers: [NSItemProvider], to tray: AttachmentTray) {
    let usable = providers.filter(isAttachable)
    let ids = tray.prepare(
      usable.map { provider in
        let name = provider.suggestedName ?? NativeStrings.Composer.Attach.item
        return (name, kind(ofFileNamed: name))
      })

    for (id, provider) in zip(ids, usable) {
      Task {
        let result = await stage(dropped: provider)

        tray.provide(id, result)
      }
    }
  }

  private static func stage(dropped provider: NSItemProvider) async -> Staged {
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier), let url = await fileURL(of: provider) {
      return await Task.detached(priority: .userInitiated) {
        staged { () throws(StagingFailure) in
          try AttachmentStaging.stage(copying: url, mimeType: mimeType(forFileNamed: url.lastPathComponent))
        }
      }.value
    }

    let types = provider.registeredContentTypes
    guard let type = types.first(where: { $0.conforms(to: .image) }) ?? types.first(where: isFileContent) else {
      return .failure(.unreadable(message: "Nothing in the drop can be read as a file."))
    }

    return await file(of: provider, as: type)
  }

  private static func fileURL(of provider: NSItemProvider) async -> URL? {
    await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: URL.self) { url, _ in
        continuation.resume(returning: url)
      }
    }
  }

  /// The provider's own copy of its item, which is only there inside the callback: copied in it.
  private static func file(of provider: NSItemProvider, as type: UTType) async -> Staged {
    let name = named(provider.suggestedName, as: type)

    return await withCheckedContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
        guard let url else {
          let message = (error.map { ($0 as NSError).localizedDescription }) ?? "The item could not be read."
          continuation.resume(returning: .failure(.unreadable(message: message)))
          return
        }

        continuation.resume(
          returning: staged { () throws(StagingFailure) in
            try AttachmentStaging.stage(copying: url, name: name, mimeType: type.preferredMIMEType)
          })
      }
    }
  }
}

/// A photo or a movie out of the Photos picker, staged: the picker is asked for what the library
/// holds (`.current`), so a movie is not transcoded; a photo is copied without its location, and a
/// HEIC one becomes a JPEG, which the gateway takes as an image (`AttachmentStaging`).
struct PickedPhoto: Transferable {
  let file: PickedFile

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      PickedPhoto(file: try stage(received))
    }
    FileRepresentation(importedContentType: .movie) { received in
      PickedPhoto(file: try stage(received))
    }
  }

  private static func stage(_ received: ReceivedTransferredFile) throws -> PickedFile {
    try AttachmentStaging.stage(libraryItem: received.file, name: received.file.lastPathComponent)
  }
}

#if os(iOS)
  /// The camera, as the system's own picker: one photo, as a JPEG, then closed. Shown in a sheet,
  /// never a full-screen cover, so the chat stays standing under it (see `ComposerView`).
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
        // Encoded again here, from the pixels: the JPEG has no metadata of the camera's, location included.
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

/// Dragging a file or a picture over the composer: the hint shows for those, and not for words.
struct AttachmentDropDelegate: DropDelegate {
  let tray: AttachmentTray
  @Binding var targeted: Bool

  func validateDrop(info: DropInfo) -> Bool {
    info.itemProviders(for: [.fileURL, .image, .item]).contains(where: AttachmentIntake.isAttachable)
  }

  func dropEntered(info: DropInfo) {
    targeted = true
  }

  func dropExited(info: DropInfo) {
    targeted = false
  }

  func performDrop(info: DropInfo) -> Bool {
    targeted = false
    AttachmentIntake.addDropped(info.itemProviders(for: [.fileURL, .image, .item]), to: tray)
    return true
  }
}
