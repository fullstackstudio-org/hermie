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
/// (for good), or a stream failed (for a while). Read and written from whichever task is fetching.
final class GatewayStreamSupport: Sendable {
  private let disabledUntil = Mutex<Double>(-.infinity)

  func allowed(at now: Double) -> Bool {
    disabledUntil.withLock { now >= $0 }
  }

  func disable(until moment: Double) {
    disabledUntil.withLock { $0 = max($0, moment) }
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

    let task = Task {
      await Self.run(
        transport: transport, text: text, profile: profile, voice: voice, support: support, clock: clock,
        streamBackoff: streamBackoff, into: continuation)
      continuation.finish()
    }

    self.task = task
    continuation.onTermination = { _ in task.cancel() }
  }

  func cancel() {
    task.cancel()
  }

  private static func run(
    transport: any GatewaySpeechTransport, text: String, profile: String?, voice: String?,
    support: GatewayStreamSupport, clock: @Sendable () -> Double, streamBackoff: Double,
    into continuation: AsyncStream<GatewayFetchEvent>.Continuation
  ) async {
    var delivered = false

    if support.allowed(at: clock()) {
      var decoder: GatewayAudioDecoding.PCM16Stream?
      var rejected = false

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
            continuation.yield(delivered && !rejected ? .end : .failed)
            return
          case .fallback:
            // This provider has no stream: the route is not tried again.
            support.disable(until: .infinity)
          }

          if rejected {
            break
          }
        }

        if delivered {
          continuation.yield(.end)
          return
        }
      } catch {
        if Task.isCancelled {
          return
        }

        if delivered {
          // A stream that broke part-way: what was heard is the sentence, as far as it went.
          continuation.yield(.end)
          return
        }

        support.disable(until: clock() + streamBackoff)
      }
    }

    guard !Task.isCancelled else {
      return
    }

    do {
      let clip = try await transport.speak(text: text, profile: profile, voice: voice)

      guard !Task.isCancelled else {
        return
      }

      for buffer in try GatewayAudioDecoding.decode(clip) {
        continuation.yield(.audio(PCMChunk(buffer: buffer)))
      }

      continuation.yield(.end)
    } catch {
      if !Task.isCancelled {
        continuation.yield(.failed)
      }
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
  private let support = GatewayStreamSupport()

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
  public init(
    transport: any GatewaySpeechTransport, profile: String?, fallback: any VoiceSpeechRenderer,
    timing: Timing = Timing(), clock: @escaping @Sendable () -> Double = GatewaySpeechRenderer.uptime,
    available: @escaping @MainActor () -> Bool = { true }
  ) {
    self.transport = transport
    self.profile = profile
    self.fallback = fallback
    self.timing = timing
    self.clock = clock
    self.available = available
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

    let fetch = takePrefetched(for: Key(text: request.text, voice: request.gatewayVoice)) ?? makeFetch(request)
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

    let key = Key(text: request.text, voice: request.gatewayVoice)

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

  /// The gateway is asked for this request: it is meant for it, the gateway has text-to-speech, and
  /// it has not just let the call down.
  private func wantsGateway(_ request: ReadRequest) -> Bool {
    request.source == .gateway && available() && clock() >= downUntil
  }

  private func makeFetch(_ request: ReadRequest) -> GatewayFetch {
    GatewayFetch(
      transport: transport, text: request.text, profile: profile, voice: request.gatewayVoice, support: support,
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
