import Foundation
import HermieGateway
import HermieTranscript

extension TranscriptStore {
  /// The chat's session working directory (`info.cwd` of `session.resume`), where its files go.
  public func workingDirectory(_ key: String) -> String? {
    chats[key]?.state.info?.cwd
  }

  /// Put a file on the gateway, ready to be named in the next prompt.
  ///
  /// Where is decided here, because the answer depends on this session: the upload has to land
  /// under the session's own working directory, as an absolute path, or the `@file:` reference is
  /// refused as outside the allowed workspace. With no working directory (or `/`) it refuses
  /// rather than guess: a plausible wrong directory gives an upload that succeeds and a reference
  /// the agent will not read, the worst of the options.
  public func uploadAttachment(
    _ key: String,
    file: PickedFile,
    onProgress: (@Sendable (Double) -> Void)? = nil
  ) async throws -> OutgoingAttachment {
    guard file.size <= AttachmentRules.maxFileBytes else {
      throw GatewayError(.protocol, "The file is over the upload limit.", status: 413)
    }

    guard let path = AttachmentRules.uploadPath(cwd: workingDirectory(key), name: file.name) else {
      throw AttachmentUploadError.noWorkspace
    }

    let stored = try await link.uploadFile(
      from: file.url,
      name: AttachmentRules.sanitisedName(file.name),
      mimeType: file.mimeType ?? AttachmentRules.fallbackType,
      to: path,
      onProgress: onProgress
    )

    return .file(filename: file.name, path: stored)
  }
}
