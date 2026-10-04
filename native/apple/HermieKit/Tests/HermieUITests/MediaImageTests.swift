import CoreGraphics
import Foundation
import HermieMarkdown
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import HermieUI

/// How a message's pictures are laid out, the gallery's state, the zoom arithmetic, and the store
/// behind them. All of it is plain values and one small file on disk: nothing is drawn.
@MainActor
struct MediaImageLayoutTests {
  @Test func columnsFollowTheCount() {
    #expect([0, 1, 2, 3, 4, 5, 6, 9].map(MediaImageLayout.columns(forCount:)) == [1, 1, 2, 3, 2, 3, 3, 3])
  }

  @Test func aLonePictureIsOneWideFrame() {
    let plan = MediaImageLayout.plan(count: 1, width: 400)
    #expect(plan.size == CGSize(width: 260, height: 195))
    #expect(plan.cells == [.init(rect: CGRect(x: 0, y: 0, width: 260, height: 195), index: 0, overflow: nil)])
  }

  @Test func aNarrowRoomShrinksTheFrameAndKeepsItsShape() {
    let plan = MediaImageLayout.plan(count: 1, width: 200)
    #expect(plan.size == CGSize(width: 200, height: 150))
  }

  @Test func twoPicturesAreTwoSquares() {
    let plan = MediaImageLayout.plan(count: 2, width: 260)
    #expect(plan.columns == 2)
    #expect(plan.size == CGSize(width: 260, height: 128))
    #expect(plan.cells.map(\.rect) == [CGRect(x: 0, y: 0, width: 128, height: 128), CGRect(x: 132, y: 0, width: 128, height: 128)])
  }

  @Test func threePicturesGoAcross() {
    let plan = MediaImageLayout.plan(count: 3, width: 260)
    #expect(plan.columns == 3)
    #expect(plan.cells.count == 3)
    #expect(plan.cells.allSatisfy { $0.rect.minY == 0 && $0.rect.width == $0.rect.height })
    #expect(plan.size.height == plan.cells[0].rect.height)
    #expect(plan.size.width <= 260)
  }

  @Test func fourPicturesAreTwoByTwo() {
    let plan = MediaImageLayout.plan(count: 4, width: 260)
    #expect(plan.columns == 2)
    #expect(plan.cells.map(\.rect.origin.y) == [0, 0, 132, 132])
    #expect(plan.size.height == CGFloat(260))
  }

  @Test func theFramesNeverLeaveTheBlock() {
    for count in 1...14 {
      for width in [120, 180, 260, 400] as [CGFloat] {
        let plan = MediaImageLayout.plan(count: count, width: width)
        #expect(plan.size.width <= width + 0.001, "\(count) in \(width)")
        #expect(plan.cells.count == MediaImageLayout.visibleCount(count))
        for cell in plan.cells {
          #expect(cell.rect.minX >= 0 && cell.rect.minY >= 0)
          #expect(cell.rect.maxX <= plan.size.width + 0.001 && cell.rect.maxY <= plan.size.height + 0.001, "\(count) in \(width)")
        }
        // No two frames overlap.
        for (a, b) in zip(plan.cells, plan.cells.dropFirst()) {
          #expect(!a.rect.intersects(b.rect))
        }
      }
    }
  }

  @Test func moreThanNineSaysHowManyThereAre() {
    let plan = MediaImageLayout.plan(count: 12, width: 260)
    #expect(plan.cells.count == 9)
    #expect(plan.cells.dropLast().allSatisfy { $0.overflow == nil })
    // The ninth frame shows the ninth picture and stands for it and the three after it.
    #expect(plan.cells.last?.index == 8)
    #expect(plan.cells.last?.overflow == 4)

    let exactly = MediaImageLayout.plan(count: 9, width: 260)
    #expect(exactly.cells.allSatisfy { $0.overflow == nil })
  }

  @Test func theLayoutAsksForRoomNotForPictures() {
    // A probe (no width, an infinite one, none at all) gets the widest block, never an infinite one.
    for probe in [nil, 0, -10, .infinity] as [CGFloat?] {
      #expect(MediaImageLayout.plan(count: 1, width: probe).size.width == MediaImageLayout.maxWidth)
    }
    // And the plan is a function of count and width alone: the same inputs, the same plan.
    #expect(MediaImageLayout.plan(count: 5, width: 240) == MediaImageLayout.plan(count: 5, width: 240))
    #expect(MediaImageLayout.plan(count: 0, width: 240).cells.isEmpty)
  }

  @Test func aPictureIsFittedIntoItsFrame() {
    let frame = CGSize(width: 260, height: 195)
    #expect(MediaImageLayout.fitted(aspect: 2, in: frame) == CGSize(width: 260, height: 130))
    #expect(MediaImageLayout.fitted(aspect: 0.5, in: frame) == CGSize(width: 97.5, height: 195))
    #expect(MediaImageLayout.fitted(aspect: 260.0 / 195.0, in: frame).width == 260)
    #expect(MediaImageLayout.fitted(aspect: 0, in: frame) == frame)
    #expect(MediaImageLayout.fitted(aspect: .nan, in: frame) == frame)
  }

  @Test func thumbnailsAreDecodedInSteps() {
    #expect(MediaImageLayout.thumbnailPixels(for: CGSize(width: 260, height: 195), scale: 3) == 832)
    #expect(MediaImageLayout.thumbnailPixels(for: CGSize(width: 128, height: 128), scale: 3) == 384)
    #expect(MediaImageLayout.thumbnailPixels(for: CGSize(width: 10, height: 10), scale: 1) == 64)
    // Two frames of nearly one size share a decode.
    #expect(
      MediaImageLayout.thumbnailPixels(for: CGSize(width: 128, height: 128), scale: 3)
        == MediaImageLayout.thumbnailPixels(for: CGSize(width: 125, height: 125), scale: 3))
  }
}

@MainActor
struct ImageGalleryModelTests {
  private func images(_ count: Int) -> [MessageImage] {
    (0..<count).map { MessageImage(reference: "/api/files/\($0).png", name: "\($0).png") }
  }

  @Test func opensOnTheTappedPicture() {
    let model = ImageGalleryModel(images: images(5), start: 3)
    #expect(model.index == 3)
    #expect(model.current?.name == "3.png")
    #expect(model.position?.current == 4 && model.position?.total == 5)
  }

  @Test func theStartIsClampedIntoRange() {
    #expect(ImageGalleryModel(images: images(3), start: 9).index == 2)
    #expect(ImageGalleryModel(images: images(3), start: -4).index == 0)
    let empty = ImageGalleryModel(images: [], start: 2)
    #expect(empty.isEmpty && empty.current == nil && empty.position == nil && empty.preload.isEmpty)
  }

  @Test func swipingStopsAtTheEnds() {
    var model = ImageGalleryModel(images: images(3), start: 0)
    #expect(!model.hasPrevious && model.hasNext)
    #expect(model.previous() == false)
    #expect(model.next() && model.next())
    #expect(model.index == 2 && !model.hasNext)
    #expect(model.next() == false)
    #expect(model.index == 2)
    #expect(model.previous() && model.index == 1)
  }

  @Test func selectingReportsWhetherItMoved() {
    var model = ImageGalleryModel(images: images(4), start: 1)
    #expect(model.select(1) == false)
    #expect(model.select(99) && model.index == 3)
    #expect(model.select(-5) && model.index == 0)
  }

  @Test func aLonePictureHasNoPosition() {
    #expect(ImageGalleryModel(images: images(1)).position == nil)
  }

  @Test func theNeighboursAreWorthDecodingEarly() {
    #expect(ImageGalleryModel(images: images(5), start: 0).preload == [0, 1])
    #expect(ImageGalleryModel(images: images(5), start: 2).preload == [1, 2, 3])
    #expect(ImageGalleryModel(images: images(5), start: 4).preload == [3, 4])
    #expect(ImageGalleryModel(images: images(1)).preload == [0])
  }
}

@MainActor
struct ImageZoomTests {
  @Test func startsAtRest() {
    let zoom = ImageZoom()
    #expect(zoom.scale == 1 && zoom.offset == .zero && !zoom.isZoomed)
  }

  @Test func theScaleIsHeldInRange() {
    var zoom = ImageZoom()
    zoom.setScale(100)
    #expect(zoom.scale == ImageZoom.maximumScale && zoom.isZoomed)
    zoom.setScale(0.1)
    #expect(zoom.scale == 1 && !zoom.isZoomed)
    zoom.setScale(.nan)
    #expect(zoom.scale == 1)
  }

  @Test func comingBackToRestCentresThePicture() {
    var zoom = ImageZoom()
    zoom.setScale(3)
    zoom.offset = CGSize(width: 40, height: -20)
    zoom.setScale(1)
    #expect(zoom.offset == .zero)
  }

  @Test func aDoubleTapZoomsInAndBack() {
    var zoom = ImageZoom()
    zoom.toggle()
    #expect(zoom.scale == ImageZoom.doubleTapScale)
    zoom.offset = CGSize(width: 10, height: 10)
    zoom.toggle()
    #expect(zoom == ImageZoom())
  }

  @Test func theOffsetCannotPullAnEdgeIntoTheView() {
    let container = CGSize(width: 400, height: 800)
    let fitted = CGSize(width: 400, height: 300)
    // At rest nothing moves.
    #expect(ImageZoom.clampedOffset(CGSize(width: 90, height: 90), scale: 1, fitted: fitted, container: container) == .zero)
    // At 2x the picture is 800 wide in a 400 view: it may move 200 either way sideways, and not at all
    // up or down, where it is 600 tall in an 800 view.
    let clamped = ImageZoom.clampedOffset(CGSize(width: 500, height: -500), scale: 2, fitted: fitted, container: container)
    #expect(clamped == CGSize(width: 200, height: 0))
    let inside = ImageZoom.clampedOffset(CGSize(width: -120, height: 0), scale: 2, fitted: fitted, container: container)
    #expect(inside == CGSize(width: -120, height: 0))
    // At 4x it is 1200 tall in an 800 view.
    #expect(ImageZoom.clampedOffset(CGSize(width: 0, height: 900), scale: 4, fitted: fitted, container: container).height == 200)
  }
}

// MARK: - The store

@MainActor
@Suite(.serialized) struct MessageImageStoreTests {
  /// A small PNG on disk, `width` by `height` pixels.
  static func makeImage(width: Int, height: Int, name: String = UUID().uuidString) throws -> URL {
    let space = CGColorSpaceCreateDeviceRGB()
    let context = try #require(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).png")
    let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return url
  }

  /// Counts how often each reference was resolved.
  @MainActor final class Calls {
    var counts: [String: Int] = [:]
    var peak = 0
    var running = 0
  }

  @Test func decodesAThumbnailNoLargerThanAsked() async throws {
    let url = try Self.makeImage(width: 800, height: 400)
    defer { try? FileManager.default.removeItem(at: url) }
    let store = MessageImageStore { _ in url }

    let data = try #require(await store.image("/api/files/a.png", maxPixel: 200))
    #expect(max(data.image.width, data.image.height) == 200)
    #expect(abs(data.aspect - 2) < 0.02)

    let full = try #require(await store.image("/api/files/a.png", maxPixel: 3000))
    #expect(full.image.width == 800, "never scaled up")
  }

  @Test func aDecodedThumbnailIsAtHandForTheNextRow() async throws {
    let url = try Self.makeImage(width: 100, height: 100)
    defer { try? FileManager.default.removeItem(at: url) }
    let store = MessageImageStore { _ in url }

    #expect(store.cached("/api/files/a.png", maxPixel: 128) == nil)
    _ = await store.image("/api/files/a.png", maxPixel: 128)
    #expect(store.cached("/api/files/a.png", maxPixel: 128) != nil)
    #expect(store.cached("/api/files/a.png", maxPixel: 256) == nil, "another size is another entry")
  }

  @Test func oneFileIsFetchedOnceWhoeverAsks() async throws {
    let url = try Self.makeImage(width: 64, height: 64)
    defer { try? FileManager.default.removeItem(at: url) }
    let calls = Calls()
    let store = MessageImageStore { reference in
      calls.counts[reference, default: 0] += 1
      try? await Task.sleep(for: .milliseconds(30))
      return url
    }

    let first = Task { await store.image("/api/files/a.png", maxPixel: 128) }
    let second = Task { await store.image("/api/files/a.png", maxPixel: 256) }
    let file = Task { await store.file("/api/files/a.png") }
    let firstImage = await first.value
    let secondImage = await second.value
    let fileURL = await file.value
    #expect(firstImage != nil && secondImage != nil)
    #expect(fileURL == url)
    #expect(calls.counts["/api/files/a.png"] == 1)
  }

  @Test func aFailureIsRememberedForAWhileAndThenForgottenOnRetry() async {
    let calls = Calls()
    let store = MessageImageStore { reference in
      calls.counts[reference, default: 0] += 1
      return nil
    }

    #expect(await store.image("/api/files/gone.png", maxPixel: 128) == nil)
    #expect(await store.image("/api/files/gone.png", maxPixel: 128) == nil)
    #expect(calls.counts["/api/files/gone.png"] == 1, "the second ask did not go to the gateway")

    store.retry("/api/files/gone.png")
    #expect(await store.image("/api/files/gone.png", maxPixel: 128) == nil)
    #expect(calls.counts["/api/files/gone.png"] == 2)
  }

  @Test func aFileThatIsNotAPictureIsNoPicture() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).png")
    try Data("not an image".utf8).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let store = MessageImageStore { _ in url }

    #expect(await store.image("/api/files/a.png", maxPixel: 128) == nil)
    #expect(MediaImageDecoder.decode(url: url, maxPixel: 128) == nil)
    #expect(MediaImageDecoder.decode(url: url.appendingPathExtension("missing"), maxPixel: 128) == nil)
  }

  @Test func onlyAFewFilesAreFetchedAtOnce() async throws {
    let url = try Self.makeImage(width: 16, height: 16)
    defer { try? FileManager.default.removeItem(at: url) }
    let calls = Calls()
    let store = MessageImageStore { _ in
      calls.running += 1
      calls.peak = max(calls.peak, calls.running)
      try? await Task.sleep(for: .milliseconds(20))
      calls.running -= 1
      return url
    }

    let fetches = (0..<10).map { index in Task { await store.file("/api/files/\(index).png") } }
    for fetch in fetches {
      let fetched = await fetch.value
      #expect(fetched == url)
    }
    #expect(calls.peak == MessageImageStore.maximumFetches)
    #expect(calls.running == 0)
  }

  @Test func theGalleryIsTheStoresToShow() {
    let store = MessageImageStore { _ in nil }
    let images = (0..<3).map { MessageImage(reference: "/api/files/\($0).png", name: "\($0).png") }

    #expect(store.presentation == nil)
    store.present([], at: 0)
    #expect(store.presentation == nil, "nothing to show")
    store.present(images, at: 2)
    #expect(store.presentation?.model.index == 2)
    store.dismissGallery()
    #expect(store.presentation == nil)
  }
}
