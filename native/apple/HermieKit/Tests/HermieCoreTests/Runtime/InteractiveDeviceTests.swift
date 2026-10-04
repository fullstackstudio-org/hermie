import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

private let contractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract", isDirectory: true)
}()

/// The params of the contract's frame with this request id, for the harness's runtime session.
private func frame(_ method: String, _ id: String) throws -> JSONObject {
  let data = try Data(contentsOf: contractDirectory.appendingPathComponent("requests/examples.json"))
  let root = try JSONValue(parsing: data)
  let frames = try #require(root["methods"]?[method]?["frames"]?.arrayValue)
  let match = try #require(frames.first { $0["id"]?.stringValue == id }, "\(id)")
  var params = try #require(match["params"]?.objectValue)
  params["expires_at"] = .number(Double(InteractiveFrames.expires))
  return params
}

private func fix(_ lat: Double = 52.373123, _ lon: Double = 4.892201, accuracy: Double = 8.5) -> LocationFix {
  LocationFix(
    latitude: lat, longitude: lon, accuracyMeters: accuracy, time: Date(timeIntervalSince1970: 1_791_119_300))
}

/// A harness whose connection advertised every interactive method, the device requests included
/// (what this Mac offers is not what the tests are about).
@MainActor
private func harness() async throws -> InteractiveHarness {
  let h = InteractiveHarness(requests: ServerRequestBody.Method.interactive)
  try await h.open()
  return h
}

@Suite("Device requests: through the center, against the scripted gateway", .timeLimit(.minutes(1))) @MainActor
struct InteractiveDeviceTests {
  // MARK: Location

  @Test("a location request opens, is answered with the position the person shared, and the card says only how precisely")
  func locationRoundTrip() async throws {
    let h = try await harness()
    let prompt = try await h.raiseOpen("srq-loc", "device.location", params: try frame("device.location", "req_loc_precise"))
    #expect(prompt.method == "device.location" && prompt.offersSkip && prompt.actingUser == "Ada")

    let shared = try #require(SharedLocation(fix: fix(), chose: .approximate))
    #expect(await h.center.answer("srq-loc", .location(shared)))

    let result = try #require(h.answers("srq-loc").first)
    #expect(
      JSONValue.object(result)
        == ["status": "answered", "lat": 52.37, "lon": 4.89, "accuracy_m": 1_000, "at": 1_791_119_300, "precision": "approximate"])

    let card = try #require(await h.card("srq-loc"))
    #expect(card.state == .answered)
    #expect(card.answerSummary?.status == "answered" && card.answerSummary?.precision == "approximate")
    let text = "\(card.jsonValue)"
    #expect(!text.contains("52.37") && !text.contains("4.89"), "the transcript holds no coordinate")
  }

  @Test("a precise answer for an approximate request never goes out")
  func neverMoreThanAsked() async throws {
    let h = try await harness()
    try await h.raiseOpen("srq-loc", "device.location", params: try frame("device.location", "req_loc_approx"))
    let precise = try #require(SharedLocation(fix: fix(), chose: .precise))

    #expect(await h.center.answer("srq-loc", .location(precise)) == false)
    #expect(h.answers("srq-loc").isEmpty && h.center.isOpen("srq-loc"))

    let lowered = try #require(SharedLocation(fix: fix(), chose: .approximate))
    #expect(await h.center.answer("srq-loc", .location(lowered)))
  }

  @Test("a refused permission answers the error 4041 permission_denied and leaves a notice on the chat")
  func permissionDenied() async throws {
    let h = try await harness()
    try await h.raiseOpen("srq-loc", "device.location", params: try frame("device.location", "req_loc_approx"))
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-loc")

    let location = InteractiveLocationModel(
      request: DeviceLocationRequest(precision: .approximate), provider: DeniedLocation())
    let step = try #require(await location.share())
    #expect(step == .cannotShow(reason: "permission_denied"))
    #expect(await model.perform(step))

    #expect(h.cannotShowReason("srq-loc") == "permission_denied")
    #expect(h.link.answers.isEmpty, "not a made-up skip")
    #expect(!h.center.isOpen("srq-loc"))
    #expect(
      h.center.notices[bot]?.notice == .cannotShow(method: "device.location", reason: "permission_denied"),
      "the person sees it too")
    #expect(model.notice?.requestID == "srq-loc" && model.presentedID == nil)

    let card = try #require(await h.card("srq-loc"))
    #expect(card.state == .cancelled && card.cancelReason == "cannot_show")
  }

  @Test("no position at all is location_unavailable, with its own notice")
  func locationUnavailable() async throws {
    let h = try await harness()
    try await h.raiseOpen("srq-loc", "device.location", params: try frame("device.location", "req_loc_precise"))
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-loc")

    #expect(await model.perform(.cannotShow(reason: CannotShowReason.locationUnavailable)))
    #expect(h.cannotShowReason("srq-loc") == "location_unavailable")
    #expect(h.center.notices[bot]?.notice == .cannotShow(method: "device.location", reason: "location_unavailable"))
  }

  @Test("a cannot_show the person chose (Don't share) leaves no notice: it is not a failure")
  func declineLeavesNoNotice() async throws {
    let h = try await harness()
    try await h.raiseOpen("srq-loc", "device.location", params: try frame("device.location", "req_loc_required"))
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-loc")

    #expect(await model.cannotShow(reason: CannotShowReason.declined))
    #expect(h.cannotShowReason("srq-loc") == "declined")
    #expect(h.center.notices[bot] == nil)
  }

  // MARK: Contact

  @Test("a contact request is answered with only the ticked fields, and the card names the fields, never a value")
  func contactRoundTrip() async throws {
    let h = try await harness()
    let prompt = try await h.raiseOpen("srq-c", "device.contact", params: try frame("device.contact", "req_contact_phone"))
    guard case .contact(let request) = prompt.body else {
      Issue.record("not a contact request")
      return
    }

    let contact = InteractiveContactModel(request: request)
    contact.choose(
      ContactSnapshot(
        name: "Bram de Vries", phones: ["+31 6 12345678"], emails: ["bram@example.com"],
        postal: ["Keizersgracht 12"], birthday: ContactBirthday(year: 1984, month: 3, day: 17), organization: "BV"))
    let answer = try #require(contact.answer)

    #expect(await h.center.answer("srq-c", answer))
    #expect(
      JSONValue.object(try #require(h.answers("srq-c").first))
        == ["status": "answered", "contact": ["name": "Bram de Vries", "phones": ["+31 6 12345678"]]],
      "no emails, no address, no birthday: nobody asked")

    let card = try #require(await h.card("srq-c"))
    #expect(card.answerSummary?.status == "answered" && card.answerSummary?.fields == ["name", "phones"])
    let text = "\(card.jsonValue)"
    #expect(!text.contains("Bram") && !text.contains("+31") && !text.contains("example.com"))
  }

  @Test("a contact answer that carries a key nobody asked for is not sent")
  func refusesAnExtraKey() async throws {
    let h = try await harness()
    let prompt = try await h.raiseOpen("srq-c", "device.contact", params: try frame("device.contact", "req_contact_phone"))
    guard case .contact(let request) = prompt.body else { return }

    // The model never builds this; a client bug that did must not reach the gateway.
    let wide = InteractiveContactModel(request: DeviceContactRequest(fields: [.name, .phones, .emails]))
    wide.choose(ContactSnapshot(name: "Bram", phones: ["1"], emails: ["b@example.com"]))
    guard case .contact(let tooMuch)? = wide.answer else {
      Issue.record("no answer")
      return
    }

    #expect(request.fields == [.name, .phones])
    #expect(await h.center.answer("srq-c", .contact(tooMuch)) == false)
    #expect(h.answers("srq-c").isEmpty && h.center.isOpen("srq-c"))
  }

  @Test("an empty contact is not an answer")
  func refusesAnEmptyContact() async throws {
    let h = try await harness()
    try await h.raiseOpen("srq-c", "device.contact", params: try frame("device.contact", "req_contact_phone"))
    let empty = SharedContact(snapshot: ContactSnapshot(), ticked: [.name], requested: [.name])
    #expect(await h.center.answer("srq-c", .contact(empty)) == false)
    #expect(h.answers("srq-c").isEmpty)
  }

  // MARK: Calendar

  @Test("a saved calendar entry is answered done, and the card says it was added, with no title")
  func calendarRoundTrip() async throws {
    let h = try await harness()
    try await h.raiseOpen("srq-cal", "device.calendar", params: try frame("device.calendar", "req_cal_event"))

    #expect(await h.center.answer("srq-cal", .calendarSaved))
    #expect(h.answers("srq-cal") == [["status": "done"]])

    let card = try #require(await h.card("srq-cal"))
    #expect(card.state == .answered && card.answerSummary?.status == "answered")
    #expect(!"\(card.jsonValue)".contains("Tandarts"))
  }

  @Test("cancelling the system's calendar sheet is a skip where the request offers one, and not where it does not")
  func calendarSkip() async throws {
    let h = try await harness()
    try await h.raiseOpen("srq-cal", "device.calendar", params: try frame("device.calendar", "req_cal_event"))
    #expect(await h.center.answer("srq-cal", .skip))
    #expect(h.answers("srq-cal") == [["status": "skipped"]])
    #expect(await h.card("srq-cal")?.answerSummary?.status == "skipped")

    try await h.raiseOpen("srq-req", "device.calendar", params: try frame("device.calendar", "req_cal_allday"))
    #expect(await h.center.answer("srq-req", .skip) == false)
    #expect(h.answers("srq-req").isEmpty)
  }

  // MARK: What cannot be shown

  @Test("a device request this build cannot show is declined with its reason, and the person is told once")
  func declinesWhatItCannotShow() async throws {
    let h = try await harness()
    var params = try frame("device.calendar", "req_cal_event")
    params["kind"] = "task"
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "srq-bad", method: "device.calendar", params: params)
    try await eventually("the notice") { await h.center.notices[bot] != nil }

    #expect(h.cannotShowReason("srq-bad") == "not_supported_on_device")
    #expect(h.center.notices[bot]?.notice == .cannotShow(method: "device.calendar", reason: "not_supported_on_device"))
    #expect(h.center.prompts.isEmpty)
  }

  @Test("only the methods the connection advertised are taken in")
  func onlyAdvertisedMethods() async throws {
    let base = InteractiveHarness(requests: InteractiveCapabilities.deviceMethods(availability: .none))
    try await base.open()
    var params = try frame("device.location", "req_loc_approx")
    params["session_id"] = .string(Fixture.runtime)
    base.link.raise(id: "srq-x", method: "device.location", params: params)
    try await Task.sleep(for: .milliseconds(30))
    #expect(base.center.prompts.isEmpty && base.link.answers.isEmpty)

    let all = try await harness()
    try await all.raiseOpen("srq-y", "device.location", params: try frame("device.location", "req_loc_approx"))
    #expect(all.center.isOpen("srq-y"))
  }
}

@MainActor
private final class DeniedLocation: DeviceLocationProvider {
  func locate(precision: LocationPrecision) async -> LocationOutcome { .denied }
}
