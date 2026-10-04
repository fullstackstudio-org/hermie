import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@Suite(.timeLimit(.minutes(1))) struct MemoryTypesTests {
  private static let listBody = """
    {"profile": "researcher",
     "targets": [
       {"target": "memory", "chars": 70, "limit": 2200, "percent": 3,
        "entries": [
          {"id": "memory:0", "target": "memory", "index": 0, "text": "Prefers short answers.", "chars": 22, "topics": []},
          {"target": "memory", "index": 1, "text": "Lives in Utrecht."}]},
       {"target": "user", "chars": 0, "limit": 1375, "percent": 0, "entries": []}],
     "providers": [
       {"name": "builtin", "description": "MEMORY.md and USER.md", "available": true, "enumerable": true},
       {"name": "mem0", "description": "mem0 (cloud)", "available": true, "enumerable": false}]}
    """

  // MARK: The listing

  @Test func aListingNamesBothTargetsInTheirOwnOrderEvenWhenOneIsEmpty() {
    let listing = MemoryListing(jsonValue(Self.listBody))

    #expect(listing.profile == "researcher")
    #expect(listing.sections.map(\.target) == [.memory, .user])
    #expect(listing.section(.user)?.entries.isEmpty == true)
    #expect(listing.section(.memory)?.entries.count == 2)
  }

  @Test func anAbsentTargetIsAnEmptySectionNotAMissingOne() {
    let listing = MemoryListing(jsonValue(#"{"profile": "writer", "targets": []}"#))

    #expect(listing.sections.map(\.target) == [.memory, .user])
    #expect(listing.sections.allSatisfy { $0.entries.isEmpty && $0.chars == 0 })
  }

  @Test func anIdIsTheGatewaysAndOtherwiseTheTargetAndPosition() {
    let memory = MemoryListing(jsonValue(Self.listBody)).section(.memory)

    #expect(memory?.entries.map(\.id) == ["memory:0", "memory:1"])
    #expect(memory?.entries.map(\.index) == [0, 1])
  }

  @Test func charsAreTheGatewaysAndTheTextsOwnLengthOnlyWhereItSentNone() {
    let entries = MemoryListing(jsonValue(Self.listBody)).section(.memory)?.entries

    #expect(entries?[0].chars == 22)
    #expect(entries?[1].chars == "Lives in Utrecht.".count)
  }

  @Test func theUsageIsReadOffTheAnswerNotSummedFromTheEntries() {
    let memory = MemoryListing(jsonValue(Self.listBody)).section(.memory)

    #expect(memory?.chars == 70, "the store counts the delimiter; the entries do not")
    #expect(memory?.limit == 2200)
    #expect(memory?.spokenPercent == 3)
  }

  @Test func noLimitMeansNoBar() {
    let unbounded = MemorySection(target: .user, chars: 120, limit: 0)

    #expect(unbounded.fraction == nil)
    #expect(MemorySection(target: .user, chars: 1100, limit: 1375).fraction == 0.8)
    #expect(MemorySection(target: .user, chars: 9000, limit: 1375).fraction == 1, "a file over its limit is full, not past it")
  }

  @Test func aPercentTheGatewayLeftOutIsWorkedOutFromTheCounts() {
    #expect(MemorySection(target: .memory, chars: 550, limit: 2200, percent: 0).spokenPercent == 25)
  }

  @Test func aRowThatIsNotAnObjectIsReadAsAnEmptyEntryAtItsPlace() {
    let listing = MemoryListing(jsonValue(#"{"targets": [{"target": "memory", "entries": ["oops", {"text": "ok"}]}]}"#))

    #expect(listing.section(.memory)?.entries.map(\.text) == ["", "ok"])
  }

  @Test func anExternalProviderCannotBeOpenedAndSaysSo() {
    let listing = MemoryListing(jsonValue(Self.listBody))

    #expect(listing.providers.map(\.name) == ["builtin", "mem0"])
    #expect(listing.externalProviders.map(\.name) == ["mem0"])
  }

  @Test func aProviderWithoutANameIsDropped() {
    let listing = MemoryListing(jsonValue(#"{"providers": [{"description": "x"}, {"name": "mem0"}]}"#))

    #expect(listing.providers.map(\.name) == ["mem0"])
    #expect(listing.providers.first?.enumerable == false, "an absent flag is not enumerable")
  }

  @Test func anEmptyOrUnreadableBodyIsAnEmptyListing() {
    #expect(MemoryListing(nil).sections.map(\.target) == [.memory, .user])
    #expect(MemoryListing(jsonValue("[]")).providers.isEmpty)
  }

  // MARK: Search, writes, raw

  @Test func aSearchKeepsTheIdsAndTheOrderOfTheResults() {
    let answer = MemorySearchAnswer(
      jsonValue(
        #"{"query": "utrecht", "count": 1, "results": [{"id": "user:2", "target": "user", "index": 2, "text": "Utrecht", "chars": 7}]}"#
      ))

    #expect(answer.query == "utrecht")
    #expect(answer.results.map(\.id) == ["user:2"])
    #expect(answer.results.first?.target == .user)
  }

  @Test func aWriteAnswerIsTheStoresOwnWordsAndNothingAddedToThem() {
    let landed = MemoryWriteAnswer(jsonValue(#"{"success": true}"#))
    let stale = MemoryWriteAnswer(
      jsonValue(#"{"success": false, "error": "no such entry", "current_entries": ["a", "b"]}"#))

    #expect(landed == MemoryWriteAnswer(success: true))
    #expect(stale.success == false)
    #expect(stale.error == "no such entry")
    #expect(stale.currentEntries == ["a", "b"])
  }

  @Test func anAnswerThatIsNotAnObjectIsNotASuccess() {
    #expect(MemoryWriteAnswer(nil).success == false)
    #expect(MemoryWriteAnswer(jsonValue(#"{"success": "yes"}"#)).success == false)
  }

  @Test func theRawSideHoldsEachDocumentAsStoredAndAProviderThatCannotListIsAvailableWithANote() throws {
    let raw = MemoryRaw(
      jsonValue(
        """
        {"profile": "researcher", "backends": [
          {"name": "builtin", "label": "MEMORY.md and USER.md", "available": true, "editable": false,
           "documents": [{"id": "memory", "label": "MEMORY.md", "content": "a\\n§\\nb", "chars": 7, "truncated": false},
                         {"id": "user", "label": "USER.md", "content": "", "chars": 0, "truncated": true}]},
          {"name": "mem0", "label": "mem0 (cloud)", "available": true, "editable": false, "documents": [],
           "note": "mem0 answers a query and offers no call that lists what it holds."}]}
        """))

    #expect(raw.backends.map(\.name) == ["builtin", "mem0"])

    let builtin = try #require(raw.backends.first)

    #expect(builtin.documents.map(\.label) == ["MEMORY.md", "USER.md"])
    #expect(builtin.documents.first?.content == "a\n§\nb")
    #expect(builtin.documents.last?.truncated == true)
    #expect(raw.backends.last?.documents.isEmpty == true)
    #expect(raw.backends.last?.available == true)
    #expect(raw.backends.last?.note?.contains("no call that lists") == true)
  }

  @Test func aBackendTheGatewayDoesNotHaveIsNotAvailable() {
    let raw = MemoryRaw(jsonValue(#"{"backends": [{"name": "honcho", "available": false}]}"#))

    #expect(raw.backends.first?.available == false)
    #expect(raw.backends.first?.label == "honcho", "the name stands in for a missing label")
  }

  // MARK: What the plugin offers

  @Test func theAvailabilityIsWhatTheRostersAdvertSaid() {
    typealias A = MemoryAvailability

    #expect(A.of(capabilities: [], refreshed: false) == .unknown, "nothing is known before the roster is read")
    #expect(A.of(capabilities: ["memory.browse", "memory.edit"], refreshed: false) == .unknown)
    #expect(A.of(capabilities: [], refreshed: true) == .missing)
    #expect(A.of(capabilities: ["memory.edit"], refreshed: true) == .missing, "editing without browsing is no memory page")
    #expect(A.of(capabilities: ["memory.browse"], refreshed: true) == .readOnly)
    #expect(A.of(capabilities: ["memory.browse", "memory.edit"], refreshed: true) == .editable)
    #expect(A.readOnly.canRead && !A.readOnly.canWrite)
    #expect(A.editable.canRead && A.editable.canWrite)
    #expect(!A.missing.canRead && !A.unknown.canRead)
  }
}
