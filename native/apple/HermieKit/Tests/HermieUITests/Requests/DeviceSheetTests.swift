import Foundation
import HermieCore
import HermieProtocol
import HermieTranscript
import SwiftUI
import Testing

@testable import HermieUI

/// The parts of the device sheets (`device.location`, `device.contact`, `device.calendar`) that are
/// plain functions: the words for what is asked and shared, the rows of a contact's preview, how a
/// calendar item reads, and what the transcript's card and the chat's notice say.
@MainActor
@Suite("Device sheets")
struct DeviceSheetTests {
  private func item(
    _ method: String, state: RequestState, summary: RequestAnswerSummary? = nil, cancel: String? = nil
  ) -> RequestItem {
    RequestItem(
      base: ItemBase(id: "i1", seq: 0, ts: 1_790_000_000, origin: .live, version: 1), requestID: "srq-1", method: method,
      title: "Share", summary: "s", optional: true, state: state, answerSummary: summary, cancelReason: cancel)
  }

  // MARK: The card

  @Test("the card names the kind and icon of each device request, and says how it ended by the summary's keys alone")
  func cardWords() {
    typealias Card = InteractiveRequestCardView

    #expect(Card.kind(of: item("device.location", state: .open)) == "Location")
    #expect(Card.kind(of: item("device.contact", state: .open)) == "Contact")
    #expect(Card.kind(of: item("device.calendar", state: .open)) == "Calendar")
    #expect(Card.icon(of: item("device.location", state: .open)) == "location")
    #expect(Card.icon(of: item("device.contact", state: .open)) == "person.crop.circle")
    #expect(Card.icon(of: item("device.calendar", state: .open)) == "calendar")
    #expect(Card.icon(of: item("device.calendar", state: .cancelled)) == "xmark.circle")

    #expect(Card.state(of: item("device.location", state: .open)) == "Waiting for your answer")
    #expect(
      Card.state(of: item("device.location", state: .answered, summary: RequestAnswerSummary(status: "answered", precision: "approximate")))
        == "Shared approximate location")
    #expect(
      Card.state(of: item("device.location", state: .answered, summary: RequestAnswerSummary(status: "answered", precision: "precise")))
        == "Shared precise location")
    let both = Card.state(of: item("device.contact", state: .answered, summary: RequestAnswerSummary(status: "answered", fields: ["name", "phones"])))
    #expect(both.hasPrefix("Shared contact: ") && both.contains("Name") && both.contains("Phone numbers"), "\(both)")
    #expect(
      Card.state(of: item("device.contact", state: .answered, summary: RequestAnswerSummary(status: "answered", fields: ["name"])))
        == "Shared contact: Name")
    #expect(
      Card.state(of: item("device.contact", state: .answered, summary: RequestAnswerSummary(status: "answered")))
        == "Shared a contact")
    #expect(
      Card.state(of: item("device.calendar", state: .answered, summary: RequestAnswerSummary(status: "answered")))
        == "Added to calendar")

    for method in ["device.location", "device.contact", "device.calendar"] {
      #expect(Card.state(of: item(method, state: .answered, summary: RequestAnswerSummary(status: "skipped"))) == "Skipped", "\(method)")
      #expect(Card.state(of: item(method, state: .cancelled, cancel: "timeout")) == "Timed out", "\(method)")
      #expect(Card.state(of: item(method, state: .cancelled, cancel: "cannot_show")) == "Ended without an answer", "\(method)")
    }
  }

  @Test("the card draws for every device request in every state, at the default text size and at AX5")
  func cardRenders() throws {
    for method in ["device.location", "device.contact", "device.calendar"] {
      let states: [RequestItem] = [
        item(method, state: .open),
        item(method, state: .answered, summary: RequestAnswerSummary(status: "answered", precision: "precise", fields: ["name"])),
        item(method, state: .answered, summary: RequestAnswerSummary(status: "skipped")),
        item(method, state: .cancelled, cancel: "timeout")
      ]

      for size in [DynamicTypeSize.large, .accessibility5] {
        for state in states {
          let renderer = ImageRenderer(
            content: InteractiveRequestCardView(item: state, presentation: .full).frame(width: 390).dynamicTypeSize(size))
          renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
          let image = try #require(renderer.cgImage, "\(method) did not render")
          #expect(image.height > 0)
        }
      }
    }
  }

  // MARK: Notices

  @Test("a refused permission and a missing position have their own words on the chat; anything else keeps the general line")
  func noticeWords() {
    #expect(
      InteractiveNoticeView.text(.cannotShow(method: "device.location", reason: "permission_denied"), bot: "ada")
        == "Hermie is not allowed to do that on this device, so it told ada it could not. You can change this in your device’s settings.")
    #expect(
      InteractiveNoticeView.text(.cannotShow(method: "device.location", reason: "location_unavailable"), bot: "ada")
        == "Hermie could not find your location and told ada so.")
    #expect(
      InteractiveNoticeView.text(.cannotShow(method: "device.contact", reason: "not_supported_on_device"), bot: "ada")
        == "Hermie could not show a request from ada and told it so.")
    #expect(!InteractiveNoticeView.icon(.cannotShow(method: "device.location", reason: "permission_denied")).isEmpty)
  }

  // MARK: Words

  @Test("each precision, contact field and title has English words, and none is a key")
  func words() {
    typealias Words = NativeStrings.Interactive

    #expect(Words.Location.shares(.precise) == "Your precise location" && Words.Location.shares(.approximate) == "Your approximate location")
    #expect(Words.Location.detail(.precise) != Words.Location.detail(.approximate))
    #expect(Words.Location.share == "Share location" && Words.Location.locating == "Finding your location…")
    #expect(Words.Location.lowerNote == "You can share less than was asked, never more.")

    for field in ContactField.knownCases {
      let word = Words.Contact.field(field)
      #expect(!word.isEmpty && !word.hasPrefix("native."), "\(field)")
    }

    #expect(Words.Contact.field(.phones) == "Phone numbers" && Words.Contact.field(.unknown("nickname")) == "nickname")
    #expect(Words.Contact.chosen("Bram") == "Chosen: Bram")
    #expect(Words.titleLocation("ada") == "ada asks for your location")
    #expect(Words.titleContact("ada") == "ada asks you to share a contact")
    #expect(Words.titleCalendarEvent("ada") == "ada suggests an event for your calendar")
    #expect(Words.titleCalendarReminder("ada") == "ada suggests a reminder")
    #expect(Words.Calendar.addEvent == "Add to calendar" && Words.Calendar.addReminder == "Add reminder")
    #expect(Words.Calendar.alertBefore("30 minutes") == "30 minutes before")
    #expect(Words.cannotShowNotice(reason: "no_camera", bot: "ada") == nil)
  }

  /// One call of every accessor of the device strings: the table's test counts them against the keys.
  static var accessors: [String] {
    typealias I = NativeStrings.Interactive
    let titles = [
      I.titleLocation("A"), I.titleContact("A"), I.titleCalendarEvent("A"), I.titleCalendarReminder("A"),
      I.permissionDenied("A"), I.locationUnavailable("A")
    ]
    let location = [
      I.Location.heading, I.Location.approximate, I.Location.approximateDetail, I.Location.precise,
      I.Location.preciseDetail, I.Location.precisionLabel, I.Location.optionPrecise, I.Location.optionApproximate,
      I.Location.lowerNote, I.Location.oneFix, I.Location.permissionNote, I.Location.share, I.Location.locating,
      I.Location.shareHint
    ]
    let contact = [
      I.Contact.choose, I.Contact.chooseAnother, I.Contact.pickerNote, I.Contact.chosen("A"), I.Contact.unnamed,
      I.Contact.fieldsHeading, I.Contact.notOnContact, I.Contact.previewHeading, I.Contact.nothingTicked,
      I.Contact.share
    ] + ContactField.knownCases.map(I.Contact.field)
    let calendar = [
      I.Calendar.kindEvent, I.Calendar.kindReminder, I.Calendar.when, I.Calendar.where, I.Calendar.link,
      I.Calendar.notes, I.Calendar.alert, I.Calendar.allDay, I.Calendar.noTimeEvent, I.Calendar.noTimeReminder,
      I.Calendar.alertAtStart, I.Calendar.alertBefore("A"), I.Calendar.addEvent, I.Calendar.addReminder,
      I.Calendar.noteEditor, I.Calendar.noteDirectEvent, I.Calendar.noteReminder, I.Calendar.saving,
      I.Calendar.failed, I.Calendar.notSaved, I.Calendar.savedNotSent
    ]
    let cards = [
      I.Card.location, I.Card.contact, I.Card.calendar, I.Card.sharedApproximate, I.Card.sharedPrecise,
      I.Card.sharedContactBare, I.Card.addedToCalendar, I.Card.sharedContact("A")
    ]
    return titles + location + contact + calendar + cards
  }

  // MARK: The contact preview

  @Test("the preview holds the rows of what is shared, in the contract's order, and nothing else")
  func previewRows() {
    let shared = SharedContact(
      snapshot: ContactSnapshot(
        name: "Bram", phones: ["1", "2"], emails: ["b@example.com"], postal: ["Street 1\nTown"],
        birthday: ContactBirthday(year: nil, month: 2, day: 29), organization: "BV"),
      ticked: [.organization, .phones, .name, .birthday], requested: ContactField.knownCases)
    #expect(
      ContactSheetView.rows(of: shared) == [
        .init(field: .name, values: ["Bram"]), .init(field: .phones, values: ["1", "2"]),
        .init(field: .birthday, values: ["--02-29"]), .init(field: .organization, values: ["BV"])
      ])
    #expect(ContactSheetView.rows(of: SharedContact(snapshot: ContactSnapshot(), ticked: [], requested: [])).isEmpty)
  }

  // MARK: The calendar item

  @Test("an alert reads as a time before the start, and a start as the day or the day and time")
  func calendarWords() {
    let english = Locale(identifier: "en_US")
    #expect(CalendarSheetView.alertText(CalendarItem(title: "T"), locale: english) == nil)
    #expect(CalendarSheetView.alertText(CalendarItem(title: "T", alarmMinutes: 0), locale: english) == "At the time")
    #expect(CalendarSheetView.alertText(CalendarItem(title: "T", alarmMinutes: 30), locale: english) == "30 minutes before")
    #expect(CalendarSheetView.alertText(CalendarItem(title: "T", alarmMinutes: 90), locale: english) == "1 hour, 30 minutes before")
    #expect(CalendarSheetView.alertText(CalendarItem(title: "T", alarmMinutes: 1_440), locale: english) == "1 day before")
    #expect(CalendarSheetView.alertText(CalendarItem(title: "T", alarmMinutes: 40_320), locale: english) == "28 days before")

    #expect(CalendarSheetView.whenText(CalendarItem(title: "T"), kind: .event) == "No time given: it will start at the next full hour.")
    #expect(CalendarSheetView.whenText(CalendarItem(title: "T"), kind: .reminder) == "No time given.")

    let day = CalendarSheetView.whenText(
      CalendarItem(title: "T", allDay: true, start: .day(CalendarDay(year: 2026, month: 11, day: 14))), kind: .event)
    #expect(day.contains("2026") && day.hasSuffix("All day"), "\(day)")
    let range = CalendarSheetView.whenText(
      CalendarItem(
        title: "T", allDay: true, start: .day(CalendarDay(year: 2026, month: 11, day: 14)),
        end: .day(CalendarDay(year: 2026, month: 11, day: 16))),
      kind: .event)
    #expect(range.contains("14") && range.contains("16") && range.hasSuffix("All day"), "\(range)")

    let start = CalendarInstant(day: CalendarDay(year: 2026, month: 10, day: 12), hour: 9, minute: 30, offsetSeconds: 7_200)
    let end = CalendarInstant(day: CalendarDay(year: 2026, month: 10, day: 12), hour: 10, minute: 0, offsetSeconds: 7_200)
    let timed = CalendarSheetView.whenText(CalendarItem(title: "T", start: .instant(start), end: .instant(end)), kind: .event)
    #expect(timed.contains(" – ") && timed.contains("2026"), "\(timed)")
    #expect(!CalendarSheetView.whenText(CalendarItem(title: "T", start: .instant(start)), kind: .reminder).contains(" – "))
  }
}
