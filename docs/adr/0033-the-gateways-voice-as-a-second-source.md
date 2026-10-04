# 0033. The gateway's voice is a second source for speaking

- Status: Accepted
- Date: 2026-10-04
- Amends: [0022](0022-voice-on-the-device.md) (speaking only: listening stays on the device)

## Context

[ADR-0022](0022-voice-on-the-device.md) kept speech on the device because the gateway had no voice that a
client could use: `voice.tts` plays through the gateway host's speaker and returns no audio. It said it
would be superseded if upstream grew a real speech service, and the fork has. The dashboard routes of
`hermes_cli/web_routers/audio.py` give a client what the RPCs never did:

- `POST /api/audio/speak` answers a sentence as a base64 audio file, through the text-to-speech chain the
  profile is configured with (Edge, ElevenLabs, OpenAI, …);
- `WS /api/audio/speak-stream` answers the same as raw PCM while it is made;
- `GET /api/audio/voice-config` says whether and with what the profile can speak, and
  `GET /api/audio/elevenlabs/voices` lists ElevenLabs' voices, cloned ones included.

A bot's own voice, the one its owner paid for or cloned, is then available in the app, which the device's
voices cannot be.

## Decision

**The gateway's voice is a second source of speech, beside the device's, and only for speaking.** Listening
(dictation, the call's recogniser) is untouched: on the device, never sent anywhere.

- **It is chosen, never assumed.** The Voice screen's Source row (Apple / Gateway) is drawn only where
  `voice-config` says the gateway can speak, and the device is the default. A bot may have a source and a voice
  of its own (bot settings › Voice); both are kept on the device per gateway and bot (`VoiceSettings`), not in
  `ui_meta`, because a device voice's identifier means nothing on another device.
- **What leaves the device is what the conversation already sent there.** The words of a reply go to the gateway
  the reply came from, over the connection the conversation uses, to be spoken. The Voice screen says so when the
  source is the gateway (its subtitle changes from "Everything is spoken on this device"). The gateway's key for
  a provider is not needed by the app and is not kept: `voice-config` hands over the keys of providers a client
  could call itself (the desktop's client-direct mode), and the app reads only the provider's name and voice.
- **Same audio path as the device's voices.** Replies from the gateway are decoded to PCM buffers and played on
  the call's engine (`GatewaySpeechRenderer`, behind `VoiceSpeechRenderer`), so echo cancellation, the orb's
  meter and cutting in work as they do for the device's voices. Outside a call the same renderer plays on an
  engine of its own (`GatewaySpeechSynthesizer`). The streamed route is used where the gateway has one for its
  provider, the file route where it does not, and the device's voice where the gateway does not answer in time
  (2 seconds to the first audio) or at all; that is said once per call and the next sentences go straight to the
  device for a while.
- **A voice per request is not available yet.** `TTSSpeakRequest` is `{text}` and the stream's frames take no
  voice: the gateway speaks in the voice it is configured with. The app lists voices to choose from only when
  `voice-config` says `voice_selection: true`, and sends the choice with the request; until a gateway says so
  there is nothing to choose and the screen says that. A per-bot choice between the gateway's voices needs the
  same capability; a per-bot choice of Apple voice does not.

## Consequences

**What it costs.** ADR-0022's claim that nothing is sent anywhere is true of listening and of the device's
voices only. The setting is off by default and says what it does where it is turned on. A gateway with the
provider's key in `voice-config` is trusted to hand it to this client only because the client is already
trusted to drive the agent (the gateway's own reasoning for that route); the app does not keep it.

**What stays on the device.** Pace and expressivity are the device voice's: the request to the gateway has
neither. Ogg audio from the file route cannot be read by the system and falls back to the device's voice; the
stream (PCM) has no such limit.

**What would change this.** A gateway that takes a voice per request (`voice_selection`) completes the voice
choices; a gateway that offers one more provider changes nothing here, since the app reads the provider's name
from `voice-config` and nothing else.
