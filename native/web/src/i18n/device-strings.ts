/**
 * Strings only the web client has, that only the sheets that reach for the device say: the signature pad, the location,
 * the contact picker, the code scanner and the voice note recorder (`features/requests/device-sheets.ts`).
 *
 * The same table as `web-strings.ts`, under the same rules (one leaf, three languages; `web-strings.test.ts` reads it),
 * kept apart so that none of it is in the first load nor in the request sheets' chunk, which every session fetches: most
 * gateways never ask for any of these. **Only a module that is itself loaded on demand may import this file.** The
 * words every interactive sheet shares (Later, Don't share, the upload's progress and failures) are `sheet-strings.ts`'s;
 * the names of a contact's fields and of the kinds of code are `record-strings.ts`'s.
 */
import { type Branch, localise, type Translated } from './web-strings'

/** The strings, as written: every leaf in en, nl and de. */
export const DEVICE_STRINGS_SOURCE = {
  /** Said by more than one of them. */
  common: {
    /** The browser asks for permission now, after the person pressed the button on the sheet. */
    browserMayAsk: {
      en: 'Your browser may ask for permission first.',
      nl: 'Je browser vraagt mogelijk eerst om toestemming.',
      de: 'Dein Browser fragt möglicherweise zuerst nach der Erlaubnis.'
    },
    /** For a request this browser cannot do after all (no symbology it reads, no field it can pick): the way to say so. */
    cannotDo: {
      en: 'Tell the bot this is not possible here',
      nl: 'Zeg tegen de bot dat dit hier niet kan',
      de: 'Dem Bot sagen, dass das hier nicht möglich ist'
    }
  },
  signature: {
    title: {
      en: 'A signature to give',
      nl: 'Een handtekening om te zetten',
      de: 'Eine Unterschrift zum Leisten'
    },
    receiver: {
      en: 'Hermie sends your signature to the gateway as two pictures (PNG and SVG), together with the time and a fingerprint of the text above, where the bot reads them. Hermie does not keep them.',
      nl: 'Hermie stuurt je handtekening als twee afbeeldingen (PNG en SVG) naar de gateway, samen met het tijdstip en een vingerafdruk van de tekst hierboven, waar de bot ze leest. Hermie bewaart ze niet.',
      de: 'Hermie sendet deine Unterschrift als zwei Bilder (PNG und SVG) an das Gateway, zusammen mit der Zeit und einem Fingerabdruck des Textes oben, wo der Bot sie liest. Hermie speichert sie nicht.'
    },
    /** Over the statement the person signs: it is shown whole, as it is. */
    statement: {
      en: 'What you are signing',
      nl: 'Wat je ondertekent',
      de: 'Was du unterschreibst'
    },
    signer: {
      en: 'Signing as',
      nl: 'Ondertekend door',
      de: 'Unterschrift von'
    },
    time: {
      en: 'Date and time',
      nl: 'Datum en tijd',
      de: 'Datum und Uhrzeit'
    },
    /** The accessible name of the drawing area. */
    pad: {
      en: 'Signature pad. Draw your signature with a finger, a pen or a mouse.',
      nl: 'Handtekeningvlak. Teken je handtekening met een vinger, een pen of een muis.',
      de: 'Unterschriftenfeld. Zeichne deine Unterschrift mit einem Finger, einem Stift oder einer Maus.'
    },
    hint: {
      en: 'Draw your signature in the box.',
      nl: 'Teken je handtekening in het vak.',
      de: 'Zeichne deine Unterschrift in das Feld.'
    },
    /** Said politely when the pad has ink or none. */
    drawn: {
      en: 'Signature drawn.',
      nl: 'Handtekening getekend.',
      de: 'Unterschrift gezeichnet.'
    },
    cleared: {
      en: 'Signature cleared.',
      nl: 'Handtekening gewist.',
      de: 'Unterschrift gelöscht.'
    },
    clear: {
      en: 'Clear',
      nl: 'Wissen',
      de: 'Löschen'
    },
    sign: {
      en: 'Sign and send',
      nl: 'Ondertekenen en versturen',
      de: 'Unterschreiben und senden'
    },
    preparing: {
      en: 'Preparing the signature…',
      nl: 'De handtekening wordt klaargemaakt…',
      de: 'Die Unterschrift wird vorbereitet…'
    },
    tooLong: {
      en: 'That is as much as the pad takes. Clear it to start again.',
      nl: 'Meer past er niet op het vlak. Wis het om opnieuw te beginnen.',
      de: 'Mehr passt nicht auf das Feld. Lösche es, um neu zu beginnen.'
    },
    refusedStatement: {
      en: 'The gateway says the text you signed is not the one it asked about. Nothing was signed; try again.',
      nl: 'De gateway zegt dat de tekst die je ondertekende niet de tekst is waar hij om vroeg. Er is niets ondertekend; probeer het opnieuw.',
      de: 'Das Gateway sagt, der Text, den du unterschrieben hast, ist nicht der, nach dem es gefragt hat. Es wurde nichts unterschrieben; versuch es erneut.'
    }
  },
  location: {
    title: {
      en: 'Your location, once',
      nl: 'Je locatie, één keer',
      de: 'Dein Standort, einmal'
    },
    receiver: {
      en: 'Hermie asks your browser for where you are, once, and sends it to the gateway, where the bot reads it. Hermie does not keep it and does not follow you.',
      nl: 'Hermie vraagt je browser één keer waar je bent en stuurt het naar de gateway, waar de bot het leest. Hermie bewaart het niet en volgt je niet.',
      de: 'Hermie fragt deinen Browser einmal, wo du bist, und sendet es an das Gateway, wo der Bot es liest. Hermie speichert es nicht und folgt dir nicht.'
    },
    legend: {
      en: 'How exact',
      nl: 'Hoe nauwkeurig',
      de: 'Wie genau'
    },
    approximate: {
      en: 'Approximate: your area, about a kilometre',
      nl: 'Bij benadering: je buurt, zo’n kilometer',
      de: 'Ungefähr: deine Gegend, etwa einen Kilometer'
    },
    precise: {
      en: 'Precise: where you are, to a few metres',
      nl: 'Precies: waar je bent, op een paar meter',
      de: 'Genau: wo du bist, auf wenige Meter'
    },
    /** When the bot asked for the approximate location only: it is not offered more. */
    onlyApproximate: {
      en: 'The bot asked for your approximate location only.',
      nl: 'De bot vroeg alleen om je locatie bij benadering.',
      de: 'Der Bot hat nur nach deinem ungefähren Standort gefragt.'
    },
    /** What a browser can and cannot do: it has no reduced mode, so the page rounds. */
    roundedNote: {
      en: 'The location is rounded on this page before it is sent.',
      nl: 'De locatie wordt op deze pagina afgerond voordat ze wordt verstuurd.',
      de: 'Der Standort wird auf dieser Seite gerundet, bevor er gesendet wird.'
    },
    share: {
      en: 'Share location',
      nl: 'Locatie delen',
      de: 'Standort teilen'
    },
    locating: {
      en: 'Finding your location…',
      nl: 'Je locatie wordt bepaald…',
      de: 'Dein Standort wird ermittelt…'
    },
    unavailable: {
      en: 'Your location could not be found. Try again, or give up.',
      nl: 'Je locatie kon niet worden bepaald. Probeer het opnieuw, of geef het op.',
      de: 'Dein Standort konnte nicht ermittelt werden. Versuch es erneut oder gib auf.'
    },
    retry: {
      en: 'Try again',
      nl: 'Opnieuw proberen',
      de: 'Erneut versuchen'
    },
    giveUp: {
      en: 'Give up',
      nl: 'Opgeven',
      de: 'Aufgeben'
    }
  },
  contact: {
    title: {
      en: 'A contact to share',
      nl: 'Een contact om te delen',
      de: 'Ein Kontakt zum Teilen'
    },
    receiver: {
      en: 'Hermie opens your browser’s contact picker. Only the fields you tick are sent to the gateway, where the bot reads them. Hermie does not keep them.',
      nl: 'Hermie opent de contactkiezer van je browser. Alleen de velden die je aanvinkt worden naar de gateway gestuurd, waar de bot ze leest. Hermie bewaart ze niet.',
      de: 'Hermie öffnet die Kontaktauswahl deines Browsers. Nur die Felder, die du ankreuzt, werden an das Gateway gesendet, wo der Bot sie liest. Hermie speichert sie nicht.'
    },
    asked: {
      en: ({ fields }: { fields: string }) => `The bot asks for: ${fields}.`,
      nl: ({ fields }: { fields: string }) => `De bot vraagt om: ${fields}.`,
      de: ({ fields }: { fields: string }) => `Der Bot fragt nach: ${fields}.`
    },
    /** A field a browser's picker cannot read at all (a birthday, an organisation). */
    unreadable: {
      en: ({ fields }: { fields: string }) => `This browser cannot read: ${fields}.`,
      nl: ({ fields }: { fields: string }) => `Deze browser kan niet lezen: ${fields}.`,
      de: ({ fields }: { fields: string }) => `Dieser Browser kann nicht lesen: ${fields}.`
    },
    none: {
      en: 'This browser cannot read any of the fields the bot asked for.',
      nl: 'Deze browser kan geen van de velden lezen waar de bot om vroeg.',
      de: 'Dieser Browser kann keines der Felder lesen, nach denen der Bot gefragt hat.'
    },
    choose: {
      en: 'Choose a contact',
      nl: 'Een contact kiezen',
      de: 'Einen Kontakt wählen'
    },
    chooseAnother: {
      en: 'Choose another contact',
      nl: 'Een ander contact kiezen',
      de: 'Einen anderen Kontakt wählen'
    },
    failed: {
      en: 'The contact could not be read. Try again.',
      nl: 'Het contact kon niet worden gelezen. Probeer het opnieuw.',
      de: 'Der Kontakt konnte nicht gelesen werden. Versuch es erneut.'
    },
    /** Over the ticked fields: untick what you do not want to share. */
    legend: {
      en: 'Share these fields',
      nl: 'Deze velden delen',
      de: 'Diese Felder teilen'
    },
    empty: {
      en: 'This contact has none of the fields the bot asked for. Choose another.',
      nl: 'Dit contact heeft geen van de velden waar de bot om vroeg. Kies een ander.',
      de: 'Dieser Kontakt hat keines der Felder, nach denen der Bot gefragt hat. Wähle einen anderen.'
    },
    noneTicked: {
      en: 'Tick at least one field to send.',
      nl: 'Vink minstens één veld aan om te versturen.',
      de: 'Kreuze mindestens ein Feld zum Senden an.'
    },
    send: {
      en: 'Send contact',
      nl: 'Contact versturen',
      de: 'Kontakt senden'
    },
    refusedEmpty: {
      en: 'The gateway found nothing usable in what you shared. Choose another contact, or skip.',
      nl: 'De gateway vond niets bruikbaars in wat je deelde. Kies een ander contact, of sla over.',
      de: 'Das Gateway fand nichts Brauchbares in dem, was du geteilt hast. Wähle einen anderen Kontakt oder überspringe.'
    }
  },
  scan: {
    title: {
      en: 'A code to scan',
      nl: 'Een code om te scannen',
      de: 'Ein Code zum Scannen'
    },
    receiver: {
      en: 'Hermie reads one code with your camera on this device and shows you what it says before anything is sent. The camera picture stays here. The bot receives the text of the code and nothing else; Hermie never opens it.',
      nl: 'Hermie leest één code met je camera op dit apparaat en toont je wat erop staat voordat er iets wordt verstuurd. Het camerabeeld blijft hier. De bot ontvangt de tekst van de code en niets anders; Hermie opent hem nooit.',
      de: 'Hermie liest einen Code mit deiner Kamera auf diesem Gerät und zeigt dir, was er sagt, bevor etwas gesendet wird. Das Kamerabild bleibt hier. Der Bot erhält den Text des Codes und sonst nichts; Hermie öffnet ihn nie.'
    },
    looking: {
      en: ({ kinds }: { kinds: string }) => `The bot is looking for: ${kinds}.`,
      nl: ({ kinds }: { kinds: string }) => `De bot zoekt: ${kinds}.`,
      de: ({ kinds }: { kinds: string }) => `Der Bot sucht: ${kinds}.`
    },
    lookingAny: {
      en: 'The bot is looking for any kind of code.',
      nl: 'De bot zoekt elke soort code.',
      de: 'Der Bot sucht jede Art von Code.'
    },
    unreadable: {
      en: 'This browser cannot read the kinds of code the bot asked for.',
      nl: 'Deze browser kan de soorten code waar de bot om vroeg niet lezen.',
      de: 'Dieser Browser kann die Arten von Code, nach denen der Bot gefragt hat, nicht lesen.'
    },
    start: {
      en: 'Start the camera',
      nl: 'De camera starten',
      de: 'Die Kamera starten'
    },
    starting: {
      en: 'Starting the camera…',
      nl: 'De camera wordt gestart…',
      de: 'Die Kamera wird gestartet…'
    },
    scanning: {
      en: 'Point the camera at a code.',
      nl: 'Richt de camera op een code.',
      de: 'Richte die Kamera auf einen Code.'
    },
    /** The accessible name of the live picture. */
    preview: {
      en: 'Camera picture',
      nl: 'Camerabeeld',
      de: 'Kamerabild'
    },
    failed: {
      en: 'The camera could not be started. Try again.',
      nl: 'De camera kon niet worden gestart. Probeer het opnieuw.',
      de: 'Die Kamera konnte nicht gestartet werden. Versuch es erneut.'
    },
    found: {
      en: 'Code found. Check what it says before you send it.',
      nl: 'Code gevonden. Controleer wat erop staat voordat je hem verstuurt.',
      de: 'Code gefunden. Prüfe, was er sagt, bevor du ihn sendest.'
    },
    value: {
      en: 'What the code says (it is not opened)',
      nl: 'Wat de code zegt (hij wordt niet geopend)',
      de: 'Was der Code sagt (er wird nicht geöffnet)'
    },
    kind: {
      en: ({ kind }: { kind: string }) => `Kind of code: ${kind}`,
      nl: ({ kind }: { kind: string }) => `Soort code: ${kind}`,
      de: ({ kind }: { kind: string }) => `Art des Codes: ${kind}`
    },
    rescan: {
      en: 'Scan again',
      nl: 'Opnieuw scannen',
      de: 'Erneut scannen'
    },
    send: {
      en: 'Send this code',
      nl: 'Deze code versturen',
      de: 'Diesen Code senden'
    },
    refusedEmpty: {
      en: 'The gateway found nothing readable in that code. Scan another.',
      nl: 'De gateway vond niets leesbaars in die code. Scan een andere.',
      de: 'Das Gateway fand nichts Lesbares in diesem Code. Scanne einen anderen.'
    }
  },
  voice: {
    title: {
      en: 'A voice note to record',
      nl: 'Een spraakbericht om op te nemen',
      de: 'Eine Sprachnachricht zum Aufnehmen'
    },
    receiver: {
      en: 'Hermie records on this device and lets you listen back. The recording goes to the gateway only when you press Send, where the bot reads it. No transcript is made in a browser. Hermie does not keep the recording.',
      nl: 'Hermie neemt op dit apparaat op en laat je terugluisteren. De opname gaat alleen naar de gateway als je op Versturen drukt, waar de bot hem leest. In een browser wordt geen transcript gemaakt. Hermie bewaart de opname niet.',
      de: 'Hermie nimmt auf diesem Gerät auf und lässt dich zurückhören. Die Aufnahme geht nur an das Gateway, wenn du auf Senden drückst, wo der Bot sie liest. In einem Browser wird kein Transkript erstellt. Hermie speichert die Aufnahme nicht.'
    },
    record: {
      en: 'Record',
      nl: 'Opnemen',
      de: 'Aufnehmen'
    },
    stop: {
      en: 'Stop',
      nl: 'Stoppen',
      de: 'Stopp'
    },
    again: {
      en: 'Record again',
      nl: 'Opnieuw opnemen',
      de: 'Neu aufnehmen'
    },
    recording: {
      en: ({ time }: { time: string }) => `Recording… ${time}`,
      nl: ({ time }: { time: string }) => `Aan het opnemen… ${time}`,
      de: ({ time }: { time: string }) => `Aufnahme läuft… ${time}`
    },
    ready: {
      en: ({ size }: { size: string }) => `Recording ready (${size}). Listen to it before you send it.`,
      nl: ({ size }: { size: string }) => `Opname klaar (${size}). Luister hem terug voordat je hem verstuurt.`,
      de: ({ size }: { size: string }) => `Aufnahme fertig (${size}). Hör sie dir an, bevor du sie sendest.`
    },
    /** The accessible name of the player. */
    player: {
      en: 'Your recording',
      nl: 'Je opname',
      de: 'Deine Aufnahme'
    },
    micAsk: {
      en: 'Your browser asks for the microphone after you press Record.',
      nl: 'Je browser vraagt om de microfoon nadat je op Opnemen drukt.',
      de: 'Dein Browser fragt nach dem Mikrofon, nachdem du auf Aufnehmen drückst.'
    },
    /** The microphone was refused or there is none: a file can still be chosen. */
    micFailed: {
      en: 'The microphone could not be used. You can choose an audio file instead.',
      nl: 'De microfoon kon niet worden gebruikt. Je kunt in plaats daarvan een audiobestand kiezen.',
      de: 'Das Mikrofon konnte nicht verwendet werden. Du kannst stattdessen eine Audiodatei wählen.'
    },
    recordFailed: {
      en: 'The recording failed. Try again.',
      nl: 'De opname is mislukt. Probeer het opnieuw.',
      de: 'Die Aufnahme ist fehlgeschlagen. Versuch es erneut.'
    },
    full: {
      en: 'The recording stopped: it reached the size the gateway takes.',
      nl: 'De opname is gestopt: hij heeft de grootte bereikt die de gateway aanneemt.',
      de: 'Die Aufnahme wurde beendet: Sie hat die Größe erreicht, die das Gateway annimmt.'
    },
    pickInstead: {
      en: 'Choose an audio file instead',
      nl: 'Een audiobestand kiezen',
      de: 'Stattdessen eine Audiodatei wählen'
    },
    send: {
      en: 'Send recording',
      nl: 'Opname versturen',
      de: 'Aufnahme senden'
    }
  }
} as const satisfies Branch

export type DeviceStrings = Translated<typeof DEVICE_STRINGS_SOURCE>

/** The device sheets' web-only strings in the language the reader is using. */
export const deviceStrings = localise(DEVICE_STRINGS_SOURCE) as unknown as DeviceStrings
