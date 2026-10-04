#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// A provider that gives the position it was told to, and remembers what it was asked for.
@MainActor
private final class StubLocation: DeviceLocationProvider {
  var outcome: LocationOutcome
  private(set) var asked: [LocationPrecision] = []

  init(_ outcome: LocationOutcome) {
    self.outcome = outcome
  }

  func locate(precision: LocationPrecision) async -> LocationOutcome {
    asked.append(precision)
    return outcome
  }
}

private func here(accuracy: Double = 12, reduced: Bool = false) -> LocationFix {
  LocationFix(
    latitude: 52.3731234, longitude: 4.8922019, accuracyMeters: accuracy, time: Date(), isReduced: reduced)
}

/// `device.location`, `device.contact` and `device.calendar` against the real fake gateway, over real
/// sockets: the gateway's own checks and what it tells the agent. The session announces every
/// interactive method, whatever this Mac offers.
extension Integration {
  @Suite("Device requests") @MainActor
  struct InteractiveDeviceIntegrationTests {
    private static let all = ServerRequestBody.Method.interactive

    @Test("a client announces the device requests it offers, and the gateway takes them")
    func announcesDeviceRequests() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let state = try await gateway.control("GET", "/__fake/state")
        let last = try #require(state["clientCapabilities"]?.arrayValue?.last)
        let advertised = (last["requests"]?.arrayValue ?? []).compactMap { $0.stringValue }
        #expect(advertised == Self.all)
        #expect(advertised.contains("device.location") && advertised.contains("device.contact") && advertised.contains("device.calendar"))
        await chat.session.shutdown()
      }
    }

    @Test("a client without the device requests is never sent one")
    func withoutDeviceRequests() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: InteractiveCapabilities.deviceMethods(availability: .none))
        await #expect(throws: FakeGatewayError.self) {
          try await gateway.control(
            "POST", "/__fake/request", body: .object(["profile": "researcher", "method": "device.location"]))
        }
        #expect(chat.model.openPrompts.isEmpty)
        await chat.session.shutdown()
      }
    }

    // MARK: Location

    @Test("an approximate location is asked of the system at reduced accuracy, shared, and rounded again by the gateway")
    func approximateLocation() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let id = try await chat.raise(gateway, "device.location", ["precision": "approximate"])

        let presented = try #require(chat.model.presented)
        guard case .location(let request) = presented.body else {
          Issue.record("not a location request")
          return
        }

        #expect(request.precision == .approximate)
        let provider = StubLocation(.fix(here()))
        let location = InteractiveLocationModel(request: request, provider: provider)
        #expect(provider.asked.isEmpty, "the system is not asked before Share")

        let step = try #require(await location.share())
        #expect(provider.asked == [.approximate])
        #expect(await chat.model.perform(step))

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["answer"]?["precision"] == "approximate")
        #expect(view["answer"]?["lat"] == 52.37 && view["answer"]?["lon"] == 4.89)
        #expect(view["answer"]?["accuracy_m"] == 1_000)
        #expect(view["answer"]?["lowered"] == nil)
        #expect(view["refusals"] == [])
        await chat.session.shutdown()
      }
    }

    @Test("a precise request the person lowers is answered approximate, and the agent is told it was lowered")
    func loweredLocation() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let id = try await chat.raise(gateway, "device.location", ["precision": "precise"])
        guard case .location(let request)? = chat.model.presented?.body else {
          Issue.record("not a location request")
          return
        }

        let provider = StubLocation(.fix(here()))
        let location = InteractiveLocationModel(request: request, provider: provider)
        #expect(location.canChoosePrecision)
        location.choose(.approximate)
        #expect(await chat.model.perform(try #require(await location.share())))
        #expect(provider.asked == [.approximate])

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["answer"]?["precision"] == "approximate")
        #expect(view["answer"]?["lowered"] == true)
        await chat.session.shutdown()
      }
    }

    @Test("a precise location keeps six decimals, and one the system reduced is sent as approximate")
    func preciseLocation() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let id = try await chat.raise(gateway, "device.location", ["precision": "precise"])
        guard case .location(let request)? = chat.model.presented?.body else { return }

        let location = InteractiveLocationModel(request: request, provider: StubLocation(.fix(here())))
        #expect(await chat.model.perform(try #require(await location.share())))
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["answer"]?["precision"] == "precise")
        #expect(view["answer"]?["lat"] == 52.373123 && view["answer"]?["lon"] == 4.892202)

        let second = try await chat.raise(gateway, "device.location", ["precision": "precise"])
        guard case .location(let again)? = chat.model.presented?.body else { return }
        let reduced = InteractiveLocationModel(request: again, provider: StubLocation(.fix(here(reduced: true))))
        #expect(await chat.model.perform(try #require(await reduced.share())))
        let reducedView = try await InteractiveChat.view(gateway, second)
        #expect(reducedView["answer"]?["precision"] == "approximate", "what the OS gave is what is said")
        #expect(reducedView["answer"]?["lat"] == 52.37)
        await chat.session.shutdown()
      }
    }

    @Test("a refused permission and no position tell the agent why, and are never a skip")
    func locationRefusals() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)

        let denied = try await chat.raise(gateway, "device.location", ["precision": "approximate"])
        guard case .location(let request)? = chat.model.presented?.body else { return }
        let refused = InteractiveLocationModel(request: request, provider: StubLocation(.denied))
        #expect(await chat.model.perform(try #require(await refused.share())))
        let deniedView = try await InteractiveChat.view(gateway, denied)
        #expect(deniedView["outcome"] == "unavailable")
        #expect(deniedView["reason"] == "permission_denied")
        #expect(deniedView["answer"] == nil)
        #expect(chat.session.interactive.notices["researcher"]?.notice == .cannotShow(method: "device.location", reason: "permission_denied"))

        let missing = try await chat.raise(gateway, "device.location", ["precision": "approximate"])
        let none = InteractiveLocationModel(request: request, provider: StubLocation(.unavailable))
        #expect(await chat.model.perform(try #require(await none.share())))
        let missingView = try await InteractiveChat.view(gateway, missing)
        #expect(missingView["outcome"] == "unavailable" && missingView["reason"] == "location_unavailable")
        await chat.session.shutdown()
      }
    }

    @Test("a skip is the skip where it is offered; a request that does not offer one has Don't share")
    func skipAndDecline() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)

        let skipped = try await chat.raise(gateway, "device.location", ["precision": "approximate"])
        #expect(await chat.model.skip())
        let skippedView = try await InteractiveChat.view(gateway, skipped)
        #expect(skippedView["outcome"] == "answered" && skippedView["answer"]?["status"] == "skipped")

        let required = try await chat.raise(gateway, "device.location", ["precision": "approximate", "optional": false])
        #expect(await chat.model.skip() == false, "the client does not even send a skip the gateway would refuse")
        #expect(await chat.model.cannotShow(reason: CannotShowReason.declined))
        let requiredView = try await InteractiveChat.view(gateway, required)
        #expect(requiredView["outcome"] == "unavailable" && requiredView["reason"] == "declined")
        #expect(chat.session.interactive.notices["researcher"] == nil)
        await chat.session.shutdown()
      }
    }

    // MARK: Contact

    @Test("only the ticked fields of the picked contact reach the agent, cleaned by the gateway")
    func contactFields() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let id = try await chat.raise(gateway, "device.contact", ["fields": ["name", "phones", "birthday"]])
        guard case .contact(let request)? = chat.model.presented?.body else {
          Issue.record("not a contact request")
          return
        }

        #expect(request.fields == [.name, .phones, .birthday])
        let contact = InteractiveContactModel(request: request)
        contact.choose(
          ContactSnapshot(
            name: "Bram de Vries", phones: ["+31 6 12345678", "+31 20 5551234"], emails: ["bram@example.com"],
            postal: ["Keizersgracht 12"], birthday: ContactBirthday(year: nil, month: 2, day: 29), organization: "BV"))
        contact.set(.name, ticked: false)

        #expect(await chat.model.answer(try #require(contact.answer)))

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(
          view["answer"]?["contact"] == ["phones": ["+31 6 12345678", "+31 20 5551234"], "birthday": "--02-29"],
          "no name (unticked), no email, address or company (not asked)")
        #expect(view["refusals"] == [])
        await chat.session.shutdown()
      }
    }

    @Test("a contact with more than the contract allows is cut to its bounds before it goes, and the gateway takes it")
    func contactBounds() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let id = try await chat.raise(gateway, "device.contact", ["fields": ["name", "phones", "emails", "postal", "organization"]])
        guard case .contact(let request)? = chat.model.presented?.body else { return }

        let contact = InteractiveContactModel(request: request)
        contact.choose(
          ContactSnapshot(
            name: String(repeating: "N", count: 250),
            phones: (0..<8).map { "+31 6 0000000\($0)" },
            emails: (0..<7).map { "mail\($0)@example.com" },
            postal: (0..<5).map { "Street \($0)\nTown" },
            organization: String(repeating: "O", count: 300)))
        #expect(await chat.model.answer(try #require(contact.answer)))

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered" && view["refusals"] == [], "\(view)")
        #expect(view["answer"]?["contact"]?["phones"]?.arrayValue?.count == 5)
        #expect(view["answer"]?["contact"]?["emails"]?.arrayValue?.count == 5)
        #expect(view["answer"]?["contact"]?["postal"]?.arrayValue?.count == 3)
        await chat.session.shutdown()
      }
    }

    // MARK: Calendar

    @Test("a saved event is answered done, and the agent is told it was saved, as an event")
    func calendarEvent() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let id = try await chat.raise(
          gateway, "device.calendar",
          [
            "kind": "event",
            "item": [
              "title": "Dentist", "start": "2026-10-12T09:30+02:00", "end": "2026-10-12T10:00+02:00",
              "location": "Tandarts Jansen, Prinsengracht 4", "url": "https://example.com/appointments/4711", "alarm_minutes": 30
            ]
          ])

        guard case .calendar(let request)? = chat.model.presented?.body else {
          Issue.record("not a calendar request")
          return
        }

        #expect(request.kind == .event && request.item.title == "Dentist")
        let store = StubCalendar(.saved)
        let calendar = InteractiveCalendarModel(request: request, store: store, hasEventEditor: true, offersSkip: true)
        #expect(calendar.route == .systemEditor)
        #expect(await calendar.add() == nil && calendar.isEditing)
        let step = try #require(calendar.editorFinished(saved: true))
        #expect(await chat.model.perform(step))
        #expect(store.saved == 0, "the system's sheet saved it, not the app")

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["answer"] == ["status": "done", "saved": true, "kind": "event"])
        await chat.session.shutdown()
      }
    }

    @Test("a reminder is saved by Add, and a cancelled system sheet is a skip")
    func calendarReminderAndCancel() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let reminder = try await chat.raise(
          gateway, "device.calendar",
          ["kind": "reminder", "item": ["title": "Renew passport", "start": "2026-10-09T17:00+02:00", "alarm_minutes": 0]])
        guard case .calendar(let request)? = chat.model.presented?.body else { return }

        let store = StubCalendar(.saved)
        let model = InteractiveCalendarModel(request: request, store: store, hasEventEditor: true, offersSkip: true)
        #expect(model.route == .directSave)
        #expect(await chat.model.perform(try #require(await model.add())))
        #expect(store.saved == 1)
        let view = try await InteractiveChat.view(gateway, reminder)
        #expect(view["answer"] == ["status": "done", "saved": true, "kind": "reminder"])

        let event = try await chat.raise(gateway, "device.calendar", ["kind": "event", "item": ["title": "Lunch"]])
        guard case .calendar(let lunch)? = chat.model.presented?.body else { return }
        let editor = InteractiveCalendarModel(request: lunch, store: store, hasEventEditor: true, offersSkip: true)
        _ = await editor.add()
        #expect(await chat.model.perform(try #require(editor.editorFinished(saved: false))))
        let cancelled = try await InteractiveChat.view(gateway, event)
        #expect(cancelled["answer"] == ["status": "skipped"])
        await chat.session.shutdown()
      }
    }

    @Test("a refused calendar or reminders access is permission_denied, with a notice on the chat")
    func calendarDenied() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let id = try await chat.raise(
          gateway, "device.calendar", ["kind": "reminder", "item": ["title": "Renew passport"]])
        guard case .calendar(let request)? = chat.model.presented?.body else { return }

        let model = InteractiveCalendarModel(request: request, store: StubCalendar(.denied), hasEventEditor: true, offersSkip: true)
        #expect(await chat.model.perform(try #require(await model.add())))

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "unavailable" && view["reason"] == "permission_denied")
        #expect(chat.session.interactive.notices["researcher"]?.notice == .cannotShow(method: "device.calendar", reason: "permission_denied"))
        await chat.session.shutdown()
      }
    }

    // MARK: Who is asked

    @Test("a turn that acts for nobody in a shared conversation is never put to a client")
    func noActingUser() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        await #expect(throws: FakeGatewayError.self) {
          try await gateway.control(
            "POST", "/__fake/request",
            body: .object(["profile": "researcher", "method": "device.contact", "user": .null]))
        }
        #expect(chat.model.openPrompts.isEmpty)
        await chat.session.shutdown()
      }
    }

    // MARK: A frame this build cannot show

    @Test("a frame the gateway never sends is declined with not_supported_on_device, and the agent is told so")
    func unshowableFrame() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway, requests: Self.all)
        let raised = try await gateway.control(
          "POST", "/__fake/request",
          body: .object([
            "profile": "researcher", "method": "device.location", "params": ["precision": "exact"]
          ]))
        let id = try #require(raised["id"]?.stringValue)
        try await interactiveWait("the notice") { chat.session.interactive.notices["researcher"] != nil }

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "unavailable" && view["reason"] == "not_supported_on_device")
        #expect(chat.model.openPrompts.isEmpty)
        await chat.session.shutdown()
      }
    }
  }
}

@MainActor
private final class StubCalendar: DeviceCalendarStore {
  var outcome: CalendarSaveOutcome
  private(set) var saved = 0

  init(_ outcome: CalendarSaveOutcome) {
    self.outcome = outcome
  }

  func save(_ item: CalendarItem, kind: CalendarKind) async -> CalendarSaveOutcome {
    if outcome == .saved {
      saved += 1
    }

    return outcome
  }
}
#endif
