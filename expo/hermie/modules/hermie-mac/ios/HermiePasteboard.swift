import Foundation
import UIKit
import UniformTypeIdentifiers

/**
 What `UIPasteboard.general` is holding, the moment ⌘V reports itself.

 `HermieMacModule` reports the CHORD off GameController's HID state — see its own comment — and
 reports it for every text field in the app, not only the composer. This is deliberately a second
 step rather than folded into that handler: the shortcut is cheap to detect and free of any real
 work, and asking the pasteboard for an image only makes sense for the ONE caller that has
 somewhere to put one. JavaScript decides that; this only answers what is there.

 ## Not an interception

 Nothing here touches the responder chain, and that is the point rather than a limitation. A
 plain-text ⌘V has already been handled by the focused `UITextView` through the ordinary paste path
 by the time JavaScript even hears the shortcut happened, because this runs on a REPORT of the key
 having gone down, not on the paste action itself. That includes a FILE, which this module used to
 assume a plain `UITextView` could not paste at all — it can: `UIPasteboard.hasStrings` treats a
 URL-conforming item as string-representable and synthesises its `absoluteString` on demand, so
 `canPerformAction(_:withSender:)` says yes and the ordinary paste inserts the file's path as text.
 Nothing on this seam can stop that; `src/chat-ui/paste-revert.ts` is where JavaScript undoes it once
 this function says a file was there after all.

 ## The copy, again

 Same reasoning as `HermieDropView`: an image is written out fresh because there is no file behind
 it at all, and a file URL from `UIPasteboard.general.urls` is copied into the app's own tmp
 directory rather than referenced in place, because the upload this feeds starts several turns
 later and a security-scoped URL from another app's pasteboard entry is not guaranteed to still
 resolve by then.
 */
enum HermiePasteboard {
  /**
   Every image or file attachment the general pasteboard is holding, in the same
   `{uri, name, size, mimeType}` shape `HermieDropView` hands JavaScript.

   ## Files first, and images only where there is no file

   A file URL and an image are read as ALTERNATIVES for one paste, never both, and that is not the
   same rule the owner's first report ran into: a Finder copy of an image FILE puts both `public.file-url`
   and a rendered image representation of that same file on the pasteboard, so `UIPasteboard.general`
   answers both `.urls` and `.images` for what is, to the person who copied it, ONE file — and reading
   both handed JavaScript two attachments with identical thumbnails for it. A pasted image with no
   file behind it at all — a screenshot, or an image copied out of a web page — has no entry in
   `.urls`, which is exactly what makes `.images` still the right fallback for it. `.urls` is asked
   FIRST and `.images` is skipped whenever it answered anything, rather than the other way round,
   because a file's own bytes belong in the upload `stageFile` already gives a drop, not in the
   resize pipeline a screenshot goes through.

   Several urls are still collected in one paste — a Finder copy of more than one file, all at once —
   for the same reason several images used to be: nothing here assumes there is only one. A
   pasteboard holding neither returns an empty array, which is the same thing to a caller as "nothing
   worth pasting" and not an error.
   */
  static func attachments() -> [[String: Any]] {
    let pasteboard = UIPasteboard.general
    var results: [[String: Any]] = []

    let fileURLs = (pasteboard.urls ?? []).filter { $0.isFileURL }

    for url in fileURLs {
      if let attachment = copyFile(url) {
        results.append(attachment)
      }
    }

    if fileURLs.isEmpty {
      for image in pasteboard.images ?? [] {
        if let attachment = writeImage(image) {
          results.append(attachment)
        }
      }
    }

    return results
  }

  /**
   Write one pasted image out as its own file.

   PNG rather than a compressed format: `attachments.ts` re-encodes as JPEG at 0.85 quality and a
   resized edge once it knows the pixel size, so compressing twice here would only cost quality for
   no smaller an upload. `image.scale` folds in because `UIImage.size` is in POINTS — a Retina
   screenshot's `size` alone would under-report its actual pixel count, and that pixel count is the
   one thing `resizeToBase64` needs to decide whether to resize at all.
   */
  private static func writeImage(_ image: UIImage) -> [String: Any]? {
    guard let data = image.pngData() else {
      return nil
    }

    guard let destination = temporaryDestination(named: "pasted-image-\(UUID().uuidString.prefix(8)).png") else {
      return nil
    }

    do {
      try data.write(to: destination)
    } catch {
      return nil
    }

    return [
      "uri": destination.absoluteString,
      "name": destination.lastPathComponent,
      "size": data.count,
      "mimeType": "image/png",
      "width": Double(image.size.width * image.scale),
      "height": Double(image.size.height * image.scale)
    ]
  }

  /** Copy one pasted file URL somewhere it will still exist when the upload gets to it. */
  private static func copyFile(_ source: URL) -> [String: Any]? {
    guard let destination = temporaryDestination(named: source.lastPathComponent) else {
      return nil
    }

    let scoped = source.startAccessingSecurityScopedResource()

    defer {
      if scoped {
        source.stopAccessingSecurityScopedResource()
      }
    }

    do {
      try FileManager.default.copyItem(at: source, to: destination)
    } catch {
      // A pasteboard entry this process cannot read is not an error worth throwing into a keyboard
      // shortcut: the reader gets no attachment for that one item rather than a crash.
      return nil
    }

    let size = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? Int) ?? nil
    let mimeType = UTType(filenameExtension: destination.pathExtension)?.preferredMIMEType

    return [
      "uri": destination.absoluteString,
      "name": destination.lastPathComponent,
      "size": size ?? 0,
      "mimeType": mimeType ?? "application/octet-stream"
    ]
  }

  /** `tmp/hermie-paste/<uuid>/<name>` — a directory per paste, as `HermieDropView` uses per drop. */
  private static func temporaryDestination(named name: String) -> URL? {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("hermie-paste", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)

    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    } catch {
      return nil
    }

    return directory.appendingPathComponent(name)
  }
}
