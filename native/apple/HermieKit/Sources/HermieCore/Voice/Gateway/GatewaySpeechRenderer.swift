import AVFoundation
import Foundation
import Synchronization

/// What one fetch of a sentence's audio reports, in order: buffers, then an end or a failure.
enum GatewayFetchEvent: Sendable {
  case audio(PCMChunk)
  case end
  case failed
}

/// Whether the streamed route is worth trying: the gateway said its provider has no chunked API
/// (for good), or a stream failed (for a while). And which voices the gateway has refused: it does not
/// know one or could not make it (`unknown_voice`, `invalid_voice`, `voice_failed`), so that voice is not asked for again, or it cannot
/// stream one (`voice_unsupported`), so that voice is not streamed again. Read and written from
/// whichever task is fetching.
public final class GatewayStreamSupport: Sendable {
  public init() {}

  private struct Refused {
    var voices: Set<String> = []
    var streamed: Set<String> = []
  }

  private let disabledUntil = Mutex<Double>(-.infinity)
  private let refused = Mutex(Refused())

  func allowed(at now: Double) -> Bool {
    disabledUntil.withLock { now >= $0 }
  }

  func disable(until moment: Double) {
    disabledUntil.withLock { $0 = max($0, moment) }
  }

  /// The stream is worth trying for this voice: it has not said it cannot stream it.
  func allowsStream(voice: String?) -> Bool {
    guard let voice else {
      return true
    }

    return refused.withLock { !$0.streamed.contains(voice) }
  }

  /// The gateway does not take this voice: not asked for again in this session.
  func reject(voice: String?) {
    if let voice {
      _ = refused.withLock { $0.voices.insert(voice) }
    }
  }

  func isRejected(voice: String?) -> Bool {
    guard let voice else {
      return false
    }

    return refused.withLock { $0.voices.contains(voice) }
  }

  /// What an `error` frame of the stream means for the voice it was sent with. The sentence itself is
  /// asked again as a file either way.
  func streamRefused(code: String, voice: String?) {
    guard let voice else {
      return
    }

    if Self.refusesVoice(code: code) {
      reject(voice: voice)
    } else if code == "voice_unsupported" {
      _ = refused.withLock { $0.streamed.insert(voice) }
    }
  }

  /// The stream's refusals that mean the gateway will not speak in this voice at all: it does not know it, it was
  /// not a voice id, or it could not make it. (`voice_unsupported` is only about the stream: the file route may.)
  static func refusesVoice(code: String) -> Bool {
    ["unknown_voice", "invalid_voice", "voice_failed"].contains(code)
  }
}

/**
 One sentence's audio, fetched in the background and held for whoever plays it: started when the
 sentence is first wanted, which may be before it is spoken (the prefetch), and read through `events`
 from any moment after. Cancelling it closes the socket or abandons the request.

 The route is the stream (`WS /api/audio/speak-stream`: PCM as the gateway makes it, which is what
 lets the first words be heard before the sentence is finished) and, where the gateway has no stream
 for its provider or the stream does not open, `POST /api/audio/speak` (the whole sentence as a file,
 decoded here). What arrived before a stream broke is kept and played to its end rather than spoken
 again in another voice.
 */
final class GatewayFetch {
  let events: AsyncStream<GatewayFetchEvent>
  let created: Double
  private let task: Task<Void, Never>

  init(
    transport: any GatewaySpeechTransport, text: String, profile: String?, voice: String?,
    support: GatewayStreamSupport, clock: @escaping @Sendable () -> Double, streamBackoff: Double
  ) {
    let (events, continuation) = AsyncStream<GatewayFetchEvent>.makeStream(bufferingPolicy: .unbounded)
    self.events = events
    created = clock()

    let task = Self.start(
      transport: transport, text: text, profile: profile, voice: voice, support: support, clock: clock,
      streamBackoff: streamBackoff, into: continuation)

    self.task = task
    continuation.onTermination = { _ in task.cancel() }
  }

  /// The fetch's task, made outside `init`: Swift 6.3's region checker cannot follow a `Task` closure
  /// that captures the initialiser's parameters while `self` is still being set up.
  private static func start(
    transport: any GatewaySpeechTransport, text: String, profile: String?, voice: String?,
    support: GatewayStreamSupport, clock: @escaping @Sendable () -> Double, streamBackoff: Double,
    into continuation: AsyncStream<GatewayFetchEvent>.Continuation
  ) -> Task<Void, Never> {
    Task {
      await run(
        transport: transport, text: text, profile: profile, voice: voice, support: support, clock: clock,
        streamBackoff: streamBackoff, into: continuation)
      continuation.finish()
    }
  }

  func cancel() {
    task.cancel()
  }

  /// How one pass over the routes with one voice ended.
  private enum Route {
    /// The sentence's audio has been handed over, to its end.
    case finished
    /// Nothing more is wanted (the consumer went away).
    case cancelled
    /// The gateway could not speak it.
    case failed
    /// The gateway would not speak it in the voice that was named; no audio came.
    case voiceRefused
  }

  /// The sentence in `voice`; and when the gateway refuses that voice (the profile it is asked as does not have it:
  /// a voice chosen for another provider, a clone that was deleted), the same sentence without one, which is the
  /// profile's own voice. The refused voice is remembered, so no sentence after it asks for it again.
  private static func run(
    transport: any GatewaySpeechTransport, text: String, profile: String?, voice: String?,
    support: GatewayStreamSupport, clock: @Sendable () -> Double, streamBackoff: Double,
    into continuation: AsyncStream<GatewayFetchEvent>.Continuation
  ) async {
    var route = await attempt(
      transport: transport, text: text, profile: profile, voice: voice, support: support, clock: clock,
      streamBackoff: streamBackoff, into: continuation)

    if route == .voiceRefused, voice != nil {
      support.reject(voice: voice)
      route = await attempt(
        transport: transport, text: text, profile: profile, voice: nil, support: support, clock: clock,
        streamBackoff: streamBackoff, into: continuation)
    }

    if route == .failed || route == .voiceRefused {
      continuation.yield(.failed)
    }
  }

  private static func attempt(
    transport: any GatewaySpeechTransport, text: String, profile: String?, voice: String?,
    support: GatewayStreamSupport, clock: @Sendable () -> Double, streamBackoff: Double,
    into continuation: AsyncStream<GatewayFetchEvent>.Continuation
  ) async -> Route {
    var delivered = false

    if support.allowed(at: clock()), support.allowsStream(voice: voice) {
      var decoder: GatewayAudioDecoding.PCM16Stream?
      var rejected = false
      var refusedByGateway = false
      var refusedVoice = false

      do {
        for try await event in transport.stream(text: text, profile: profile, voice: voice) {
          switch event {
          case .start(let rate, let channels):
            decoder = GatewayAudioDecoding.PCM16Stream(sampleRate: rate, channels: channels)
            rejected = decoder == nil
          case .pcm(let data):
            if let buffer = decoder?.append(data) {
              delivered = true
              continuation.yield(.audio(PCMChunk(buffer: buffer)))
            }
          case .end:
            if delivered && !rejected {
              continuation.yield(.end)
              return .finished
            }

            return .failed
          case .fallback:
            // This provider has no stream: the route is not tried again.
            support.disable(until: .infinity)
          case .error(let code, _):
            // The gateway refused the voice (or the prosody) and closed. A voice it does not know is not asked for
            // again, and the sentence goes on without it; any other refusal goes on as a file.
            support.streamRefused(code: code, voice: voice)
            refusedByGateway = true
            refusedVoice = voice != nil && GatewayStreamSupport.refusesVoice(code: code)
          }

          if rejected || refusedByGateway {
            break
          }
        }

        if delivered {
          continuation.yield(.end)
          return .finished
        }

        if refusedVoice {
          return .voiceRefused
        }
      } catch {
        if Task.isCancelled {
          return .cancelled
        }

        if delivered {
          // A stream that broke part-way: what was heard is the sentence, as far as it went.
          continuation.yield(.end)
          return .finished
        }

        support.disable(until: clock() + streamBackoff)
      }
    }

    guard !Task.isCancelled else {
      return .cancelled
    }

    do {
      let clip = try await transport.speak(text: text, profile: profile, voice: voice)

      guard !Task.isCancelled else {
        return .cancelled
      }

      for buffer in try GatewayAudioDecoding.decode(clip) {
        continuation.yield(.audio(PCMChunk(buffer: buffer)))
      }

      continuation.yield(.end)
      return .finished
    } catch GatewaySpeechError.voiceRefused where voice != nil {
      return Task.isCancelled ? .cancelled : .voiceRefused
    } catch {
      return Task.isCancelled ? .cancelled : .failed
    }
  }
}

/**
 The gateway's text-to-speech as a source of voice mode's audio (`VoiceSpeechRenderer`): each sentence is
 fetched from the gateway, decoded to PCM buffers, and handed to the same player node as the device's
 voices, so the echo canceller hears it, the orb's meter measures it and speaking over it cuts it.

 - **Quick to start.** A sentence is requested the moment it is wanted, the streamed route hands over
   audio as it is made, and the sentence after it is fetched while this one is spoken (`prefetch`), so
   two sentences have no gap between them.
 - **The device's voice when the gateway lets the call down.** A sentence whose first audio has not
   arrived within `Timing.firstAudio`, or that fails outright, is spoken by the device's voice instead,
   and the sentence after it does not wait on the gateway again for `Timing.cooldown`: a gateway that is
   down must not cost two seconds a sentence. The first fall-back of a renderer's life says so
   (`onFallback`, once), because a different voice mid-call is something to be told.
 - **The profile's own voice before the device's.** A voice the gateway refuses for this profile (one chosen
   from another provider, a clone that is gone) is not given up on by falling back to the device: the same
   sentence is asked again without a voice, so the gateway speaks it in the profile's configured one, and the
   refused voice is not asked for again this session. Only if that fails too is the sentence the device's.
 - **Only for what asks for it.** A request whose source is the device goes straight to the device's
   renderer, so one call can hold both (a bot with a voice of its own).
 - **What is not carried.** The gateway's voice takes no pace or pitch of its own (the request has
   none), so the pace and expressivity settings are the device voice's alone.

 Used from the main actor; the fetching runs on tasks of its own and only plain values come back.
 */
@MainActor
public final class GatewaySpeechRenderer: VoiceSpeechRenderer {
  public struct Timing: Sendable {
    /// How long the first audio of a sentence may take before the device speaks it instead.
    public var firstAudio: Duration
    /// How long after a fall-back the next sentences go straight to the device.
    public var cooldown: Double
    /// How long after a failed stream the streamed route is not tried (the file route is).
    public var streamBackoff: Double

    public init(firstAudio: Duration = .seconds(2), cooldown: Double = 20, streamBackoff: Double = 60) {
      self.firstAudio = firstAudio
      self.cooldown = cooldown
      self.streamBackoff = streamBackoff
    }
  }

  /// A sentence being rendered.
  private final class Playing {
    let fetch: GatewayFetch
    var delivered = false
    var pump: Task<Void, Never>?
    var timeout: Task<Void, Never>?

    init(fetch: GatewayFetch) {
      self.fetch = fetch
    }

    func stop() {
      timeout?.cancel()
      pump?.cancel()
      fetch.cancel()
    }
  }

  private struct Key: Hashable {
    var text: String
    var voice: String?
  }

  private let transport: any GatewaySpeechTransport
  private let profile: String?
  private let fallback: any VoiceSpeechRenderer
  private let timing: Timing
  private let clock: @Sendable () -> Double
  private let available: @MainActor () -> Bool
  private let providerOfProfile: @MainActor () -> String?
  private let support: GatewayStreamSupport

  private var generation = 0
  private var current: Playing?
  private var prefetched: [(key: Key, fetch: GatewayFetch)] = []
  private var downUntil = -Double.infinity
  private var told = false
  private var onFallback: (@MainActor @Sendable () -> Void)?

  /// How many sentences are fetched ahead: the one that is next, and one more.
  static let prefetchLimit = 2
  /// A fetch that was not used within this long is not wanted any more.
  static let prefetchLife = 60.0

  /// - Parameters:
  ///   - profile: the bot the gateway resolves its text-to-speech for.
  ///   - fallback: the device's renderer: what speaks a request meant for the device, and a sentence
  ///     the gateway could not.
  ///   - available: whether the gateway has text-to-speech at all (its `voice-config`); where it
  ///     does not, everything is the device's, and nothing is said about it.
  ///   - provider: the provider this profile speaks through (its `voice-config`), when known: a request's voice
  ///     chosen from another provider is not sent.
  ///   - support: what the gateway has refused for this profile (voices, the stream); shared by every renderer of
  ///     one profile, so a refusal is remembered for the session and not once per chat or call.
  public init(
    transport: any GatewaySpeechTransport, profile: String?, fallback: any VoiceSpeechRenderer,
    timing: Timing = Timing(), clock: @escaping @Sendable () -> Double = GatewaySpeechRenderer.uptime,
    available: @escaping @MainActor () -> Bool = { true }, provider: @escaping @MainActor () -> String? = { nil },
    support: GatewayStreamSupport = GatewayStreamSupport()
  ) {
    self.transport = transport
    self.profile = profile
    self.fallback = fallback
    self.timing = timing
    self.clock = clock
    self.available = available
    providerOfProfile = provider
    self.support = support
  }

  public nonisolated static func uptime() -> Double {
    ProcessInfo.processInfo.systemUptime
  }

  public func setFallbackHandler(_ handler: (@MainActor @Sendable () -> Void)?) {
    onFallback = handler
  }

  // MARK: VoiceSpeechRenderer

  public func render(
    _ request: ReadRequest, rate: Double, voice: String?, deliver: @escaping @Sendable (AVAudioPCMBuffer?) -> Void
  ) {
    stopCurrent()
    generation += 1
    let token = generation

    guard wantsGateway(request) else {
      fallback.render(request, rate: rate, voice: voice, deliver: deliver)
      return
    }

    let fetch = takePrefetched(for: Key(text: request.text, voice: gatewayVoice(for: request))) ?? makeFetch(request)
    let playing = Playing(fetch: fetch)
    current = playing

    playing.timeout = Task { [weak self] in
      do {
        try await Task.sleep(for: self?.timing.firstAudio ?? .seconds(2))
      } catch {
        return
      }

      self?.fallBack(token, request, rate, voice, deliver)
    }

    playing.pump = Task { [weak self] in
      for await event in fetch.events {
        guard let self, token == self.generation, self.current === playing else {
          return
        }

        switch event {
        case .audio(let chunk):
          if !playing.delivered {
            playing.delivered = true
            playing.timeout?.cancel()
          }

          deliver(chunk.buffer)
        case .end:
          if playing.delivered {
            self.current = nil
            playing.stop()
            deliver(nil)
          } else {
            self.fallBack(token, request, rate, voice, deliver)
          }

          return
        case .failed:
          if playing.delivered {
            self.current = nil
            playing.stop()
            deliver(nil)
          } else {
            self.fallBack(token, request, rate, voice, deliver)
          }

          return
        }
      }
    }
  }

  public func cancel() {
    generation += 1
    stopCurrent()
    fallback.cancel()
  }

  public func prefetch(_ request: ReadRequest, rate: Double, voice: String?) {
    guard wantsGateway(request) else {
      return
    }

    let key = Key(text: request.text, voice: gatewayVoice(for: request))

    guard !prefetched.contains(where: { $0.key == key }) else {
      return
    }

    prefetched.append((key, makeFetch(request)))

    while prefetched.count > Self.prefetchLimit {
      prefetched.removeFirst().fetch.cancel()
    }
  }

  public func discardPrefetched() {
    for entry in prefetched {
      entry.fetch.cancel()
    }

    prefetched = []
  }

  public func voices() -> [SpeechVoice] {
    fallback.voices()
  }

  // MARK: Inside

  /// The gateway is asked for this request: it is meant for it, the gateway has text-to-speech and it
  /// has not just let the call down.
  private func wantsGateway(_ request: ReadRequest) -> Bool {
    request.source == .gateway && available() && clock() >= downUntil
  }

  /// The voice the gateway is asked for in this request, if any. None where the voice was chosen from another
  /// provider than the one this profile speaks through (an Edge voice is no voice of ElevenLabs), and where the
  /// gateway has refused it this session: the profile's own voice speaks then. A voice kept without its provider
  /// is sent as it is, and given up on if it is refused.
  private func gatewayVoice(for request: ReadRequest) -> String? {
    guard let voice = request.gatewayVoice, !voice.isEmpty else {
      return nil
    }

    if let chosenFrom = request.gatewayProvider, let speaksWith = providerOfProfile(),
      chosenFrom.lowercased() != speaksWith.lowercased()
    {
      return nil
    }

    return support.isRejected(voice: voice) ? nil : voice
  }

  private func makeFetch(_ request: ReadRequest) -> GatewayFetch {
    GatewayFetch(
      transport: transport, text: request.text, profile: profile, voice: gatewayVoice(for: request), support: support,
      clock: clock, streamBackoff: timing.streamBackoff)
  }

  private func takePrefetched(for key: Key) -> GatewayFetch? {
    let now = clock()

    for entry in prefetched where now - entry.fetch.created > Self.prefetchLife {
      entry.fetch.cancel()
    }

    prefetched.removeAll { now - $0.fetch.created > Self.prefetchLife }

    guard let index = prefetched.firstIndex(where: { $0.key == key }) else {
      return nil
    }

    return prefetched.remove(at: index).fetch
  }

  private func stopCurrent() {
    current?.stop()
    current = nil
  }

  /// The sentence has no audio from the gateway in time, or at all: the device speaks it.
  private func fallBack(
    _ token: Int, _ request: ReadRequest, _ rate: Double, _ voice: String?,
    _ deliver: @escaping @Sendable (AVAudioPCMBuffer?) -> Void
  ) {
    guard token == generation, let playing = current, !playing.delivered else {
      return
    }

    stopCurrent()
    downUntil = clock() + timing.cooldown

    if !told {
      told = true
      onFallback?()
    }

    fallback.render(request, rate: rate, voice: voice, deliver: deliver)
  }
}
