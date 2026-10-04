# 0021. Speech happens on the device, and the gateway's voice RPCs are not used

- Status: Accepted; speaking is amended by [0033](0033-the-gateways-voice-as-a-second-source.md)
- Date: 2026-09-22

## Context

Three things were wanted: read a reply aloud, dictate a message, and a hands-free loop over the
two. Each of them needs an engine, and there were three places to get one.

### The gateway has voice RPCs, and none of them is a service this client can use

This is the finding that decided the record, and it is the opposite of what the round's brief
assumed. The vendored contract carries `voice.tts`, `voice.record`, `voice.toggle`, `wake.*` and the
`voice.transcript` / `voice.status` events, so from the outside the gateway looks like it offers
speech to its clients. Reading `tui_gateway/methods_voice.py` says otherwise, and the shape is the
same in both directions:

- **`voice.tts` returns no audio.** Its whole body is `text = params.get("text")`, a thread running
  `speak_text(text)` from `hermes_cli.voice`, and `_ok(rid, {"status": "speaking"})`. The contract
  agrees: `VoiceTtsResult` is `{ status: string }`. `speak_text` plays through the **gateway host's**
  speaker. Called from a phone, it makes somebody's laptop start talking in another room. There is
  no `bytes`, no `base64` and no `url` anywhere in the method or in the type.
- **`voice.record` does not take audio either.** It calls `start_continuous(...)` from
  `hermes_cli.voice`, which opens the **gateway host's** microphone, and answers
  `{"status": "recording"}`; the text arrives later as a `voice.transcript` event. `VoiceRecordParams`
  is `{action, session_id, profile}` — there is no field for a client's bytes. It also refuses
  outright unless voice mode is on, which is a runtime env flag (`HERMES_VOICE`) on the gateway
  process rather than anything a client can set for itself without changing that process's global
  state.
- **`wake.feed` is the one RPC that takes client audio**, and it feeds the wake-word detector only:
  base64 int16 mono at 16 kHz, capped at two seconds, answering `{fed: bool}`. It returns no
  transcript and has no path to one.

So there is no RPC in this protocol that takes audio from a client and gives back text, and none
that gives a client audio to play. Both of the "when the gateway advertises it, offer it" options in
the brief describe a capability that does not exist. Building either would have meant a fake gateway
teaching the suite a shape the real one does not have — the same trap `profiles.configure` and its
missing `display_name` set in the previous round, recorded in `docs/platform-notes.md`.

### That leaves a cloud service, or the device

A cloud speech API — Apple's or Google's network recognizers, or any of the paid ones — is accurate,
supports more languages, and is available on hardware with no local model.

It is also the wrong shape for this app twice over:

- **What it would send is the conversation.** A reply read aloud is the reply; a dictated message is
  the message. This app's premise is that a person runs their own gateway and their agents' traffic
  goes nowhere else. A client that quietly posted both halves of that traffic to a third party would
  make the premise false in the one place a reader could not see it happening.
- **It would be somebody's account.** There is no Hermie service (ADR-0006), no key to ship, and no
  place to put one that a fork would not inherit. The alternative — asking each person for their own
  API key — is a setup step for a feature that the phone in their hand can already do.

## Decision

**On-device engines, always, through platform seams that hold the line.**

- Speaking is `expo-speech`: `AVSpeechSynthesizer` on Apple platforms, `TextToSpeech` on Android,
  `speechSynthesis` in a browser. All three are local, unpaid and unauthenticated.
- Listening is `expo-speech-recognition` with `requiresOnDeviceRecognition: true`, which is
  `SFSpeechRecognizer.supportsOnDeviceRecognition` on iOS and the offline service on Android.
- **A device with no offline model is refused rather than falling back to the network.**
  `speech-recognition.ts` answers `available: false` and the microphone button is not drawn.
- **The gateway's voice RPCs are not called at all.** Not as a fallback, not behind a capability
  probe, not as an option in the settings.

## Consequences

**What it costs.** On-device recognition is less accurate than the network kind, supports fewer
languages, and is simply absent on older hardware — and on those devices the feature is missing
rather than degraded. That is the price of the refusal above, and it is the honest form of the
claim: a silent network fallback would make the privacy statement false on exactly the devices whose
owners could not check it.

**The web is the one place the claim is narrower, and it says so.** `SpeechRecognition` in Chrome
and Safari transcribes on the vendor's servers and offers no switch to stop it. The button is still
drawn there, because the browser asks for the microphone with its own prompt and the visitor answers
it — but the README, the CHANGELOG and `speech-recognition.web.ts` all name the platforms the
on-device guarantee holds for rather than claiming it everywhere. Firefox has no such API and gets no
microphone at all.

**No new audio dependency.** Because `voice.tts` returns no bytes, nothing has to play a buffer, so
neither `expo-av` nor `expo-audio` was added. The iOS audio session is left to the platform through
`useApplicationAudioSession: false`, which gets ducking and interruption handling without this app
owning a session.

**If upstream ever grows a real speech service**, this record is superseded rather than edited. The
shape it would need is the one that does not exist today: an RPC that takes bytes and answers with
text, or one that answers with audio — and the decision would then be about whose machine does the
work, which is a different question from the one settled here.

**What is not decided here.** Whether a reply is read automatically, at what rate, and in which
language are settings, not architecture; they live in `features/voice/voice-settings.ts` and are
deliberately not synced through `ui_meta` (ADR-0016), because a speaker and a microphone are facts
about one device.
