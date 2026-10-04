import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

@Suite struct SessionSearchRequestTests {
  @Test func theRequestNamesTheWordsTheCeilingAndTheProfile() {
    #expect(
      SessionSearch.path(query: "invoice", profile: "researcher", limit: 5)
        == "/api/sessions/search?q=invoice&limit=5&profile=researcher")
  }

  @Test func aBlankQueryNeverLeavesTheDevice() {
    #expect(SessionSearch.path(query: "", profile: "a", limit: 5) == nil)
    #expect(SessionSearch.path(query: " \n\t\u{00A0} ", profile: "a", limit: 5) == nil)
  }

  @Test func theLimitIsClampedToWhatTheGatewayAccepts() {
    #expect(SessionSearch.path(query: "x", profile: nil, limit: 0) == "/api/sessions/search?q=x&limit=1")
    #expect(SessionSearch.path(query: "x", profile: nil, limit: 5_000) == "/api/sessions/search?q=x&limit=100")
    #expect(SessionSearch.path(query: "x", profile: nil, limit: nil) == "/api/sessions/search?q=x&limit=20")
  }

  @Test func theWordsAreEncodedSoQuotesStarsAndSpacesArriveAsTyped() {
    #expect(
      SessionSearch.path(query: "  \"due date\" inv*  ", profile: "a b", limit: 5)
        == "/api/sessions/search?q=%22due%20date%22%20inv%2A&limit=5&profile=a%20b")
    #expect(SessionSearch.path(query: "café & ☕", profile: nil, limit: 5)?.contains("q=caf%C3%A9%20%26%20%E2%98%95") == true)
    // Nothing that ends the query string early can be smuggled in by what was typed.
    let path = SessionSearch.path(query: "a&profile=other#frag?x=1", profile: "ada", limit: 5)
    #expect(path == "/api/sessions/search?q=a%26profile%3Dother%23frag%3Fx%3D1&limit=5&profile=ada")
  }

  @Test func anEmptyProfileIsLeftOut() {
    #expect(SessionSearch.path(query: "x", profile: "", limit: 5) == "/api/sessions/search?q=x&limit=5")
  }
}

@Suite struct SessionSearchBodyTests {
  @Test func aBodyWithoutResultsIsNoHits() {
    #expect(SessionSearch.parse(nil).isEmpty)
    #expect(SessionSearch.parse(.object(["detail": "Search failed"])).isEmpty)
    #expect(SessionSearch.parse(.object(["results": "no"])).isEmpty)
    #expect(SessionSearch.parse(.array([])).isEmpty)
  }

  @Test func aRowThatNamesNoSessionIsDroppedAndTheRestKeepTheirOrder() {
    let body: JSONValue = [
      "results": [
        ["snippet": "orphan"],
        ["session_id": "s1", "snippet": "kept"],
        .null,
        ["id": "s2", "snippet": "by id", "last_active": 12.5, "role": "user"],
      ]
    ]

    let hits = SessionSearch.parse(body)

    #expect(hits.map(\.sessionID) == ["s1", "s2"])
    #expect(hits[1].at == 12.5)
    #expect(hits[1].role == "user")
  }
}

@Suite struct SessionSearchSnippetTests {
  @Test func aMatchIsTheRunBetweenTheMarkers() {
    #expect(
      SessionSearch.snippetSegments("the >>>invoice<<< service") == [
        .init(text: "the ", match: false), .init(text: "invoice", match: true), .init(text: " service", match: false),
      ])
  }

  @Test func aLoneMarkerIsTextNotTheStartOfAHighlight() {
    #expect(SessionSearch.snippetSegments("cat a >>> b") == [.init(text: "cat a >>> b", match: false)])
  }
}
