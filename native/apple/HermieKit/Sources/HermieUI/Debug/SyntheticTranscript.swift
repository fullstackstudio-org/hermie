#if DEBUG
  import HermieProtocol
  import HermieTranscript

  /// A deterministic, made-up transcript with every item kind in it, for the
  /// transcript lab, the gallery, previews and the UI tests. The same seed
  /// always gives the same items, so a measurement can be repeated.
  public struct SyntheticTranscript: Sendable {
    private var random: SplitMix64
    private var serial = 0

    public init(seed: UInt64 = 0x4865_726D_6965) {
      random = SplitMix64(seed: seed)
    }

    /// A chat with `count` mixed items, the newest last.
    public mutating func chat(count: Int) -> ChatState {
      var state = createChatState("lab", "lab-session", "lab-session")
      let items = (0..<count).map { index in item(seq: index * seqStep) }
      for item in items {
        state.items[item.id] = item
        state.order.append(item.id)
      }
      return state
    }

    /// `count` items older than everything in `state`, put in front of it.
    public mutating func prepend(_ count: Int, to state: inout ChatState) {
      let first = state.order.first.flatMap { state.items[$0]?.seq } ?? 0
      let items = (0..<count).map { index in item(seq: first - (count - index) * seqStep) }
      for item in items {
        state.items[item.id] = item
      }
      state.order.insert(contentsOf: items.map(\.id), at: 0)
    }

    /// Appends a user turn and an empty, streaming reply; returns the reply's id.
    public mutating func beginReply(in state: inout ChatState) -> String {
      let seq = (state.order.last.flatMap { state.items[$0]?.seq } ?? 0) + seqStep
      let user = TranscriptItem.user(UserItem(base: base(seq: seq, prefix: "u"), text: sentence(words: 12)))
      let reply = TranscriptItem.assistant(
        AssistantItem(base: base(seq: seq + 1, prefix: "a"), text: "", streaming: true, interim: false))
      for item in [user, reply] {
        state.items[item.id] = item
        state.order.append(item.id)
      }
      state.turn.active = true
      state.turn.assistantID = reply.id
      return reply.id
    }

    /// The next streamed chunk: a few words, now and then a line break, a list
    /// item or a code fence, so the Markdown tail re-parses the way a real
    /// reply's does.
    public mutating func delta() -> String {
      switch random.next(upTo: 40) {
      case 0: return "\n\n"
      case 1: return "\n- "
      case 2: return "\n\n```swift\nlet x = \(random.next(upTo: 100))\n```\n\n"
      case 3: return " **\(word())**"
      default: return " " + (0..<(1 + random.next(upTo: 3))).map { _ in word() }.joined(separator: " ")
      }
    }

    // MARK: - Items

    mutating func item(seq: Int) -> TranscriptItem {
      let roll = random.next(upTo: 1000)
      switch roll {
      case 0..<240: return user(seq: seq)
      case 240..<560: return assistant(seq: seq)
      case 560..<800: return tool(seq: seq)
      case 800..<830: return status(seq: seq)
      case 830..<880: return notice(seq: seq)
      case 880..<930: return botDm(seq: seq)
      case 930..<950: return cron(seq: seq)
      case 950..<970: return subagents(seq: seq)
      case 970..<982: return approval(seq: seq, state: .answered)
      case 982..<994: return clarify(seq: seq, state: .answered)
      default: return .unknown(UnknownItem(kindName: "poll", base: base(seq: seq, prefix: "x")))
      }
    }

    mutating func user(seq: Int, author: MessageAuthor? = nil) -> TranscriptItem {
      let authors: [MessageAuthor?] = [nil, nil, nil, MessageAuthor(id: "telegram:42", name: "Robin"), MessageAuthor(id: "telegram:7", name: "Sam")]
      let attachments: [String]? = random.next(upTo: 8) == 0 ? ["@file:/tmp/report-q3.pdf", "@image:/tmp/diagram.png"] : nil
      return .user(
        UserItem(
          base: base(seq: seq, prefix: "u"),
          text: sentence(words: 4 + random.next(upTo: 30)),
          attachments: attachments,
          author: author ?? authors[random.next(upTo: authors.count)]
        ))
    }

    mutating func assistant(seq: Int) -> TranscriptItem {
      let paragraphs = 1 + random.next(upTo: 4)
      var text = ""
      for index in 0..<paragraphs {
        if index > 0 { text += "\n\n" }
        switch random.next(upTo: 6) {
        case 0: text += "## \(sentence(words: 4))"
        case 1: text += (0..<3).map { _ in "- \(sentence(words: 6))" }.joined(separator: "\n")
        case 2: text += "```python\nfor i in range(\(random.next(upTo: 10))):\n    print(i)\n```"
        default: text += sentence(words: 20 + random.next(upTo: 50))
        }
      }
      var usage = Usage(json: [:])
      usage.model = "anthropic/claude-sonnet-4"
      usage.input = 1000 + random.next(upTo: 9000)
      usage.output = 100 + random.next(upTo: 900)
      return .assistant(
        AssistantItem(
          base: base(seq: seq, prefix: "a"),
          text: text,
          reasoning: random.next(upTo: 4) == 0 ? sentence(words: 40) : nil,
          streaming: false,
          interim: random.next(upTo: 20) == 0,
          status: .complete,
          usage: usage,
          durationS: Double(random.next(upTo: 300)) / 10
        ))
    }

    mutating func tool(seq: Int, status: ToolStatus = .complete) -> TranscriptItem {
      let names = ["terminal", "read_file", "patch", "web_search", "browser_navigate", "mcp__github__list_issues", "execute_code"]
      let name = names[random.next(upTo: names.count)]
      let failed = random.next(upTo: 15) == 0
      return .tool(
        ToolItem(
          base: base(seq: seq, prefix: "t"),
          toolID: "call_\(serial)",
          name: name,
          context: "ls -la ~/projects/\(word())",
          args: ["command": .string("ls -la ~/projects/\(word())"), "timeout": .number(30)],
          status: failed ? .error : status,
          resultKnown: status == .complete,
          result: .object(["output": .string(sentence(words: 30))]),
          inlineDiff: name == "patch" ? "--- a/x.swift\n+++ b/x.swift\n-let a = 1\n+let a = 2\n context" : nil,
          durationS: Double(random.next(upTo: 900)) / 10,
          isError: failed ? true : nil
        ))
    }

    mutating func status(seq: Int) -> TranscriptItem {
      .status(StatusItem(base: base(seq: seq, prefix: "s"), statusKind: "context.compaction", text: "Compacting the context…"))
    }

    mutating func notice(seq: Int, kind: NoticeKind? = nil) -> TranscriptItem {
      let kinds: [NoticeKind] = [.command, .modelSwitch, .processComplete, .systemNote, .error, .reclaimed, .asyncDelegationComplete]
      let chosen = kind ?? kinds[random.next(upTo: kinds.count)]
      let completions: [ProcessCompletionBlock]? =
        chosen == .processComplete
        ? [ProcessCompletionBlock(sid: "p1", command: "npm test", output: "All 214 tests passed.")] : nil
      return .notice(
        NoticeItem(
          base: base(seq: seq, prefix: "n"),
          noticeKind: chosen,
          title: noticeTitle(chosen),
          body: chosen == .processComplete ? nil : sentence(words: 18),
          completions: completions
        ))
    }

    mutating func botDm(seq: Int, outbound: Bool? = nil) -> TranscriptItem {
      if outbound ?? (random.next(upTo: 2) == 0) {
        let replied = random.next(upTo: 2) == 0
        return .botDmOut(
          BotDmOutItem(
            base: base(seq: seq, prefix: "o"),
            toolID: "call_\(serial)",
            target: "Writer",
            targetHandle: "writer",
            message: sentence(words: 24),
            dispatch: BotDmDispatch(status: .queued),
            reply: replied ? BotDmReply(text: sentence(words: 16)) : nil
          ))
      }
      return .botDmIn(
        BotDmInItem(
          base: base(seq: seq, prefix: "i"),
          senderName: "Researcher",
          senderHandle: "researcher",
          text: sentence(words: 30),
          answersOurDispatch: true
        ))
    }

    mutating func cron(seq: Int, redacted: Bool = false) -> TranscriptItem {
      .cronDelivery(
        CronDeliveryItem(
          base: base(seq: seq, prefix: "c"),
          jobName: "Morning briefing",
          nameRedacted: redacted ? true : nil,
          body: "## Today\n\n- \(sentence(words: 8))\n- \(sentence(words: 10))",
          shape: .mirror
        ))
    }

    mutating func subagents(seq: Int, status: SubagentGroupStatus = .done) -> TranscriptItem {
      .subagentGroup(
        SubagentGroupItem(
          base: base(seq: seq, prefix: "g"),
          delegationID: "d\(serial)",
          goals: ["Find the three cheapest flights", "Summarise the reviews of each hotel", "Draft the itinerary"],
          rootIDs: ["c1", "c2", "c3"],
          status: status,
          completion: status == .done ? sentence(words: 20) : nil
        ))
    }

    mutating func approval(seq: Int, state: RequestState, answer: String? = "once") -> TranscriptItem {
      .approval(
        ApprovalItem(
          base: base(seq: seq, prefix: "p"),
          requestID: "srq-\(serial)",
          approvalID: "ap-\(serial)",
          command: "rm -rf ~/projects/scratch/build",
          description: "Cleans the build folder before a fresh build.",
          toolName: "terminal",
          choices: ["once", "session", "always", "deny"],
          state: state,
          answer: state == .answered ? answer : nil
        ))
    }

    mutating func clarify(seq: Int, state: RequestState) -> TranscriptItem {
      .clarify(
        ClarifyItem(
          base: base(seq: seq, prefix: "q"),
          requestID: "srq-\(serial)",
          questions: [
            ClarifyQuestionItem(qid: "q1", question: "Which city should I search from?", choices: ["Amsterdam", "Rotterdam", "Eindhoven"], multiSelect: false),
            ClarifyQuestionItem(qid: "q2", question: "Which extras matter?", choices: ["Luggage", "Seat", "Insurance"], multiSelect: true),
            ClarifyQuestionItem(qid: "q3", question: "Anything else I should know?", multiSelect: false)
          ],
          batch: true,
          answers: state == .answered ? ["q1": "Amsterdam", "q2": "Luggage"] : [:],
          locked: [],
          state: state
        ))
    }

    // MARK: - Words

    private mutating func base(seq: Int, prefix: String) -> ItemBase {
      serial += 1
      return ItemBase(id: "\(prefix)\(serial)", seq: seq, ts: 1_780_000_000 + Double(seq / 10), origin: .history, version: 1)
    }

    private func noticeTitle(_ kind: NoticeKind) -> String {
      switch kind {
      case .command: "/status"
      case .modelSwitch: "Model switched"
      case .processComplete: "Background process finished"
      case .systemNote: "System note"
      case .error: "The gateway reported an error"
      case .reclaimed: "Context reclaimed"
      case .asyncDelegationComplete: "Delegation finished"
      default: "Notice"
      }
    }

    private static let words = [
      "gateway", "the", "a", "build", "streams", "reply", "quietly", "and", "of", "bot", "transcript", "scroll", "list",
      "markdown", "token", "is", "on", "with", "approval", "native", "frame", "glass", "row", "agent", "tool", "fast",
      "every", "delta", "settled", "tail", "parse", "in", "for", "to", "reader", "chat", "hitch", "budget"
    ]

    private mutating func word() -> String {
      Self.words[random.next(upTo: Self.words.count)]
    }

    private mutating func sentence(words count: Int) -> String {
      var parts: [String] = []
      parts.reserveCapacity(count)
      for _ in 0..<max(1, count) { parts.append(word()) }
      let text = parts.joined(separator: " ")
      return text.prefix(1).uppercased() + text.dropFirst() + "."
    }
  }

  /// A small, fast, seedable generator, so a synthetic transcript is the same
  /// on every run.
  struct SplitMix64: Sendable {
    private var state: UInt64

    init(seed: UInt64) {
      state = seed
    }

    mutating func next() -> UInt64 {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }

    mutating func next(upTo bound: Int) -> Int {
      Int(next() % UInt64(max(1, bound)))
    }
  }
#endif
