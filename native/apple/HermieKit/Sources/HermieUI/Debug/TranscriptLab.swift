#if DEBUG
  import HermieTranscript
  import SwiftUI

  /// The transcript list spike, as a debug screen: a 2,000-item synthetic
  /// transcript in `TranscriptList`, a reply streaming into it at 30 deltas a
  /// second, history prepends, a render-count test, a hitch meter and the
  /// memory footprint. The numbers in docs/native.md ("Transcript list") were
  /// measured here, by hand and by the UI tests.
  ///
  /// Launch arguments (also read by the UI tests):
  /// `-HermieLabItems <n>` (default 2000), `-HermieLabStream YES` to start
  /// streaming at once.
  public struct TranscriptLabView: View {
    @State private var model = TranscriptLabModel()
    @State private var expansion = TranscriptExpansion()

    public init() {}

    public var body: some View {
      TranscriptList(model.rows, state: model.listState) { row in
        TranscriptItemView(row: row)
          .padding(.horizontal, 16)
      } overlay: { state in
        JumpToLatestPill(state: state, newCount: model.newCount)
      }
      .environment(\.transcriptExpansion, expansion)
      .environment(\.transcriptOwnAuthorID, "telegram:1")
      .safeAreaInset(edge: .top, spacing: 0) { controls }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        // `-HermieLabBottomInset YES`: a bar under the list, where the chat screen's composer goes.
        if UserDefaults.standard.bool(forKey: "HermieLabBottomInset") {
          Text("Composer")
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(.bar)
            .accessibilityIdentifier("lab.bottomInset")
        }
      }
      .task { await model.load() }
      .onChange(of: model.listState.isAtBottom) { _, atBottom in
        if atBottom { model.newCount = 0 }
      }
      .navigationTitle("Transcript lab")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
    }

    private var controls: some View {
      VStack(alignment: .leading, spacing: 6) {
        Grid(horizontalSpacing: 8, verticalSpacing: 6) {
          GridRow {
            Button(model.isStreaming ? "Stop" : "Stream") { model.toggleStreaming() }
              .accessibilityIdentifier("lab.stream")
            Button("Prepend") { Task { await model.prepend() } }
              .accessibilityIdentifier("lab.prepend")
            Button("Middle") { model.scrollToMiddle() }
              .accessibilityIdentifier("lab.middle")
          }
          GridRow {
            Button(model.meterRunning ? "Stop meter" : "Meter") { model.toggleMeter() }
              .accessibilityIdentifier("lab.meter")
            Button(model.autoScrolling ? "Stop scroll" : "Auto-scroll") { model.toggleAutoScroll() }
              .accessibilityIdentifier("lab.autoScroll")
            Button("Render test") { Task { await model.runRenderTest() } }
              .accessibilityIdentifier("lab.renderTest")
              .disabled(model.isStreaming)
          }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.horizontal, 16)
        // A fixed three lines: a report that wrapped differently would change
        // the inset above the list and move every row, which is exactly what
        // the prepend test measures (it read 13 pt before this was fixed).
        Text(model.report)
          .font(.caption2.monospaced())
          .lineLimit(3, reservesSpace: true)
          .foregroundStyle(.primary)
          .padding(.horizontal, 16)
          .accessibilityIdentifier("lab.report")
      }
      .padding(.vertical, 8)
      .background(.bar)
    }
  }

  /// The lab's state. Every mutation of the transcript happens in
  /// `TranscriptLabDriver`, off the main actor; this model only receives the
  /// finished rows, which is the shape the real transcript store has (D10).
  @MainActor
  @Observable
  final class TranscriptLabModel {
    var rows = TranscriptListItems<TranscriptRow>()
    var isStreaming = false
    var meterRunning = false
    var autoScrolling = false
    var newCount = 0
    var report = "Loading…"

    @ObservationIgnored let listState = TranscriptListState()
    @ObservationIgnored private let driver = TranscriptLabDriver()
    @ObservationIgnored private let meter = HitchMeter()
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var scrollTask: Task<Void, Never>?
    @ObservationIgnored private var baseline: UInt64 = 0
    @ObservationIgnored private var deltas = 0

    func load() async {
      guard rows.isEmpty else { return }
      let requested = UserDefaults.standard.integer(forKey: "HermieLabItems")
      let count = requested > 0 ? requested : 2000
      baseline = MemoryFootprint.current()
      let started = ContinuousClock.now
      rows = await driver.load(count: count)
      let built = ContinuousClock.now - started
      // Let the list lay out its first screen before reading the footprint.
      try? await Task.sleep(for: .milliseconds(500))
      let footprint = MemoryFootprint.current()
      report =
        "\(rows.count) rows · built off-main in \(built.formatted(.units(allowed: [.milliseconds]))) · "
        + "footprint \(MemoryFootprint.megabytes(footprint)) (+\(MemoryFootprint.megabytes(footprint &- baseline)))"
      benchLog("loaded: \(report)")
      listState.onNearTop = { [weak self] in
        guard let self, UserDefaults.standard.bool(forKey: "HermieLabAutoPrepend") else { return }
        Task { await self.prepend() }
      }
      if UserDefaults.standard.bool(forKey: "HermieLabStream") {
        toggleStreaming()
      }
      if UserDefaults.standard.bool(forKey: "HermieLabAutoScroll") {
        toggleAutoScroll()
      }
      if UserDefaults.standard.bool(forKey: "HermieLabBench") {
        await runBench()
      }
    }

    /// A hands-off measurement, for runs without a UI test driving the screen
    /// (the Mac, where XCUITest would take over the pointer): the hitch meter
    /// over an idle list as a control for the machine's own load, then while a
    /// reply streams, while the list scrolls, and both at once. Prints one line
    /// per phase to stdout and puts the summary in the report.
    func runBench() async {
      let seconds = max(5, UserDefaults.standard.integer(forKey: "HermieLabBenchSeconds"))
      var lines: [String] = []
      func phase(_ name: String, stream: Bool, scroll: Bool) async {
        if stream && !isStreaming { toggleStreaming() }
        if scroll && !autoScrolling { toggleAutoScroll() }
        try? await Task.sleep(for: .seconds(1))
        meter.start()
        try? await Task.sleep(for: .seconds(seconds))
        meter.stop()
        if isStreaming { toggleStreaming() }
        if autoScrolling { toggleAutoScroll() }
        let line = "\(name): \(meter.summary) · footprint \(MemoryFootprint.megabytes(MemoryFootprint.current()))"
        benchLog("\(line)")
        lines.append(line)
        listState.scrollToBottom(animated: false)
        try? await Task.sleep(for: .seconds(1))
      }
      benchLog("\(rows.count) rows, \(seconds) s per phase")
      await phase("idle", stream: false, scroll: false)
      await phase("stream", stream: true, scroll: false)
      await phase("pan", stream: false, scroll: true)
      await phase("stream+pan", stream: true, scroll: true)
      let footprint = "footprint \(MemoryFootprint.megabytes(MemoryFootprint.current())) with \(rows.count) rows"
      benchLog("\(footprint)")
      lines.append(footprint)
      report = "bench · " + lines.joined(separator: " | ")
      if UserDefaults.standard.bool(forKey: "HermieLabBenchQuit") {
        exit(0)
      }
    }

    /// One line to stderr, unbuffered, so a run that is stopped keeps what it
    /// printed.
    private func benchLog(_ line: String) {
      FileHandle.standardError.write(Data("[transcript-bench] \(line)\n".utf8))
    }

    func toggleStreaming() {
      if isStreaming {
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
        return
      }
      isStreaming = true
      streamTask = Task {
        rows = await driver.beginReply()
        await stream(deltas: .max)
      }
    }

    /// Applies deltas at 30 a second until cancelled or `deltas` are done.
    private func stream(deltas limit: Int) async {
      let clock = ContinuousClock()
      var deadline = clock.now
      var sent = 0
      while !Task.isCancelled && sent < limit {
        deadline += .microseconds(33_333)
        try? await clock.sleep(until: deadline)
        let next = await driver.delta()
        if !listState.isAtBottom && next.count > rows.count { newCount += next.count - rows.count }
        rows = next
        sent += 1
        deltas += 1
      }
    }

    func prepend() async {
      rows = await driver.prepend(count: 200)
      report = "\(rows.count) rows after prepend · top \(String(describing: listState.topVisibleID?.base ?? "-"))"
    }

    func scrollToMiddle() {
      guard !rows.isEmpty else { return }
      let anchor: UnitPoint =
        switch UserDefaults.standard.string(forKey: "HermieLabMiddleAnchor") {
        case "top": .top
        case "bottom": .bottom
        default: .center
        }
      listState.scroll(to: rows[rows.count / 2].id, anchor: anchor, animated: false)
    }

    func toggleMeter() {
      if meterRunning {
        meter.stop()
        meterRunning = false
        report = "hitch \(meter.summary) · footprint \(MemoryFootprint.megabytes(MemoryFootprint.current()))"
      } else {
        meter.start()
        meterRunning = true
        report = "measuring…"
      }
    }

    /// Pans the list up and down at a reader's pace — 1,500 pt/s for 1.5 s
    /// each way, in small steps, as a trackpad would — for a hands-off hitch
    /// measurement (on the Mac, without driving the pointer). Rows come into
    /// view one at a time, as they do under a finger.
    func toggleAutoScroll() {
      if autoScrolling {
        scrollTask?.cancel()
        autoScrolling = false
        return
      }
      autoScrolling = true
      scrollTask = Task {
        let clock = ContinuousClock()
        let step = Duration.milliseconds(8)
        var direction: CGFloat = -1
        while !Task.isCancelled {
          let leg = clock.now + .milliseconds(1500)
          var last = clock.now
          while !Task.isCancelled && clock.now < leg {
            try? await clock.sleep(for: step)
            let now = clock.now
            let elapsed = now - last
            last = now
            let seconds = CGFloat(elapsed.components.seconds) + CGFloat(elapsed.components.attoseconds) / 1e18
            listState.pan(by: direction * 1500 * seconds)
          }
          direction.negate()
        }
      }
    }

    /// (c) of the spike: 600 deltas while nobody scrolls, then how many rows
    /// other than the streaming one were evaluated again.
    func runRenderTest() async {
      report = "render test: starting…"
      rows = await driver.beginReply()
      listState.scrollToBottom(animated: false)
      try? await Task.sleep(for: .seconds(1))
      let streamingID = await driver.streamingID ?? ""
      let before = RenderCounter.counts
      isStreaming = true
      await stream(deltas: 600)
      isStreaming = false
      let after = RenderCounter.counts
      var untouched = 0
      var rerendered = 0
      var extraBodies = 0
      for (id, count) in before where id != streamingID {
        untouched += 1
        let now = after[id] ?? count
        if now != count {
          rerendered += 1
          extraBodies += now - count
        }
      }
      let streamingBodies = (after[streamingID] ?? 0) - (before[streamingID] ?? 0)
      report =
        "render test: 600 deltas · streaming row bodies \(streamingBodies) · rows on screen before \(untouched) · "
        + "re-rendered \(rerendered) (\(extraBodies) extra bodies)"
    }
  }

  /// Owns the synthetic `ChatState` and turns it into rows, off the main actor:
  /// the stand-in for the transcript store until the reducer lands.
  actor TranscriptLabDriver {
    private var generator = SyntheticTranscript()
    private var state = createChatState("lab", "lab-session", "lab-session")
    private var builder = TranscriptRowBuilder(sharedChat: true)
    private var options = VisibilityOptions(level: .normal, showBotToBot: true, showThinking: true)
    private(set) var streamingID: String?

    func load(count: Int) -> TranscriptListItems<TranscriptRow> {
      state = generator.chat(count: count)
      return rows()
    }

    func beginReply() -> TranscriptListItems<TranscriptRow> {
      if let streamingID {
        state.items[streamingID]?.updateAssistant {
          $0.streaming = false
          $0.version += 1
        }
      }
      streamingID = generator.beginReply(in: &state)
      return rows()
    }

    func delta() -> TranscriptListItems<TranscriptRow> {
      guard let streamingID else { return rows() }
      let chunk = generator.delta()
      state.items[streamingID]?.updateAssistant {
        $0.text += chunk
        $0.version += 1
      }
      return rows()
    }

    func prepend(count: Int) -> TranscriptListItems<TranscriptRow> {
      generator.prepend(count, to: &state)
      return rows()
    }

    private func rows() -> TranscriptListItems<TranscriptRow> {
      TranscriptListItems(builder.rows(for: visibleItems(state, options)))
    }
  }
#endif
