import Foundation
import UniformTypeIdentifiers

extension AttachmentTray {
  /// Files on this Mac (the Finder's, a Service's), staged as the picker's are: one chip each at
  /// once, marked preparing, so the send waits for them; each is copied into the app's staging
  /// folder off the main actor (its size first, so a file over its cap is a failed chip and no
  /// copy), and then started on its road. A folder is a failed chip that says so.
  public func addFiles(copying urls: [URL]) {
    let ids = prepare(
      urls.map { url in
        (url.lastPathComponent, Self.kind(ofFileNamed: url.lastPathComponent))
      })

    for (id, url) in zip(ids, urls) {
      Task.detached(priority: .userInitiated) { [self] in
        let result: Result<PickedFile, StagingFailure>

        do throws(StagingFailure) {
          result = .success(
            try AttachmentStaging.stage(copying: url, mimeType: Self.mimeType(forFileNamed: url.lastPathComponent)))
        } catch {
          result = .failure(error)
        }

        await MainActor.run { provide(id, result) }
      }
    }
  }

  nonisolated private static func mimeType(forFileNamed name: String) -> String? {
    let ext = (name as NSString).pathExtension

    return ext.isEmpty ? nil : UTType(filenameExtension: ext)?.preferredMIMEType
  }

  nonisolated private static func kind(ofFileNamed name: String) -> AttachmentKind {
    AttachmentRules.imageName(for: name, mimeType: mimeType(forFileNamed: name)) == nil ? .file : .image
  }
}
