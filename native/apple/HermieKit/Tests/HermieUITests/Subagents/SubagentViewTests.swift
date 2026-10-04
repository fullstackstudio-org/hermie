import HermieCore
import HermieTranscript
import Testing

@testable import HermieUI

@MainActor
@Suite("Agents bar")
struct SubagentViewTests {
  @Test("every status has a word and a symbol of its own")
  func statuses() {
    let all: [Subagent.Status] = [.queued, .running, .completed, .failed, .interrupted]

    #expect(Set(all.map(SubagentText.status)).count == 5)
    #expect(Set(all.map(SubagentText.symbol)).count == 5)
    #expect(all.allSatisfy { !SubagentText.status($0).hasPrefix("chat.") })
  }

  @Test("a status the engine does not know is shown as the gateway wrote it")
  func unknownStatus() {
    #expect(SubagentText.status(.other("paused")) == "paused")
  }

  @Test("each outcome of a Steer or a Stop has a sentence, and a failure carries the gateway's words")
  func notices() {
    let sentences = [
      SubagentText.notice(.steerQueued),
      SubagentText.notice(.steerRejected),
      SubagentText.notice(.stopping),
      SubagentText.notice(.finished)
    ]

    #expect(Set(sentences).count == 4)
    #expect(SubagentText.notice(.failed("socket closed")).contains("socket closed"))
  }

  @Test("the accessibility labels name the agent they are about")
  func labels() {
    #expect(NativeStrings.Subagents.steerFor("Read the repo").contains("Read the repo"))
    #expect(NativeStrings.Subagents.stopFor("Read the repo").contains("Read the repo"))
    #expect(NativeStrings.Subagents.transcriptFor("Read the repo").contains("Read the repo"))
    #expect(NativeStrings.Subagents.level(2).contains("2"))
  }

  @Test(arguments: [
    "native.subagents.barHint", "native.subagents.steerFor", "native.subagents.stopFor",
    "native.subagents.transcriptFor", "native.subagents.send", "native.subagents.finished",
    "native.subagents.failed", "native.subagents.level"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }
}
