import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What a photograph from the library tells the gateway about where it was taken, and how it is
/// kept from doing so.
///
/// A photo in the library carries the place it was taken (EXIF GPS), and often the place's name
/// (IPTC and XMP city, region, country, sub-location). The agent reads the picture, never needs
/// that, and the gateway may be someone else's machine, so a library photo leaves with the location
/// removed:
///
/// - A format the gateway takes as an image (`AttachmentRules.imageExtensions`) is copied by ImageIO
///   (`CGImageDestinationCopyImageSource`) with the location metadata excluded or removed. That is a
///   copy of the image data, not a re-encode: the pixels are exactly the picture's, and a JPEG is not
///   compressed a second time.
/// - A format it does not (HEIC, RAW) has to be converted to a JPEG anyway; the conversion carries
///   the orientation and nothing else.
/// - A format ImageIO cannot copy falls back to the conversion rather than leaving unstripped.
/// - A video is not an image and is sent as it is: its metadata is not touched here.
///
/// The camera's photo is already a fresh JPEG with no metadata, and a file picked in Files, dragged
/// or pasted is sent as the reader chose it.
public enum AttachmentPrivacy {
  /// The XMP properties that name a place, set to nothing so a merge removes them. The GPS ones
  /// are `kCGImageMetadataShouldExcludeGPS`'s.
  static func locationTags() -> [(namespace: CFString, prefix: CFString, names: [String])] {
    [
      (kCGImageMetadataNamespacePhotoshop, kCGImageMetadataPrefixPhotoshop, ["City", "State", "Country"]),
      (kCGImageMetadataNamespaceIPTCCore, kCGImageMetadataPrefixIPTCCore, ["Location", "CountryCode"]),
      (
        kCGImageMetadataNamespaceIPTCExtension, kCGImageMetadataPrefixIPTCExtension,
        ["LocationCreated", "LocationShown"]
      )
    ]
  }

  /// The metadata to merge in: every tag that names a place, with the value removal needs.
  static func locationScrubber() -> CGMutableImageMetadata {
    let metadata = CGImageMetadataCreateMutable()

    for (namespace, prefix, names) in locationTags() {
      CGImageMetadataRegisterNamespaceForPrefix(metadata, namespace, prefix, nil)

      for name in names {
        CGImageMetadataSetValueWithPath(metadata, nil, "\(prefix):\(name)" as CFString, kCFNull)
      }
    }

    return metadata
  }

  public enum Failure: Error, Equatable {
    case unreadable
    case unsupported
  }

  /// Copy the image at `source` to `destination` without its location, and without re-encoding it.
  public static func copyWithoutLocation(from source: URL, to destination: URL) throws {
    guard let image = CGImageSourceCreateWithURL(source as CFURL, nil), let type = CGImageSourceGetType(image) else {
      throw Failure.unreadable
    }

    guard let output = CGImageDestinationCreateWithURL(destination as CFURL, type, CGImageSourceGetCount(image), nil)
    else {
      throw Failure.unsupported
    }

    let options: [CFString: Any] = [
      kCGImageMetadataShouldExcludeGPS: true,
      kCGImageDestinationMetadata: locationScrubber(),
      kCGImageDestinationMergeMetadata: true
    ]
    var error: Unmanaged<CFError>?

    guard CGImageDestinationCopyImageSource(output, image, options as CFDictionary, &error) else {
      try? FileManager.default.removeItem(at: destination)
      throw error?.takeRetainedValue() ?? Failure.unsupported
    }

    // Not every format takes the edit (a PNG kept its GPS and IPTC when this was written): what
    // was copied is read back, and a copy that still names a place is no copy.
    guard locationKeys(in: destination).isEmpty else {
      try? FileManager.default.removeItem(at: destination)
      throw Failure.unsupported
    }
  }

  /// Convert the image at `source` to a JPEG at `destination`, carrying its orientation and no other
  /// metadata.
  public static func convertToJPEG(from source: URL, to destination: URL, quality: Double = 0.9) throws {
    try reencode(from: source, to: destination, as: .jpeg, quality: quality)
  }

  /// Write the picture of `source` again as `type`, carrying its orientation and no other metadata.
  /// For a lossless type (PNG, TIFF, BMP) the pixels come out as they went in.
  public static func reencode(from source: URL, to destination: URL, as type: UTType, quality: Double = 0.9) throws {
    guard let image = CGImageSourceCreateWithURL(source as CFURL, nil),
      let picture = CGImageSourceCreateImageAtIndex(image, 0, nil)
    else {
      throw Failure.unreadable
    }

    guard let output = CGImageDestinationCreateWithURL(destination as CFURL, type.identifier as CFString, 1, nil)
    else {
      throw Failure.unsupported
    }

    var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    let source = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any]

    if let orientation = source?[kCGImagePropertyOrientation] {
      properties[kCGImagePropertyOrientation] = orientation
    }

    CGImageDestinationAddImage(output, picture, properties as CFDictionary)

    guard CGImageDestinationFinalize(output) else {
      try? FileManager.default.removeItem(at: destination)
      throw Failure.unsupported
    }
  }

  /// Whether the file at `url` still names a place: GPS, or any of the place tags. For the tests,
  /// and for anyone who wants to be sure.
  public static func locationKeys(in url: URL) -> [String] {
    guard let image = CGImageSourceCreateWithURL(url as CFURL, nil) else {
      return []
    }

    var found: [String] = []
    let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any] ?? [:]

    if properties[kCGImagePropertyGPSDictionary] != nil {
      found.append("GPS")
    }

    let iptc = properties[kCGImagePropertyIPTCDictionary] as? [CFString: Any] ?? [:]
    let iptcKeys: [(CFString, String)] = [
      (kCGImagePropertyIPTCCity, "IPTC City"), (kCGImagePropertyIPTCProvinceState, "IPTC ProvinceState"),
      (kCGImagePropertyIPTCCountryPrimaryLocationName, "IPTC Country"),
      (kCGImagePropertyIPTCSubLocation, "IPTC SubLocation"),
      (kCGImagePropertyIPTCContentLocationName, "IPTC ContentLocationName")
    ]

    for (key, name) in iptcKeys where iptc[key] != nil {
      found.append(name)
    }

    if let metadata = CGImageSourceCopyMetadataAtIndex(image, 0, nil),
      let tags = CGImageMetadataCopyTags(metadata) as? [CGImageMetadataTag]
    {
      for tag in tags {
        let name = (CGImageMetadataTagCopyName(tag) as String?) ?? ""
        let prefix = (CGImageMetadataTagCopyPrefix(tag) as String?) ?? ""

        if name.hasPrefix("GPS") || ["City", "State", "Country", "Location", "LocationCreated", "LocationShown"].contains(name),
          ["exif", "photoshop", "Iptc4xmpCore", "Iptc4xmpExt"].contains(prefix)
        {
          found.append("\(prefix):\(name)")
        }
      }
    }

    return found
  }
}

extension AttachmentStaging {
  /// A photograph or video from the photo library, which the system already copied to `received`
  /// for this call only, staged as `name` with its location removed (`AttachmentPrivacy`).
  ///
  /// The size is read first and a file over its cap is refused without being copied.
  public static func stage(libraryItem received: URL, name: String) throws(StagingFailure) -> PickedFile {
    let known = size(of: received)
    let type = UTType(filenameExtension: received.pathExtension)
    let isImage = type?.conforms(to: .image) ?? false
    let ext = received.pathExtension.lowercased()
    // A photo the gateway does not take as it is becomes a JPEG, which it does take.
    let keeps = AttachmentRules.imageExtensions.contains(ext)
    let limit = isImage ? AttachmentRules.maxImageBytes : AttachmentRules.maxFileBytes

    if let known, known > limit {
      throw .tooLarge(limitBytes: limit, size: known)
    }

    guard isImage else {
      return try stage(copying: received, name: name, mimeType: type?.preferredMIMEType)
    }

    do {
      var display = name
      let destination: URL

      if keeps {
        destination = try slot(for: display)

        do {
          try AttachmentPrivacy.copyWithoutLocation(from: received, to: destination)
        } catch {
          // ImageIO could not strip this format by copying it. A lossless one is written again as
          // itself (the pixels are the picture's own), anything else as a JPEG.
          discard(destination)

          if let lossless = Self.losslessTypes[ext] {
            return try convert(received, as: name, type: lossless)
          }

          display = jpegName(for: name)
          return try convert(received, as: display)
        }
      } else {
        display = jpegName(for: name)
        return try convert(received, as: display)
      }

      return try described(destination, name: display, type: type)
    } catch let failure as StagingFailure {
      throw failure
    } catch {
      throw .unreadable(message: (error as NSError).localizedDescription)
    }
  }

  /// The formats an image can be written again in without losing a pixel, by extension.
  private static let losslessTypes: [String: UTType] = ["png": .png, "tiff": .tiff, "tif": .tiff, "bmp": .bmp]

  private static func convert(_ received: URL, as name: String, type: UTType = .jpeg) throws -> PickedFile {
    let destination = try slot(for: name)

    do {
      try AttachmentPrivacy.reencode(from: received, to: destination, as: type)
    } catch {
      discard(destination)
      throw StagingFailure.unreadable(message: (error as NSError).localizedDescription)
    }

    return try described(destination, name: name, type: type)
  }

  /// The staged copy as a `PickedFile`, refused (and deleted) when the result is over the image cap.
  private static func described(_ destination: URL, name: String, type: UTType?) throws -> PickedFile {
    let size = size(of: destination) ?? 0

    if size > AttachmentRules.maxImageBytes {
      discard(destination)
      throw StagingFailure.tooLarge(limitBytes: AttachmentRules.maxImageBytes, size: size)
    }

    return PickedFile(name: name, mimeType: type?.preferredMIMEType, size: size, url: destination)
  }

  /// `IMG_0111.HEIC` as `IMG_0111.jpg`.
  static func jpegName(for name: String) -> String {
    let base = (name as NSString).deletingPathExtension

    return "\(base.isEmpty ? "image" : base).jpg"
  }
}
