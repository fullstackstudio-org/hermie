import Foundation
import HermieCore
import HermieProtocol

/// The app's own words for the code scan, the signature and the voice note (`device.scan`, `input.signature`,
/// `input.file` asking for a recording): the sheets' chrome, buttons and notices. Never what the agent says: that is
/// shown verbatim and marked as the agent's. The strings live in `Native.xcstrings` under `native.deviceRequests.`.
extension NativeStrings {
  enum DeviceRequests {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Open Settings
    static var openSettings: String { string("native.deviceRequests.openSettings") }

    // MARK: Scan

    enum Scan {
      /// {bot} asks you to scan a code
      static func title(_ bot: String) -> String {
        String(
          localized: "native.deviceRequests.scan.title", defaultValue: "\(bot) asks you to scan a code", table: "Native",
          bundle: .module)
      }
      /// The camera turns on only when you press Scan. Hermie shows you what the code says before anything is sent.
      static var intro: String { DeviceRequests.string("native.deviceRequests.scan.intro") }
      /// Looking for: {kinds}
      static func looking(_ kinds: String) -> String {
        String(
          localized: "native.deviceRequests.scan.looking", defaultValue: "Looking for: \(kinds)", table: "Native",
          bundle: .module)
      }
      /// any code
      static var anyCode: String { DeviceRequests.string("native.deviceRequests.scan.anyCode") }
      /// Scan
      static var start: String { DeviceRequests.string("native.deviceRequests.scan.start") }
      /// Point the camera at the code.
      static var aim: String { DeviceRequests.string("native.deviceRequests.scan.aim") }
      /// Camera view
      static var cameraLabel: String { DeviceRequests.string("native.deviceRequests.scan.cameraLabel") }
      /// Code found
      static var found: String { DeviceRequests.string("native.deviceRequests.scan.found") }
      /// Read as: {kind}
      static func kind(_ kind: String) -> String {
        String(
          localized: "native.deviceRequests.scan.kind", defaultValue: "Read as: \(kind)", table: "Native",
          bundle: .module)
      }
      /// What the code says
      static var valueLabel: String { DeviceRequests.string("native.deviceRequests.scan.valueLabel") }
      /// This text comes from the code, not from Hermie or your bot. ...
      static var untrusted: String { DeviceRequests.string("native.deviceRequests.scan.untrusted") }
      /// Hidden or control characters were removed from this text.
      static var cleaned: String { DeviceRequests.string("native.deviceRequests.scan.cleaned") }
      /// Nothing readable is left in this code, so it cannot be sent. Scan another one.
      static var empty: String { DeviceRequests.string("native.deviceRequests.scan.empty") }
      /// This code holds more text than can be sent. Scan another one.
      static var tooLong: String { DeviceRequests.string("native.deviceRequests.scan.tooLong") }
      /// Scan again
      static var rescan: String { DeviceRequests.string("native.deviceRequests.scan.rescan") }
      /// Hermie does not have access to the camera. You can allow it in Settings.
      static var denied: String { DeviceRequests.string("native.deviceRequests.scan.denied") }
      /// The camera is switched off for this device by a restriction.
      static var restricted: String { DeviceRequests.string("native.deviceRequests.scan.restricted") }
      /// This device has no camera that can read a code.
      static var noCamera: String { DeviceRequests.string("native.deviceRequests.scan.noCamera") }
      /// I can't scan
      static var cannot: String { DeviceRequests.string("native.deviceRequests.scan.cannot") }
      /// Tells the bot that this device cannot scan the code.
      static var cannotHint: String { DeviceRequests.string("native.deviceRequests.scan.cannotHint") }

      /// The name of a kind of code: "QR code", "EAN-13 barcode".
      static func name(_ symbology: ScanSymbology) -> String {
        switch symbology {
        case .qr: DeviceRequests.string("native.deviceRequests.scan.symbology.qr")
        case .ean13: DeviceRequests.string("native.deviceRequests.scan.symbology.ean13")
        case .ean8: DeviceRequests.string("native.deviceRequests.scan.symbology.ean8")
        case .code128: DeviceRequests.string("native.deviceRequests.scan.symbology.code128")
        case .pdf417: DeviceRequests.string("native.deviceRequests.scan.symbology.pdf417")
        case .datamatrix: DeviceRequests.string("native.deviceRequests.scan.symbology.datamatrix")
        case .aztec: DeviceRequests.string("native.deviceRequests.scan.symbology.aztec")
        case .unknown(let raw): SecurePrompt.displayText(raw, limit: 24)
        }
      }
    }

    // MARK: Signature

    enum Signature {
      /// {bot} asks you to sign
      static func title(_ bot: String) -> String {
        String(
          localized: "native.deviceRequests.signature.title", defaultValue: "\(bot) asks you to sign", table: "Native",
          bundle: .module)
      }
      /// You are signing
      static var statement: String { DeviceRequests.string("native.deviceRequests.signature.statement") }
      /// Signing as {name}
      static func signer(_ name: String) -> String {
        String(
          localized: "native.deviceRequests.signature.signer", defaultValue: "Signing as \(name)", table: "Native",
          bundle: .module)
      }
      /// Date and time
      static var time: String { DeviceRequests.string("native.deviceRequests.signature.time") }
      /// Signature pad
      static var padLabel: String { DeviceRequests.string("native.deviceRequests.signature.padLabel") }
      /// Draw your signature with a finger, a pen or the pointer.
      static var padHint: String { DeviceRequests.string("native.deviceRequests.signature.padHint") }
      /// Sign here
      static var placeholder: String { DeviceRequests.string("native.deviceRequests.signature.placeholder") }
      /// Draw your signature in the box above.
      static var empty: String { DeviceRequests.string("native.deviceRequests.signature.empty") }
      /// Clear
      static var clear: String { DeviceRequests.string("native.deviceRequests.signature.clear") }
      /// Undo
      static var undo: String { DeviceRequests.string("native.deviceRequests.signature.undo") }
      /// Sign and send
      static var sign: String { DeviceRequests.string("native.deviceRequests.signature.sign") }
      /// Your signature goes as a PNG and an SVG picture, with a fingerprint of the statement above, ...
      static var note: String { DeviceRequests.string("native.deviceRequests.signature.note") }
      /// Preparing your signature…
      static var preparing: String { DeviceRequests.string("native.deviceRequests.signature.preparing") }
      /// Your signature could not be prepared. Try again.
      static var failedFiles: String { DeviceRequests.string("native.deviceRequests.signature.failedFiles") }
      /// Your signature is larger than this request allows. Clear it and draw a simpler one.
      static var tooLarge: String { DeviceRequests.string("native.deviceRequests.signature.tooLarge") }
    }

    // MARK: Voice note

    enum Voice {
      /// {bot} asks you for a voice note
      static func title(_ bot: String) -> String {
        String(
          localized: "native.deviceRequests.voice.title", defaultValue: "\(bot) asks you for a voice note", table: "Native",
          bundle: .module)
      }
      /// The microphone turns on only when you press Record. ...
      static var intro: String { DeviceRequests.string("native.deviceRequests.voice.intro") }
      /// Record
      static var record: String { DeviceRequests.string("native.deviceRequests.voice.record") }
      /// Stop
      static var stop: String { DeviceRequests.string("native.deviceRequests.voice.stop") }
      /// Recording
      static var recording: String { DeviceRequests.string("native.deviceRequests.voice.recording") }
      /// Record again
      static var recordAgain: String { DeviceRequests.string("native.deviceRequests.voice.recordAgain") }
      /// Play
      static var play: String { DeviceRequests.string("native.deviceRequests.voice.play") }
      /// Pause
      static var pause: String { DeviceRequests.string("native.deviceRequests.voice.pause") }
      /// Voice note, {length}
      static func noteLength(_ length: String) -> String {
        String(
          localized: "native.deviceRequests.voice.noteLength", defaultValue: "Voice note, \(length)", table: "Native",
          bundle: .module)
      }
      /// Sound level
      static var level: String { DeviceRequests.string("native.deviceRequests.voice.level") }
      /// Writing a transcript on this device…
      static var transcribing: String { DeviceRequests.string("native.deviceRequests.voice.transcribing") }
      /// Transcript
      static var transcriptLabel: String { DeviceRequests.string("native.deviceRequests.voice.transcriptLabel") }
      /// Send the transcript too
      static var sendTranscript: String { DeviceRequests.string("native.deviceRequests.voice.sendTranscript") }
      /// Made on this device. It can be wrong; the recording is what counts.
      static var transcriptNote: String { DeviceRequests.string("native.deviceRequests.voice.transcriptNote") }
      /// No transcript: this device cannot make one without sending the audio to a service.
      static var transcriptNone: String { DeviceRequests.string("native.deviceRequests.voice.transcriptNone") }
      /// No words were recognised, so no transcript goes with it.
      static var transcriptEmpty: String { DeviceRequests.string("native.deviceRequests.voice.transcriptEmpty") }
      /// Choose a recording instead
      static var chooseFile: String { DeviceRequests.string("native.deviceRequests.voice.chooseFile") }
      /// A recording you choose is sent as it is. It may carry details of its own, ...
      static var pickedNote: String { DeviceRequests.string("native.deviceRequests.voice.pickedNote") }
      /// This recording was made on this device and carries no location.
      static var recordedNote: String { DeviceRequests.string("native.deviceRequests.voice.recordedNote") }
      /// This device has no microphone to record with.
      static var noMicrophone: String { DeviceRequests.string("native.deviceRequests.voice.noMicrophone") }
      /// Hermie does not have access to the microphone. You can allow it in Settings.
      static var denied: String { DeviceRequests.string("native.deviceRequests.voice.denied") }
      /// I can't record
      static var cannot: String { DeviceRequests.string("native.deviceRequests.voice.cannot") }
      /// Tells the bot that this device cannot record a voice note.
      static var cannotHint: String { DeviceRequests.string("native.deviceRequests.voice.cannotHint") }
      /// That was too short to keep. Press Record and try again.
      static var tooShort: String { DeviceRequests.string("native.deviceRequests.voice.tooShort") }
      /// The recording was interrupted. Try again.
      static var recordingFailed: String { DeviceRequests.string("native.deviceRequests.voice.recordingFailed") }
      /// The microphone is busy right now (a call or another app). Try again in a moment.
      static var microphoneBusy: String { DeviceRequests.string("native.deviceRequests.voice.microphoneBusy") }
      /// The recording could not be saved. Try again.
      static var unreadable: String { DeviceRequests.string("native.deviceRequests.voice.unreadable") }
    }

    // MARK: The transcript's card

    enum Card {
      /// Scanned a QR code
      static var scanQR: String { DeviceRequests.string("native.deviceRequests.card.scanQR") }
      /// Scanned a barcode
      static var scanBarcode: String { DeviceRequests.string("native.deviceRequests.card.scanBarcode") }
      /// Scanned a code
      static var scanCode: String { DeviceRequests.string("native.deviceRequests.card.scanCode") }
      /// Signed
      static var signed: String { DeviceRequests.string("native.deviceRequests.card.signed") }
      /// Voice note sent
      static var voiceNote: String { DeviceRequests.string("native.deviceRequests.card.voiceNote") }
      /// Code scan
      static var kindScan: String { DeviceRequests.string("native.deviceRequests.card.kindScan") }
      /// Signature
      static var kindSignature: String { DeviceRequests.string("native.deviceRequests.card.kindSignature") }

      /// The card's line for a scanned code, by the kind of code alone (never what it said).
      static func scanned(_ symbology: String) -> String {
        switch symbology {
        case "qr": scanQR
        case "ean13", "ean8", "code128": scanBarcode
        default: scanCode
        }
      }
    }
  }
}
