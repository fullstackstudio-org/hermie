import HermieCore
import SwiftUI

/// The chat's voice options, in its `…` menu: whether this chat reads each finished reply aloud, and a
/// way to silence a read that is going. The rate, the voice and the dictation language are the whole
/// device's, in Settings › Voice. Drawn only where the device can speak.
struct ChatVoiceOptionItems: View {
  let feed: ChatFeed

  var body: some View {
    if let reader = feed.readAloud, reader.isAvailable {
      Divider()

      // A call with the bot: listen, send, read the reply, listen again.
      if feed.offersVoiceMode {
        Button {
          feed.openVoiceMode()
        } label: {
          Label(Strings.Chat.Voice.modeStart, systemImage: "waveform")
        }
        .disabled(feed.voiceMode != nil)
        .accessibilityIdentifier("hermie.chat.options.voiceMode")
      }

      Toggle(isOn: Binding(get: { feed.autoRead }, set: { feed.autoRead = $0 })) {
        Label(Strings.Chat.Voice.autoRead, systemImage: "speaker.wave.2")
      }
      .accessibilityHint(Strings.Chat.Voice.autoReadHint)
      .accessibilityIdentifier("hermie.chat.options.autoRead")

      // Only while there is something to stop: a Stop that does nothing almost all of the time is a
      // control to skip over. It is here, and not only in the message menu, because this is the one
      // place that can stop a read the reader did not start from a row (an automatic one).
      if reader.isReading {
        Button {
          reader.stop()
        } label: {
          Label(Strings.Chat.Menu.stopReading, systemImage: "stop.circle")
        }
        .accessibilityIdentifier("hermie.chat.options.stopReading")
      }
    }
  }
}
