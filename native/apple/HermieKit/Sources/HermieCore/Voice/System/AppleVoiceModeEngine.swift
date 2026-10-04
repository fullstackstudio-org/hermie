import AVFoundation
import Foundation
import Speech
import Synchronization

/**
 Where voice mode's spoken audio comes from: something that turns a request into PCM buffers, which the
 call's engine plays through its own output, so the echo canceller hears it and the orb's meter
 measures it. The device's voices (`AppleSpeechRenderer`) are one source; a text-to-speech that streams
 audio from elsewhere fits behind the same seam, and the read queue, the call and the meter do not
 change for it.
 */
@MainActor
public protocol VoiceSpeechRenderer: AnyObject {
  /// Render `request`. Each buffer is handed to `deliver` as it is ready, on any thread, and nil once
  /// at the end (after a failure too: to a queue, an end is an end). What is delivered after `cancel()`
  /// is dropped by the caller.
  func render(
    _ request: ReadRequest, rate: Double, voice: String?, deliver: @escaping @Sendable (AVAudioPCMBuffer?) -> Void)
  /// Stop rendering what is in progress.
  func cancel()
  /// The voices this source can speak in.
  func voices() -> [SpeechVoice]
}

/// The device's own voices, rendered to buffers with `AVSpeechSynthesizer.write` instead of played by
/// the synthesiser. On the device: nothing is sent anywhere. Used from the main actor only.
@MainActor
public final class AppleSpeechRenderer: VoiceSpeechRenderer {
  private let synthesizer = AVSpeechSynthesizer()

  public init() {}

  public func render(
    _ request: ReadRequest, rate: Double, voice: String?, deliver: @escaping @Sendable (AVAudioPCMBuffer?) -> Void
  ) {
    synthesizer.stopSpeaking(at: .immediate)

    let utterance = AVSpeechUtterance(string: request.text)
    utterance.rate = AppleSpeechSynthesizer.engineRate(forMultiplier: rate)
    utterance.voice = AppleSpeechSynthesizer.voice(named: voice, language: request.language)
    utterance.pitchMultiplier = Float(request.pitch)

    synthesizer.write(utterance, toBufferCallback: Self.callback(deliver))
  }

  public func cancel() {
    synthesizer.stopSpeaking(at: .immediate)
  }

  public func voices() -> [SpeechVoice] {
    AppleSpeechSynthesizer.installedVoices()
  }

  /// The write callback, on the synthesiser's queue: a buffer with no frames is the end.
  private nonisolated static func callback(
    _ deliver: @escaping @Sendable (AVAudioPCMBuffer?) -> Void
  ) -> AVSpeechSynthesizer.BufferCallback {
    { buffer in
      guard let pcm = buffer as? AVAudioPCMBuffer else {
        return
      }

      deliver(pcm.frameLength > 0 ? pcm : nil)
    }
  }
}

/**
 Voice mode's audio: one `AVAudioEngine` for the whole call, listening and speaking at once.

 **Why one engine.** Cutting in on a reply means listening while the device speaks, and the microphone
 then hears the speaker. Apple's voice processing (`setVoiceProcessingEnabled` on the input node, the
 same unit as the output) cancels that echo, but only for audio played through the same engine. So
 replies are not played by `AVSpeechSynthesizer` itself: they are rendered to buffers
 (`VoiceSpeechRenderer`) and played on a player node of this engine. Where voice processing cannot be
 turned on, `cancelsEcho` is false and the call does not listen while it speaks.

 **The session.** On iOS the call holds `.playAndRecord` in `.voiceChat` mode (echo cancellation,
 Bluetooth headsets, the speaker rather than the earpiece) from start to end, and the reader's other
 voice features leave it alone meanwhile (`SpeechAudioSession.heldByCall`). The Mac has no session.

 **The audio thread.** The microphone's tap runs on a real-time thread: it is built in a nonisolated
 function, measures the level into a lock-free meter, and appends the buffer to the recognition request
 in hand (one short lock). The recogniser and the renderer report on queues of their own; only plain
 values reach the main actor.

 **On the device.** Recognition is `requiresOnDeviceRecognition` and a language without an on-device
 model is refused (ADR-0022). Nothing is recorded to a file.
 */
@MainActor
public final class AppleVoiceModeEngine: VoiceModeSpeaking, VoiceModeAudio {
  public let meters = VoiceMeters()
  public var onEvent: (@MainActor (VoiceAudioEvent) -> Void)?
  public private(set) var cancelsEcho = false
  /// A new call's engines: one engine, speaking and listening. The recogniser's side is an object of
  /// its own (`Listener`): a recogniser's `stop` (finish listening) and a synthesiser's (silence) are
  /// different things.
  public static func call(renderer: any VoiceSpeechRenderer = AppleSpeechRenderer()) -> VoiceModeEngines {
    let engine = AppleVoiceModeEngine(renderer: renderer)
    return VoiceModeEngines(recogniser: Listener(engine: engine), speaker: engine, audio: engine)
  }

  /// `VoiceModeRecognising` over the call's engine. It holds the engine: the call keeps the listener,
  /// the speaker and the audio, and they are one object underneath.
  @MainActor
  public final class Listener: VoiceModeRecognising {
    private let engine: AppleVoiceModeEngine

    init(engine: AppleVoiceModeEngine) {
      self.engine = engine
    }

    public var cancelsEcho: Bool { engine.cancelsEcho }
    public var isAvailable: Bool { engine.support.isAvailable }
    public func requestPermission() async -> RecognitionPermission { await engine.support.requestPermission() }
    public func processing(language: String?) -> RecognitionProcessing { engine.support.processing(language: language) }
    public func supportedLanguages() -> [String] { engine.support.supportedLanguages() }
    public func start(language: String?, events: DictationEvents) {
      engine.startRecognition(language: language, events: events)
    }
    public func stop() { engine.endRecognition() }
    public func abort() { engine.abortRecognition() }
  }

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let renderer: any VoiceSpeechRenderer
  /// What the device knows about recognition (languages, permission): dictation's own.
  private let support = AppleSpeechRecognizer()
  private let slot = RequestSlot()
  private let playback: Playback
  private var running = false
  private var observers: [any NSObjectProtocol] = []

  // Recognition.
  private var task: SFSpeechRecognitionTask?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var events: DictationEvents?
  private var session = 0
  private var finishTimer: Task<Void, Never>?
  private static let finishGrace: Duration = .seconds(2)

  // Speech.
  private var speechToken = 0
  private var speechDone: (@MainActor @Sendable () -> Void)?

  /// The format replies are played in: the renderer's buffers are converted to it.
  private static let playFormat = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!

  public init(renderer: any VoiceSpeechRenderer = AppleSpeechRenderer()) {
    self.renderer = renderer
    playback = Playback(player: player, format: Self.playFormat)
  }

  // MARK: VoiceModeAudio

  public func activate() throws {
    guard !running else {
      return
    }

    #if os(iOS)
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
      try audioSession.setActive(true)
    #endif
    SpeechAudioSession.heldByCall = true

    do {
      try startEngine()
    } catch {
      teardown()
      throw error
    }

    observe()
  }

  public func reactivate() throws {
    #if os(iOS)
      try AVAudioSession.sharedInstance().setActive(true)
    #endif

    if !engine.isRunning {
      try engine.start()
    }
  }

  public func deactivate() {
    teardown()
  }

  private func startEngine() throws {
    let input = engine.inputNode

    // Echo cancellation, where the hardware has it. Before anything is connected: it reconfigures
    // the input and the output together.
    do {
      try input.setVoiceProcessingEnabled(true)
      cancelsEcho = input.isVoiceProcessingEnabled
    } catch {
      cancelsEcho = false
    }

    let format = input.outputFormat(forBus: 0)

    // No microphone, or one that is not producing audio (a Mac with no input).
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw VoiceEngineError.noInput
    }

    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: Self.playFormat)

    input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.inputTap(slot: slot, meter: meters.input))
    let mixer = engine.mainMixerNode
    mixer.installTap(onBus: 0, bufferSize: 1024, format: mixer.outputFormat(forBus: 0), block: Self.outputTap(meter: meters.output))
    // From here the teardown has taps and a player to take away, whether or not the start succeeds.
    running = true

    engine.prepare()
    try engine.start()
  }

  private func teardown() {
    abortRecognition()
    stopSpeech()

    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }

    observers = []

    if running {
      engine.inputNode.removeTap(onBus: 0)
      engine.mainMixerNode.removeTap(onBus: 0)
      engine.stop()
      engine.disconnectNodeOutput(player)
      engine.detach(player)
      running = false
    }

    if cancelsEcho {
      try? engine.inputNode.setVoiceProcessingEnabled(false)
      cancelsEcho = false
    }

    meters.input.reset()
    meters.output.reset()
    SpeechAudioSession.heldByCall = false

    #if os(iOS)
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    #endif
  }

  // MARK: What happens to the audio

  private func observe() {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main,
        using: Self.observer(for: self) { _ in .routeChanged }))

    #if os(iOS)
      observers.append(
        center.addObserver(
          forName: AVAudioSession.interruptionNotification, object: nil, queue: .main,
          using: Self.observer(for: self, Self.interruption)))
      observers.append(
        center.addObserver(
          forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main,
          using: Self.observer(for: self) { _ in .failed }))
    #endif
  }

  #if os(iOS)
    private nonisolated static func interruption(_ info: [AnyHashable: Any]?) -> VoiceAudioEvent? {
      guard let raw = info?[AVAudioSessionInterruptionTypeKey] as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: raw)
      else {
        return nil
      }

      switch type {
      case .began:
        return .interruptionBegan
      case .ended:
        let options = (info?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init)
        return .interruptionEnded(shouldResume: options?.contains(.shouldResume) ?? false)
      @unknown default:
        return nil
      }
    }
  #endif

  /// A notification's handler: the event is read where it is posted, and only the event crosses.
  private nonisolated static func observer(
    for engine: AppleVoiceModeEngine, _ event: @escaping @Sendable ([AnyHashable: Any]?) -> VoiceAudioEvent?
  ) -> @Sendable (Notification) -> Void {
    { [weak engine] notification in
      guard let event = event(notification.userInfo) else {
        return
      }

      Task { @MainActor in engine?.handle(event) }
    }
  }

  private func handle(_ event: VoiceAudioEvent) {
    guard running else {
      return
    }

    switch event {
    case .routeChanged:
      // The engine stops itself on a configuration change; it is started again on the new route.
      if !engine.isRunning {
        do {
          try engine.start()
        } catch {
          onEvent?(.failed)
          return
        }
      }

      onEvent?(.routeChanged)
    default:
      onEvent?(event)
    }
  }

  // MARK: Recognition

  /// The device can speak: always.
  public var isAvailable: Bool { true }

  func startRecognition(language: String?, events: DictationEvents) {
    abortRecognition()
    session += 1
    let current = session

    guard running, let recogniser = AppleSpeechRecognizer.recogniser(for: language), recogniser.isAvailable,
      recogniser.supportsOnDeviceRecognition
    else {
      events.onError(running ? .unavailable : .failed)
      events.onEnd()
      return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    request.addsPunctuation = true
    // Always: the request fails rather than reaching Apple's service.
    request.requiresOnDeviceRecognition = true

    self.request = request
    self.events = events
    slot.set(request)
    task = recogniser.recognitionTask(with: request, resultHandler: Self.handler(for: self, session: current))
  }

  /// Stop listening and ask for the final result (a recogniser `stop`).
  func endRecognition() {
    guard let request else {
      return
    }

    slot.set(nil)
    request.endAudio()

    let current = session
    finishTimer?.cancel()
    finishTimer = Task { [weak self] in
      try? await Task.sleep(for: Self.finishGrace)

      if !Task.isCancelled {
        self?.finish(current)
      }
    }
  }

  func abortRecognition() {
    session += 1
    slot.set(nil)
    finishTimer?.cancel()
    finishTimer = nil
    task?.cancel()
    task = nil
    request = nil
    events = nil
  }

  private func report(_ words: String?, final: Bool, failure: RecognitionFailure?, session reported: Int) {
    guard reported == session, let events else {
      return
    }

    if let words {
      if final {
        events.onFinal(words)
      } else {
        events.onPartial(words)
      }
    }

    if let failure {
      events.onError(failure)
    }

    if final || failure != nil {
      finish(reported)
    }
  }

  private func finish(_ reported: Int) {
    guard reported == session, let events else {
      return
    }

    session += 1
    slot.set(nil)
    finishTimer?.cancel()
    finishTimer = nil
    task?.cancel()
    task = nil
    request = nil
    self.events = nil
    events.onEnd()
  }

  private nonisolated static func handler(
    for engine: AppleVoiceModeEngine, session: Int
  ) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
    { [weak engine] result, error in
      let words = result?.bestTranscription.formattedString
      let final = result?.isFinal ?? false
      let failure = error.flatMap { AppleSpeechRecognizer.failure(for: $0) }
      let ended = error != nil

      Task { @MainActor in
        engine?.report(words, final: final, failure: failure, session: session)

        if ended, failure == nil {
          engine?.finish(session)
        }
      }
    }
  }

  // MARK: VoiceModeSpeaking

  public func speak(
    _ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void
  ) {
    stopSpeech()

    guard running else {
      onDone()
      return
    }

    speechToken += 1
    let token = speechToken
    speechDone = onDone
    playback.begin(token)

    if !player.isPlaying {
      player.play()
    }

    let playback = self.playback
    let finished = Self.finished(for: self, token: token)
    renderer.render(request, rate: rate, voice: voice) { buffer in
      playback.play(buffer, token: token, finished: finished)
    }
  }

  private nonisolated static func finished(for engine: AppleVoiceModeEngine, token: Int) -> @Sendable () -> Void {
    { [weak engine] in
      Task { @MainActor in engine?.spoken(token) }
    }
  }

  private func spoken(_ token: Int) {
    guard token == speechToken, let done = speechDone else {
      return
    }

    speechDone = nil
    done()
  }

  public func stop() {
    stopSpeech()
  }

  private func stopSpeech() {
    // Ownership first: what the renderer and the player still report is about nothing wanted.
    speechToken += 1
    speechDone = nil
    playback.begin(-1)
    renderer.cancel()

    if running {
      player.stop()
    }
  }

  public func playCue() {
    guard running, let cue = Self.cue() else {
      return
    }

    if !player.isPlaying {
      player.play()
    }

    player.scheduleBuffer(cue, completionHandler: nil)
  }

  public func voices() -> [SpeechVoice] {
    renderer.voices()
  }

  public func personalVoiceAccess() -> PersonalVoiceAccess {
    AppleSpeechSynthesizer.personalVoiceAccess(AVSpeechSynthesizer.personalVoiceAuthorizationStatus)
  }

  public func requestPersonalVoiceAccess() async -> PersonalVoiceAccess {
    await AppleSpeechSynthesizer().requestPersonalVoiceAccess()
  }

  /// A short, soft falling tone: "still working".
  private static func cue() -> AVAudioPCMBuffer? {
    let format = playFormat
    let frames = AVAudioFrameCount(format.sampleRate * 0.16)

    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames), let data = buffer.floatChannelData
    else {
      return nil
    }

    buffer.frameLength = frames
    let rate = Float(format.sampleRate)
    var phase: Float = 0

    for frame in 0..<Int(frames) {
      let time = Float(frame) / rate
      let frequency = 740 - 180 * time / 0.16
      phase += 2 * .pi * frequency / rate
      let envelope = min(1, time / 0.01) * exp(-time * 22)
      data[0][frame] = sin(phase) * 0.07 * envelope
    }

    return buffer
  }

  // MARK: Off the main actor

  /// The recognition request the microphone feeds, swapped on the main actor and read on the audio
  /// thread.
  private final class RequestSlot: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ request: SFSpeechAudioBufferRecognitionRequest?) {
      lock.withLock { self.request = request }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
      lock.withLock { request?.append(buffer) }
    }
  }

  /// The player's side of a reply: the renderer's buffers, converted to the player's format and
  /// scheduled, and the end marked by a short silence whose playback is the completion. A token says
  /// which reply is wanted; anything else is dropped.
  private final class Playback: @unchecked Sendable {
    private let player: AVAudioPlayerNode
    private let format: AVAudioFormat
    private let lock = NSLock()
    private var token = -1
    private var converter: AVAudioConverter?

    init(player: AVAudioPlayerNode, format: AVAudioFormat) {
      self.player = player
      self.format = format
    }

    func begin(_ token: Int) {
      lock.withLock {
        self.token = token
        converter?.reset()
      }
    }

    func play(_ buffer: AVAudioPCMBuffer?, token: Int, finished: @escaping @Sendable () -> Void) {
      lock.withLock {
        guard token == self.token else {
          return
        }

        guard let buffer else {
          // The end: a moment of silence, and when it has been heard, the reply has.
          if let tail = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 512) {
            tail.frameLength = 512
            player.scheduleBuffer(tail, completionCallbackType: .dataPlayedBack) { _ in finished() }
          } else {
            finished()
          }
          return
        }

        if let converted = convert(buffer) {
          player.scheduleBuffer(converted, completionHandler: nil)
        }
      }
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
      if buffer.format == format {
        return buffer
      }

      if converter == nil || converter?.inputFormat != buffer.format {
        converter = AVAudioConverter(from: buffer.format, to: format)
      }

      guard let converter else {
        return nil
      }

      let ratio = format.sampleRate / buffer.format.sampleRate
      let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)

      guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
        return nil
      }

      let source = SourceOnce(buffer)
      var error: NSError?
      converter.convert(to: output, error: &error) { _, status in
        source.next(status)
      }

      return error == nil && output.frameLength > 0 ? output : nil
    }

    /// Hands a converter one buffer, then says there is nothing more for now.
    private final class SourceOnce: @unchecked Sendable {
      private var buffer: AVAudioPCMBuffer?

      init(_ buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
      }

      func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        guard let buffer else {
          status.pointee = .noDataNow
          return nil
        }

        self.buffer = nil
        status.pointee = .haveData
        return buffer
      }
    }
  }

  /// The microphone's tap. Real-time thread: a level and an append, nothing else.
  private nonisolated static func inputTap(slot: RequestSlot, meter: VoiceLevelMeter) -> AVAudioNodeTapBlock {
    { buffer, _ in
      if let channels = buffer.floatChannelData, buffer.frameLength > 0 {
        meter.record(samples: UnsafeBufferPointer(start: channels[0], count: Int(buffer.frameLength)))
      }

      slot.append(buffer)
    }
  }

  /// The output's tap: how loud what is being said is.
  private nonisolated static func outputTap(meter: VoiceLevelMeter) -> AVAudioNodeTapBlock {
    { buffer, _ in
      if let channels = buffer.floatChannelData, buffer.frameLength > 0 {
        meter.record(samples: UnsafeBufferPointer(start: channels[0], count: Int(buffer.frameLength)))
      }
    }
  }

  enum VoiceEngineError: Error {
    case noInput
  }
}
