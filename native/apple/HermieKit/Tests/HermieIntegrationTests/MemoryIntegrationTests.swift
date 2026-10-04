#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

extension Integration {
  /// The Memory page's model against the real fake gateway, over real HTTP: the two files of a bot, a
  /// search, the raw side, every kind of write, and the three gateways the page has to cope with (one
  /// that writes, one that only reads, one with no plugin).
  @Suite("Memory") @MainActor
  struct MemoryIntegrationTests {
    private func withModel(
      _ options: FakeGateway.Options = FakeGateway.Options(),
      profile: String = "researcher",
      _ body: @escaping @MainActor @Sendable (GatewaySession, MemoryModel) async throws -> Void
    ) async throws {
      try await withCapabilitySession(options) { session, _ in
        let model = try #require(session.memory(for: profile))
        await model.load()

        try await body(session, model)
      }
    }

    @Test("the roster's advert says memory can be browsed and edited")
    func theAdvertSaysSo() async throws {
      try await withCapabilitySession { session, _ in
        #expect(session.memoryAvailability == .editable)
      }
    }

    @Test("both files are listed with what they cost and the providers the gateway has")
    func listsBothFiles() async throws {
      try await withModel { _, model in
        #expect(model.phase == .ready)

        let memory = try #require(model.listing?.section(.memory))
        let user = try #require(model.listing?.section(.user))

        #expect(memory.entries.count == 3)
        #expect(memory.entries.map(\.id) == ["memory:0", "memory:1", "memory:2"])
        #expect(memory.limit == 2200)
        #expect(memory.chars > memory.entries.map(\.chars).reduce(0, +), "the store counts the delimiters too")
        #expect(user.entries.count == 2)
        #expect(model.listing?.externalProviders.map(\.name) == ["mem0"])
      }
    }

    @Test("a bot with nothing in USER.md still has the section")
    func anEmptyFileIsStillThere() async throws {
      try await withModel(profile: "writer") { _, model in
        #expect(model.listing?.sections.map(\.target) == [.memory, .user])
        #expect(model.listing?.section(.user)?.entries.isEmpty == true)
      }
    }

    @Test("a search finds entries across both files, every word having to appear")
    func searches() async throws {
      try await withModel { _, model in
        await model.search("lisbon")

        guard case .results(let answer) = model.search else {
          Issue.record("expected results, got \(model.search)")
          return
        }

        #expect(answer.results.map(\.target) == [.user])

        await model.search("nonexistent words")
        #expect(model.search == .results(MemorySearchAnswer(query: "nonexistent words", results: [])))

        await model.search("")
        #expect(model.search == .idle)
      }
    }

    @Test("the raw side holds each file as stored and says a provider cannot list")
    func raw() async throws {
      try await withModel { _, model in
        await model.loadRaw()

        guard case .loaded(let raw) = model.raw else {
          Issue.record("expected the raw side, got \(model.raw)")
          return
        }

        #expect(raw.backends.map(\.name) == ["builtin", "mem0"])
        #expect(raw.backends.first?.documents.map(\.label) == ["MEMORY.md", "USER.md"])
        #expect(raw.backends.first?.documents.first?.content.contains("\n§\n") == true)
        #expect(raw.backends.last?.documents.isEmpty == true)
        #expect(raw.backends.last?.note != nil)
      }
    }

    @Test("an entry is added, replaced by its text and removed, the listing read again after each")
    func writes() async throws {
      try await withModel { _, model in
        #expect(await model.add(.user, content: "Likes tea."))
        #expect(model.listing?.section(.user)?.entries.map(\.text).last == "Likes tea.")
        #expect(model.listing?.section(.user)?.entries.count == 3)

        let entry = try #require(model.listing?.section(.user)?.entries.last)

        #expect(await model.replace(entry, with: "Likes green tea."))
        #expect(model.listing?.section(.user)?.entries.map(\.text).last == "Likes green tea.")

        let replaced = try #require(model.listing?.section(.user)?.entries.last)

        #expect(await model.remove(replaced))
        #expect(model.listing?.section(.user)?.entries.count == 2)
        #expect(model.notice == nil)
      }
    }

    @Test("an entry that has moved is refused in the store's words, and the page reads the file again")
    func aStaleEntryIsRefused() async throws {
      try await withModel { _, model in
        let stale = MemoryEntry(target: .memory, index: 0, text: "An entry nobody wrote.")

        #expect(await model.remove(stale) == false)
        #expect(model.notice == .words("no such entry; list the target again and retry"))
        #expect(model.listing?.section(.memory)?.entries.count == 3)
      }
    }

    @Test("a write over the file's limit is refused in the store's words")
    func overTheLimit() async throws {
      try await withModel { _, model in
        let long = String(repeating: "x", count: 3000)

        #expect(await model.add(.memory, content: long) == false)
        #expect(model.notice == .words("that would exceed the character limit for this file"))
      }
    }

    @Test("a gateway that lets memory be read and not written is read-only: nothing is sent")
    func readOnly() async throws {
      try await withModel(FakeGateway.Options(extraArguments: ["--no-memory-edit"])) { session, model in
        #expect(session.memoryAvailability == .readOnly)
        #expect(model.phase == .ready, "reading still works")

        model.setAvailability(session.memoryAvailability)
        #expect(model.canWrite == false)
        #expect(await model.add(.memory, content: "x") == false)
        #expect(model.listing?.section(.memory)?.entries.count == 3)
      }
    }

    @Test("a write the gateway refuses with 403 is told as editing being switched off")
    func forbiddenWrite() async throws {
      try await withModel(FakeGateway.Options(extraArguments: ["--no-memory-edit"])) { _, model in
        // Forced past the page's own guard, as a stale page would: what the gateway says is shown.
        model.setAvailability(.editable)

        #expect(await model.add(.memory, content: "x") == false)
        #expect(model.notice == .editSwitchedOff)
      }
    }

    @Test("a gateway with no Hermie plugin has no memory page: missing, not an error")
    func noPlugin() async throws {
      try await withCapabilitySession(FakeGateway.Options(plugin: false)) { session, _ in
        #expect(session.memoryAvailability == .missing)

        let model = try #require(session.memory(for: "researcher"))
        await model.load()

        #expect(model.phase == .missing)
      }
    }
  }
}
#endif
