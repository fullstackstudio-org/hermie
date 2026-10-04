import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

@Suite("The code scan's model") @MainActor
struct InteractiveScanModelTests {
  private func request(_ id: String = "req_scan_any") throws -> ScanRequest {
    guard case .scan(let request) = try DeviceExamples.prompt("device.scan", id: id).body else {
      throw DeviceExamples.ReadFailure(method: "device.scan")
    }

    return request
  }

  // MARK: The system is not asked before Scan

  @Test("nothing is asked of the system until the person presses Scan, and the prompt comes only then")
  func askedOnlyOnScan() async throws {
    let authorization = FakeCaptureAuthorization(camera: .notDetermined)
    let model = InteractiveScanModel(request: try request(), authorization: authorization)

    #expect(model.phase == .ready)
    #expect(authorization.snapshot.cameraRequests == 0, "made, shown and left alone: no prompt")

    await model.start()
    #expect(authorization.snapshot.cameraRequests == 1)
    #expect(model.phase == .scanning)

    // A second press while it looks asks nothing more.
    await model.start()
    #expect(authorization.snapshot.cameraRequests == 1)
  }

  @Test("a camera already allowed is used without asking; one refused, restricted or missing is said, never asked again by us")
  func permissions() async throws {
    let granted = FakeCaptureAuthorization(camera: .granted)
    let one = InteractiveScanModel(request: try request(), authorization: granted)
    await one.start()
    #expect(one.phase == .scanning && granted.snapshot.cameraRequests == 0)

    let denied = FakeCaptureAuthorization(camera: .denied)
    let two = InteractiveScanModel(request: try request(), authorization: denied)
    await two.start()
    #expect(two.phase == .unavailable(.denied) && denied.snapshot.cameraRequests == 0)
    #expect(two.unavailable?.reason == "permission_denied")

    let restricted = FakeCaptureAuthorization(camera: .restricted)
    let three = InteractiveScanModel(request: try request(), authorization: restricted)
    await three.start()
    #expect(three.phase == .unavailable(.restricted) && three.unavailable?.reason == "permission_denied")

    // The person says no in the system's prompt.
    let refusing = FakeCaptureAuthorization(camera: .notDetermined)
    refusing.set { $0.allowCamera = false }
    let four = InteractiveScanModel(request: try request(), authorization: refusing)
    await four.start()
    #expect(four.phase == .unavailable(.denied) && refusing.snapshot.cameraRequests == 1)

    // Later allowed in Settings: pressing Scan again looks.
    refusing.set { $0.camera = .granted }
    await four.start()
    #expect(four.phase == .scanning)

    // The scanner could not start after all.
    let five = InteractiveScanModel(request: try request(), authorization: FakeCaptureAuthorization(camera: .granted))
    await five.start()
    five.scannerFailed()
    #expect(five.phase == .unavailable(.noCamera) && five.unavailable?.reason == "no_camera")
  }

  // MARK: Reading a code

  @Test("a code is shown cleaned, with what was done to it, and goes out only as that")
  func foundValue() async throws {
    let model = InteractiveScanModel(request: try request(), authorization: FakeCaptureAuthorization(camera: .granted))

    // Not before the camera is on.
    model.detected("early", as: .qr)
    #expect(model.phase == .ready)

    await model.start()
    model.detected("https://exa\u{200B}mple.com/\u{202E}txt.exe", as: .qr)

    let found = try #require(model.found)
    #expect(found.value == "https://example.com/txt.exe" && found.wasCleaned && found.isSendable && found.symbology == .qr)
    #expect(found.preview == found.value)
    #expect(model.answer == .scan(value: "https://example.com/txt.exe", symbology: .qr))

    // The first code wins: another read while it is shown changes nothing.
    model.detected("second", as: .qr)
    #expect(model.found?.value == "https://example.com/txt.exe")

    model.rescan()
    #expect(model.phase == .scanning && model.answer == nil)
    model.detected("WIFI:T:WPA;S:my  net;;", as: .qr)
    #expect(model.found?.value == "WIFI:T:WPA;S:my  net;;" && model.found?.wasCleaned == false)
  }

  @Test("only the kinds the request asks for are taken; the rest is looked past")
  func formats() async throws {
    let model = InteractiveScanModel(
      request: try request("req_scan_ean"), authorization: FakeCaptureAuthorization(camera: .granted))
    #expect(model.symbologies == [.ean13, .ean8])

    await model.start()
    model.detected("https://example.com/box", as: .qr)
    #expect(model.phase == .scanning)
    model.detected("012345678905", as: .unknown("upca"))
    #expect(model.phase == .scanning)
    model.detected("4006381333931", as: .ean13)
    #expect(model.found?.symbology == .ean13)

    let any = InteractiveScanModel(request: try request(), authorization: FakeCaptureAuthorization(camera: .granted))
    #expect(any.symbologies == ScanSymbology.knownCases)
  }

  @Test("a code with nothing visible, or too much, is shown and cannot be sent; Scan again is the way on")
  func unsendable() async throws {
    let model = InteractiveScanModel(request: try request(), authorization: FakeCaptureAuthorization(camera: .granted))
    await model.start()

    model.detected("\u{200B}\u{202E} \u{200B}", as: .qr)
    #expect(model.found?.problem == .empty && model.answer == nil && model.found?.isSendable == false)

    model.rescan()
    model.detected(String(repeating: "x", count: 5_000), as: .qr)
    #expect(model.found?.problem == .tooLong(count: 5_000) && model.answer == nil)
    #expect((model.found?.preview.unicodeScalars.count ?? 0) <= 1_001, "a long value is shown cut, and never sent")

    model.rescan()
    model.detected(String(repeating: "x", count: 4_096), as: .qr)
    #expect(model.answer != nil)
  }

  @Test("the camera goes off when the app leaves the front, and an empty read is no code")
  func pausing() async throws {
    let model = InteractiveScanModel(request: try request(), authorization: FakeCaptureAuthorization(camera: .granted))
    await model.start()
    model.detected("", as: .qr)
    #expect(model.phase == .scanning)
    model.pause()
    #expect(model.phase == .ready)

    // A code read is kept while the app is away.
    await model.start()
    model.detected("x", as: .qr)
    model.pause()
    #expect(model.found?.value == "x")
  }

  @Test("what the model answers is accepted by the request's own reply")
  func answerReplies() async throws {
    let prompt = try DeviceExamples.prompt("device.scan", id: "req_scan_any")
    guard case .scan(let request) = prompt.body else { return }

    let model = InteractiveScanModel(request: request, authorization: FakeCaptureAuthorization(camera: .granted))
    await model.start()
    model.detected("WIFI:T:WPA;S:Home 5G;P:correct horse;;", as: .qr)

    let answer = try #require(model.answer)
    let reply = try #require(prompt.reply(to: answer))
    #expect(reply.result == ["status": "answered", "value": "WIFI:T:WPA;S:Home 5G;P:correct horse;;", "symbology": "qr"])
  }
}

@Suite("What this device advertises")
struct ScanAndSignatureAvailabilityTests {
  @Test("the signature pad is advertised everywhere; the code scan only where there is a camera")
  func methods() {
    let withCamera = InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(signature: true, scan: true))
    let without = InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(signature: true, scan: false))

    #expect(withCamera == ["input.form", "input.file", "review.draft", "review.diff", "input.signature", "device.scan"])
    #expect(without == ["input.form", "input.file", "review.draft", "review.diff", "input.signature"])
    #expect(InteractiveCapabilities.defaultMethods(availability: DeviceAvailability(signature: true, scan: false)) == without)
    #expect(!without.contains("device.scan"))
  }

  @Test("the list is the contract's order, a subset of what the build reads")
  func order() {
    for camera in [true, false] {
      let list = InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(signature: true, scan: camera))
      #expect(list == ServerRequestBody.Method.interactive.filter(list.contains))
      #expect(Set(list).isSubset(of: Set(ServerRequestBody.Method.interactive)))
    }

    #expect(DeviceAvailability(signature: true, scan: true).offers("input.signature"))
    #expect(!DeviceAvailability(signature: true, scan: false).offers("device.scan"))
    #expect(DeviceAvailability(signature: true, scan: false).offers("input.form"))
  }

  @Test("asking the system what it has prompts for nothing and never fails")
  func liveProbe() {
    _ = DeviceAvailability.system
    _ = CameraDevices.hasMicrophone
    _ = SystemCaptureAuthorization().cameraAccess()
    _ = SystemCaptureAuthorization().microphoneAccess()
  }
}
