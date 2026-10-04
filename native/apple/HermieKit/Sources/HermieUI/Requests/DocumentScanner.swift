#if os(iOS)
  import SwiftUI
  import UIKit
  import VisionKit

  /// The system's document scanner (`VNDocumentCameraViewController`): the camera finds the page,
  /// straightens it and takes as many as the person scans. The pages come back as JPEGs written
  /// from their pixels, so no metadata of the camera's goes with them. Only where the device has
  /// the scanner (`isSupported`); the Mac does not.
  struct DocumentScanner: UIViewControllerRepresentable {
    /// The scanned pages, in order, as JPEG data.
    let onPages: ([Data]) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isSupported: Bool {
      VNDocumentCameraViewController.isSupported
    }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
      let controller = VNDocumentCameraViewController()
      controller.delegate = context.coordinator
      return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
      Coordinator(self)
    }

    // VisionKit calls its delegate on the main thread, and the protocol is not main-actor
    // isolated in every SDK: `@preconcurrency` lets the main-actor methods witness it.
    @MainActor
    final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
      let parent: DocumentScanner

      init(_ parent: DocumentScanner) {
        self.parent = parent
      }

      func documentCameraViewController(
        _ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
      ) {
        let pages = (0..<scan.pageCount).compactMap { scan.imageOfPage(at: $0).jpegData(compressionQuality: 0.85) }

        if !pages.isEmpty {
          parent.onPages(pages)
        }

        parent.dismiss()
      }

      func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        parent.dismiss()
      }

      func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
        parent.dismiss()
      }
    }
  }
#endif
