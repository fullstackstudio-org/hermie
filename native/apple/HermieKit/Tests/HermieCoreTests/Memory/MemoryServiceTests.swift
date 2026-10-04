import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@Suite(.timeLimit(.minutes(1))) struct MemoryServiceTests {
  private let rest = StubREST()
  private var service: MemoryService { MemoryService(rest: rest) }

  @Test func everyReadNamesItsProfile() async throws {
    rest.answer("GET", "/api/plugins/hermie/memory/list?profile=researcher", with: jsonValue(#"{"targets": []}"#))
    rest.answer("GET", "/api/plugins/hermie/memory/raw?profile=researcher", with: jsonValue(#"{"backends": []}"#))

    _ = try await service.list(profile: "researcher")
    _ = try await service.raw(profile: "researcher")

    #expect(
      rest.calls.map(\.path) == [
        "/api/plugins/hermie/memory/list?profile=researcher",
        "/api/plugins/hermie/memory/raw?profile=researcher"
      ])
  }

  @Test func aProfileAndAQueryAreEncodedAsOneComponentEach() async throws {
    let query = "a&b=c +d"
    let path = service.path("search", [("profile", "my bot"), ("q", query)])

    #expect(path == "/api/plugins/hermie/memory/search?profile=my%20bot&q=a%26b%3Dc%20%2Bd")

    rest.answer("GET", path, with: jsonValue(#"{"query": "x", "results": []}"#))
    let answer = try await service.search(profile: "my bot", query: query)

    #expect(answer.results.isEmpty)
  }

  @Test func anAddPostsTheTargetTheOpAndTheContent() async throws {
    rest.answer("POST", "/api/plugins/hermie/memory/edit", with: jsonValue(#"{"success": true}"#))

    let answer = try await service.write(
      profile: "researcher", operation: .add, target: .user, content: "Likes tea.", entry: nil)

    #expect(answer.success)

    let body = try #require(rest.calls.first?.body)

    #expect(body["profile"] == "researcher")
    #expect(body["target"] == "user")
    #expect(body["op"] == "add")
    #expect(body["content"] == "Likes tea.")
    #expect(body["old_text"] == nil)
  }

  @Test func aReplaceAndARemoveSendTheEntrysTextAsWellAsItsPlace() async throws {
    rest.answer("POST", "/api/plugins/hermie/memory/edit", with: jsonValue(#"{"success": true}"#))
    let entry = MemoryEntry(target: .memory, index: 3, text: "Lives in Utrecht.")

    _ = try await service.write(
      profile: "researcher", operation: .replace, target: .memory, content: "Delft.", entry: entry)
    _ = try await service.write(
      profile: "researcher", operation: .remove, target: .memory, content: nil, entry: entry)

    let replace = try #require(rest.calls.first?.body)
    let remove = try #require(rest.calls.last?.body)

    #expect(replace["op"] == "replace")
    #expect(replace["old_text"] == "Lives in Utrecht.")
    #expect(replace["index"] == 3)
    #expect(replace["content"] == "Delft.")
    #expect(remove["op"] == "remove")
    #expect(remove["content"] == nil)
    #expect(remove["old_text"] == "Lives in Utrecht.")
  }

  @Test func aRefusalPropagatesWithItsStatusForThePageToTellApart() async {
    rest.refuse(
      "GET", "/api/plugins/hermie/memory/list?profile=researcher",
      with: GatewayError(.protocol, "no endpoint", status: 404))

    let error = await #expect(throws: GatewayError.self) {
      try await service.list(profile: "researcher")
    }

    #expect(error?.status == 404)
    #expect(error.map { CapabilityText.isMissingRoute($0) } == true)
  }
}
