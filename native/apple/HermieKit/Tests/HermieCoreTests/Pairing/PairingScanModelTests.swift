import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import HermieCore

@Suite("The pairing scan's model") @MainActor
struct PairingScanModelTests {
  private let good = "hermie://add-gateway?url=https%3A%2F%2Fgw.example.test&name=Home"
  private let offer = GatewayPairingOffer(address: "https://gw.example.test", name: "Home")

  private func png(_ text: String) throws -> Data {
    let image = try #require(PairingQRCode.image(for: text))
    let data = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))

    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return data as Data
  }

  // MARK: The camera is not touched before Scan

  @Test("nothing is asked of the system until Scan is pressed, and then only once")
  func askedOnlyOnScan() async {
    let authorization = FakeCaptureAuthorization(camera: .notDetermined)
    let model = PairingScanModel(authorization: authorization)

    #expect(model.phase == .ready)
    #expect(authorization.snapshot.cameraRequests == 0)

    await model.start()
    #expect(model.phase == .scanning)
    #expect(authorization.snapshot.cameraRequests == 1)

    await model.start()
    #expect(authorization.snapshot.cameraRequests == 1)
  }

  @Test("a camera that is allowed, refused or restricted is said; one the person refuses in the prompt is denied")
  func permissions() async {
    let granted = FakeCaptureAuthorization(camera: .granted)
    let one = PairingScanModel(authorization: granted)
    await one.start()
    #expect(one.phase == .scanning && granted.snapshot.cameraRequests == 0)

    let denied = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .denied))
    await denied.start()
    #expect(denied.unavailable == .denied)

    let restricted = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .restricted))
    await restricted.start()
    #expect(restricted.unavailable == .restricted)

    let refusing = FakeCaptureAuthorization(camera: .notDetermined)
    refusing.set { $0.allowCamera = false }
    let four = PairingScanModel(authorization: refusing)
    await four.start()
    #expect(four.unavailable == .denied)
  }

  // MARK: Reading

  @Test("a code read by the camera is shown as an offer, and a second code does not replace it")
  func cameraOffer() async {
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .granted))

    // Not looking yet: a code is not read.
    model.detected(good)
    #expect(model.phase == .ready)

    await model.start()
    model.detected(good)
    #expect(model.offer == offer)

    model.detected("hermie://add-gateway?url=https%3A%2F%2Fother.example.test")
    #expect(model.offer == offer, "the first code decides")
  }

  @Test("a code that is not an offer is refused in a sentence and nothing is added")
  func refusals() async {
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .granted))

    await model.start()
    model.detected("https://evil.example")
    #expect(model.refusal == .notAnOffer)

    model.reset()
    #expect(model.phase == .ready)

    await model.start()
    model.detected("hermie://add-gateway?url=http%3A%2F%2Fgw.example.test")
    #expect(model.refusal == .notSecure(host: "gw.example.test"))
    #expect(model.offer == nil)
  }

  @Test("the camera going away is said, and leaving the front turns it off")
  func scannerLifecycle() async {
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .granted))

    await model.start()
    model.pause()
    #expect(model.phase == .ready)

    await model.start()
    model.scannerFailed()
    #expect(model.unavailable == .noCamera)
  }

  // MARK: A picture

  @Test("a picture of a code is read with Vision and shown as an offer, with or without the camera")
  func pictureOffer() async throws {
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .denied))

    await model.importImage(try png(good))
    #expect(model.offer == offer)
    #expect(!model.readingImage)
  }

  @Test("a picture with no gateway code, or one that is not a picture, is refused")
  func pictureRefusals() async throws {
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .granted))

    await model.importImage(Data("nope".utf8))
    #expect(model.refusal == .notAnOffer)

    await model.importImage(try png("https://evil.example"))
    #expect(model.refusal == .notAnOffer)

    await model.importImage(try png("hermie://add-gateway?url=http%3A%2F%2Fgw.example.test"))
    #expect(model.refusal == .notSecure(host: "gw.example.test"))

    model.reset()
    await model.importImage(try png(good))
    #expect(model.offer == offer)
  }

  @Test("a picture is read off the main actor, and the sheet says it is busy meanwhile")
  func pictureIsReadAway() async throws {
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .granted))
    let data = try png(good)
    let reading = Task { await model.importImage(data) }

    // The main actor is free while Vision works: this line runs between the start and the answer.
    while !model.readingImage, model.offer == nil {
      await Task.yield()
    }

    await reading.value
    #expect(model.offer == offer && !model.readingImage)
  }

  /// A picture reader that answers only when the test lets it: the race is ordered, not timed.
  private final class HeldReader: @unchecked Sendable {
    private let release = DispatchSemaphore(value: 0)
    let answer: [String]

    init(answer: [String]) { self.answer = answer }

    func read(_ data: Data) -> [String] {
      release.wait()
      return answer
    }

    func letGo() { release.signal() }
  }

  @Test("a picture that is answered after the sheet was reset is dropped")
  func staleAfterReset() async throws {
    let reader = HeldReader(answer: [good])
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .granted), readCodes: reader.read)
    let reading = Task { await model.importImage(Data([1])) }

    while !model.readingImage {
      await Task.yield()
    }

    model.reset()
    reader.letGo()
    await reading.value
    #expect(model.phase == .ready, "the person went back: the late answer does not appear")
    #expect(!model.readingImage)
  }

  @Test("a code the camera read while a picture was being read is not replaced by the picture")
  func cameraBeatsPicture() async throws {
    let reader = HeldReader(answer: [good])
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .granted), readCodes: reader.read)
    let other = "hermie://add-gateway?url=https%3A%2F%2Fcamera.example.test"

    await model.start()

    let reading = Task { await model.importImage(Data([1])) }

    while !model.readingImage {
      await Task.yield()
    }

    model.detected(other)
    reader.letGo()
    await reading.value
    #expect(model.offer?.host == "camera.example.test")
  }

  @Test("a picture that is answered with nothing while a code is already shown leaves it alone")
  func foundStays() async throws {
    let model = PairingScanModel(authorization: FakeCaptureAuthorization(camera: .granted))

    await model.importImage(try png(good))
    await model.importImage(Data("nope".utf8))
    #expect(model.offer == offer, "a second picture does not take a shown offer away")
  }
}
