import Foundation
import HermieProtocol
import Observation

// `device.contact` (contract/requests/README.md §10): one contact the person picks with the
// system's own picker, reduced to the fields the agent asked for and the person leaves ticked.
//
// Nothing of the address book is read by this app beyond the one contact the person picked, and of
// that one only what the sheet shows as ticked: the picker runs in its own process and hands over
// the chosen contact alone, so no Contacts permission is asked.

/// A `device.contact` request, read strictly (`DeviceContactRequest.read`).
public struct DeviceContactRequest: Sendable, Equatable {
  /// The fields asked for: 1 to 6 of the contract's names, each once, in the order they were asked.
  public var fields: [ContactField]

  /// `nil` for a list that is empty, holds more than six, repeats a name or holds one this build does
  /// not know (the gateway never sends it).
  public static func read(_ params: DeviceContactParams) -> DeviceContactRequest? {
    guard case .array(let raw)? = params.json["fields"], (1...6).contains(raw.count) else {
      return nil
    }

    var seen = Set<ContactField>()
    var fields: [ContactField] = []

    for value in raw {
      guard let name = value.stringValue, case let field = ContactField.named(name),
        ContactField.knownCases.contains(field), seen.insert(field).inserted
      else {
        return nil
      }

      fields.append(field)
    }

    return DeviceContactRequest(fields: fields)
  }
}

/// A birthday as the address book keeps it: the year may be missing.
public struct ContactBirthday: Sendable, Equatable {
  public var year: Int?
  public var month: Int
  public var day: Int

  public init(year: Int? = nil, month: Int, day: Int) {
    self.year = year
    self.month = month
    self.day = day
  }

  /// `YYYY-MM-DD`, or `--MM-DD` without a year; `nil` for a day that does not exist (`--02-29` does).
  public var text: String? {
    guard (1...12).contains(month), day >= 1 else {
      return nil
    }

    guard let year else {
      // Without a year any day a leap year has is a day.
      return day <= CalendarDay.daysIn(month: month, year: 2_000) ? String(format: "--%02d-%02d", month, day) : nil
    }

    guard (1...9_999).contains(year), day <= CalendarDay.daysIn(month: month, year: year) else {
      return nil
    }

    return String(format: "%04d-%02d-%02d", year, month, day)
  }
}

/// What the system picker handed over: one contact, as plain values. Held only while the sheet is up.
public struct ContactSnapshot: Sendable, Equatable {
  public var name: String?
  public var phones: [String]
  public var emails: [String]
  /// One formatted address per entry, line breaks between its lines.
  public var postal: [String]
  public var birthday: ContactBirthday?
  public var organization: String?

  public init(
    name: String? = nil, phones: [String] = [], emails: [String] = [], postal: [String] = [],
    birthday: ContactBirthday? = nil, organization: String? = nil
  ) {
    self.name = name
    self.phones = phones
    self.emails = emails
    self.postal = postal
    self.birthday = birthday
    self.organization = organization
  }
}

/// What the person shares of the contact: only the ticked fields, cut to the contract's bounds and
/// cleaned the way the sheet previews it, so what they saw is what goes.
public struct SharedContact: Sendable, Equatable {
  public var name: String?
  public var phones: [String]
  public var emails: [String]
  public var postal: [String]
  public var birthday: String?
  public var organization: String?

  static let nameLimit = 200
  static let phoneLimit = 40
  static let phoneCount = 5
  static let emailLimit = 254
  static let emailCount = 5
  static let postalLimit = 300
  static let postalCount = 3
  static let organizationLimit = 200

  /// The fields of `snapshot` that are ticked and asked for, and have something to share.
  public init(snapshot: ContactSnapshot, ticked: Set<ContactField>, requested: [ContactField]) {
    let take = { (field: ContactField) in ticked.contains(field) && requested.contains(field) }

    name = take(.name) ? Self.text(snapshot.name, limit: Self.nameLimit) : nil
    phones = take(.phones) ? Self.entries(snapshot.phones, limit: Self.phoneLimit, count: Self.phoneCount) : []
    emails = take(.emails) ? Self.entries(snapshot.emails, limit: Self.emailLimit, count: Self.emailCount) : []
    postal = take(.postal) ? Self.addresses(snapshot.postal) : []
    birthday = take(.birthday) ? snapshot.birthday?.text : nil
    organization = take(.organization) ? Self.text(snapshot.organization, limit: Self.organizationLimit) : nil
  }

  /// Which fields carry something, in the contract's order.
  public var fields: [ContactField] {
    ContactField.knownCases.filter { has($0) }
  }

  public func has(_ field: ContactField) -> Bool {
    switch field {
    case .name: name != nil
    case .phones: !phones.isEmpty
    case .emails: !emails.isEmpty
    case .postal: !postal.isEmpty
    case .birthday: birthday != nil
    case .organization: organization != nil
    case .unknown: false
    }
  }

  public var isEmpty: Bool {
    fields.isEmpty
  }

  /// The `contact` object of the answer: only the keys that carry something.
  public var card: ContactCard {
    var card = ContactCard()
    card.name = name
    card.phones = phones.isEmpty ? nil : phones
    card.emails = emails.isEmpty ? nil : emails
    card.postal = postal.isEmpty ? nil : postal
    card.birthday = birthday
    card.organization = organization
    return card
  }

  /// Whether the contract lets this answer `request`: a key the request did not list is refused by
  /// the gateway whatever its value, and a contact with nothing in it is not an answer.
  func isValid(for request: DeviceContactRequest) -> Bool {
    !isEmpty && fields.allSatisfy(request.fields.contains)
  }

  // MARK: Cleaning

  /// `raw` as one cleaned string of at most `limit` code points (the contract's bound, ellipsis
  /// included), or nil when nothing is left.
  static func text(_ raw: String?, limit: Int) -> String? {
    var cleaned = SecurePrompt.displayText(raw, limit: limit)

    // `displayText` bounds the text and then adds its ellipsis: one more than `limit` when it cut.
    if cleaned.unicodeScalars.count > limit {
      var view = String.UnicodeScalarView()
      view.append(contentsOf: cleaned.unicodeScalars.prefix(limit - 1))
      cleaned = String(view) + "\u{2026}"
    }

    return cleaned.isEmpty ? nil : cleaned
  }

  /// The entries that fit `limit` as they are (a phone number cut short is a different number, so
  /// one that is too long is left out, not cut), cleaned, without repeats, the first `count`.
  static func entries(_ raw: [String], limit: Int, count: Int) -> [String] {
    var seen = Set<String>()
    var out: [String] = []

    for entry in raw {
      let cleaned = SecurePrompt.displayText(entry, limit: limit + 1).replacingOccurrences(of: "\n", with: " ")

      guard !cleaned.isEmpty, cleaned.unicodeScalars.count <= limit, seen.insert(cleaned).inserted else {
        continue
      }

      out.append(cleaned)

      if out.count == count {
        break
      }
    }

    return out
  }

  /// Addresses keep their line breaks; one longer than the bound is cut at it.
  static func addresses(_ raw: [String]) -> [String] {
    var seen = Set<String>()
    var out: [String] = []

    for entry in raw {
      guard let cleaned = text(entry, limit: postalLimit), seen.insert(cleaned).inserted else {
        continue
      }

      out.append(cleaned)

      if out.count == postalCount {
        break
      }
    }

    return out
  }
}

/// The state of one `device.contact` sheet: the picked contact, the boxes, and what the answer holds.
@MainActor
@Observable
public final class InteractiveContactModel {
  public let request: DeviceContactRequest

  /// The picked contact, kept until the request ends (`wipe()`).
  public private(set) var snapshot: ContactSnapshot?
  /// The requested fields the person has ticked.
  public private(set) var ticked: Set<ContactField> = []

  public init(request: DeviceContactRequest) {
    self.request = request
  }

  /// The person picked this contact: every requested field it has something for starts ticked.
  public func choose(_ snapshot: ContactSnapshot) {
    self.snapshot = snapshot
    ticked = Set(request.fields.filter { shareable($0, in: snapshot) })
  }

  /// Pick another contact.
  public func reset() {
    wipe()
  }

  /// Forget the contact: the sheet goes, or the request ended.
  public func wipe() {
    snapshot = nil
    ticked = []
  }

  public var hasChosen: Bool {
    snapshot != nil
  }

  /// Whether the picked contact has something to share for `field`.
  public func isAvailable(_ field: ContactField) -> Bool {
    snapshot.map { shareable(field, in: $0) } ?? false
  }

  public func isTicked(_ field: ContactField) -> Bool {
    ticked.contains(field)
  }

  /// Tick or untick a requested field the contact has something for.
  public func set(_ field: ContactField, ticked on: Bool) {
    guard request.fields.contains(field), isAvailable(field) else {
      return
    }

    if on {
      ticked.insert(field)
    } else {
      ticked.remove(field)
    }
  }

  /// Exactly what the answer would hold now.
  public var shared: SharedContact? {
    snapshot.map { SharedContact(snapshot: $0, ticked: ticked, requested: request.fields) }
  }

  /// There is something ticked to share.
  public var canShare: Bool {
    shared.map { !$0.isEmpty } ?? false
  }

  /// The answer to send, or nil while nothing is ticked.
  public var answer: InteractiveAnswer? {
    guard let shared, !shared.isEmpty else {
      return nil
    }

    return .contact(shared)
  }

  private func shareable(_ field: ContactField, in snapshot: ContactSnapshot) -> Bool {
    SharedContact(snapshot: snapshot, ticked: [field], requested: [field]).has(field)
  }
}

#if canImport(Contacts)
  import Contacts

  extension ContactSnapshot {
    /// The one contact the system picker handed over, as plain values: its name (shown, so the person
    /// sees whom they picked, and shared only when asked for and ticked) and only the `requested`
    /// fields beside it. A field nobody asked for is not even copied out of the system's object. A
    /// property the picker did not include is left empty rather than read (reading an unfetched
    /// property raises).
    public init(_ contact: CNContact, requested: [ContactField] = ContactField.knownCases) {
      func available(_ key: String) -> Bool { contact.isKeyAvailable(key) }
      func wants(_ field: ContactField) -> Bool { requested.contains(field) }

      // Everything the formatter reads for a full name (prefix, middle name, suffix and the rest), not two of
      // its keys: formatting a contact that lacks one of them raises.
      let name: String? =
        contact.areKeysAvailable([CNContactFormatter.descriptorForRequiredKeys(for: .fullName)])
        ? CNContactFormatter.string(from: contact, style: .fullName) : nil
      var birthday: ContactBirthday?

      if wants(.birthday), available(CNContactBirthdayKey), let parts = contact.birthday, let month = parts.month,
        let day = parts.day
      {
        // The address book's own sentinel for "no year" is 1604.
        let year = parts.year.flatMap { $0 == 1_604 ? nil : $0 }
        birthday = ContactBirthday(year: year, month: month, day: day)
      }

      self.init(
        name: name,
        phones: wants(.phones) && available(CNContactPhoneNumbersKey) ? contact.phoneNumbers.map(\.value.stringValue) : [],
        emails: wants(.emails) && available(CNContactEmailAddressesKey)
          ? contact.emailAddresses.map { $0.value as String } : [],
        postal: wants(.postal) && available(CNContactPostalAddressesKey)
          ? contact.postalAddresses.map { CNPostalAddressFormatter.string(from: $0.value, style: .mailingAddress) } : [],
        birthday: birthday,
        organization: wants(.organization) && available(CNContactOrganizationNameKey) ? contact.organizationName : nil
      )
    }
  }
#endif
