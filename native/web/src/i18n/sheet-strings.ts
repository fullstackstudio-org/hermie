/**
 * Strings only the web client has, that only a sheet or a page loaded as a chunk
 * of its own says: the request sheets (`features/requests/sheets.ts`, and the
 * passkey confirmation's `ConfirmSheet`) and the passkeys page
 * (`features/settings/Passkeys.tsx`).
 *
 * The same table as `web-strings.ts`, under the same rules (one leaf, three
 * languages; `web-strings.test.ts` reads both), kept apart so that none of it is
 * in the first load. **Only a module that is itself loaded on demand may import
 * this file**: one import from the entry's graph puts all of it back there
 * (`npm run client:check-bundle` would show it). A string that the entry also
 * says belongs in `web-strings.ts`.
 */
import { type Branch, localise, type Translated } from './web-strings'

/** The strings, as written: every leaf in en, nl and de. */
export const SHEET_STRINGS_SOURCE = {
  requests: {
    /** A clarify question left unanswered on purpose: the bot is told "no answer". */
    skip: {
      en: 'Skip',
      nl: 'Overslaan',
      de: 'Überspringen'
    },
    /** On an approval the gateway's own safety check refused (`smart_denied`): the reader is the override. */
    smartDenied: {
      en: 'The gateway’s own safety check refused this command. It runs only if you allow it here.',
      nl: 'De eigen veiligheidscontrole van de gateway heeft dit commando geweigerd. Het draait alleen als jij het hier toestaat.',
      de: 'Die eigene Sicherheitsprüfung des Gateways hat diesen Befehl abgelehnt. Er läuft nur, wenn du ihn hier erlaubst.'
    },
    /** Under the choices, when "Allow for this session" is one of them: what it means, apart from "Always allow". */
    sessionHint: {
      en: 'Allow for this session: this command runs without asking again until the session ends.',
      nl: 'Toestaan voor deze sessie: dit commando draait zonder opnieuw te vragen tot de sessie eindigt.',
      de: 'Für diese Sitzung erlauben: Dieser Befehl läuft ohne erneute Nachfrage, bis die Sitzung endet.'
    },
    /** The box that makes one answer apply to the other approvals waiting from the same bot. Off by default. */
    sameForAll: {
      en: ({ count, name }: { count: number; name: string }) =>
        count === 1
          ? `Give the same answer to the other approval waiting from ${name}`
          : `Give the same answer to the ${count} other approvals waiting from ${name}`,
      nl: ({ count, name }: { count: number; name: string }) =>
        count === 1
          ? `Geef hetzelfde antwoord op de andere goedkeuring die van ${name} wacht`
          : `Geef hetzelfde antwoord op de ${count} andere goedkeuringen die van ${name} wachten`,
      de: ({ count, name }: { count: number; name: string }) =>
        count === 1
          ? `Dieselbe Antwort für die andere wartende Freigabe von ${name} geben`
          : `Dieselbe Antwort für die ${count} anderen wartenden Freigaben von ${name} geben`
    },
    /** Said politely when the list a ticked box covered changed: the tick was taken back. */
    othersChanged: {
      en: ({ name }: { name: string }) =>
        `The other approvals waiting from ${name} changed, so the box was cleared. Tick it again to see and answer them together.`,
      nl: ({ name }: { name: string }) =>
        `De andere goedkeuringen die van ${name} wachten zijn veranderd, dus het vakje is leeggemaakt. Vink het opnieuw aan om ze samen te zien en te beantwoorden.`,
      de: ({ name }: { name: string }) =>
        `Die anderen wartenden Freigaben von ${name} haben sich geändert, daher wurde das Kästchen geleert. Hake es erneut an, um sie zusammen zu sehen und zu beantworten.`
    },
    /** Over the list of the other commands that answer would also cover. */
    othersLabel: {
      en: 'That answer also goes to:',
      nl: 'Dat antwoord geldt ook voor:',
      de: 'Diese Antwort gilt auch für:'
    },
    /** Ends a batch of questions without answering any of them: the bot is told the reader declined. */
    cancelAll: {
      en: 'Cancel all questions',
      nl: 'Alle vragen annuleren',
      de: 'Alle Fragen abbrechen'
    }
  },
  passkeys: {
    /** The name of the box with the confirmation's detail, shown exactly as the gateway sent it. */
    detailLabel: {
      en: 'Details',
      nl: 'Details',
      de: 'Details'
    },
    /** Copies the detail exactly as the gateway sent it (not the drawing with its whitespace markers). */
    copyDetail: {
      en: 'Copy details',
      nl: 'Details kopiëren',
      de: 'Details kopieren'
    },
    detailCopied: {
      en: 'The details were copied.',
      nl: 'De details zijn gekopieerd.',
      de: 'Die Details wurden kopiert.'
    },
    detailNotCopied: {
      en: 'The details could not be copied.',
      nl: 'De details konden niet worden gekopieerd.',
      de: 'Die Details konnten nicht kopiert werden.'
    },
    /** Under a detail too big for its box: the size of the text as the gateway sent it. */
    detailSize: {
      en: ({ lines, longest }: { lines: number; longest: number }) =>
        `${lines} ${lines === 1 ? 'line' : 'lines'} · longest line ${longest} ${longest === 1 ? 'character' : 'characters'}`,
      nl: ({ lines, longest }: { lines: number; longest: number }) =>
        `${lines} ${lines === 1 ? 'regel' : 'regels'} · langste regel ${longest} ${longest === 1 ? 'teken' : 'tekens'}`,
      de: ({ lines, longest }: { lines: number; longest: number }) =>
        `${lines} ${lines === 1 ? 'Zeile' : 'Zeilen'} · längste Zeile ${longest} Zeichen`
    },
    /** The marker line that stands for 3 or more blank lines in a row inside the detail, between `⋯`. */
    emptyLines: {
      en: ({ count }: { count: number }) => `⋯ ${count} empty lines ⋯`,
      nl: ({ count }: { count: number }) => `⋯ ${count} lege regels ⋯`,
      de: ({ count }: { count: number }) => `⋯ ${count} leere Zeilen ⋯`
    },
    /** Under the buttons while Confirm waits for the detail to be scrolled to its end. */
    scrollToConfirm: {
      en: 'Scroll to the end of the details to confirm.',
      nl: 'Scrol naar het einde van de details om te bevestigen.',
      de: 'Scrolle bis zum Ende der Details, um zu bestätigen.'
    },
    /** Which passkey the browser will ask for: the page's own host is the passkey's site. */
    rpLine: {
      en: ({ rp }: { rp: string }) => `Your browser will ask for your passkey for ${rp}.`,
      nl: ({ rp }: { rp: string }) => `Je browser vraagt om je passkey voor ${rp}.`,
      de: ({ rp }: { rp: string }) => `Dein Browser fragt nach deinem Passkey für ${rp}.`
    },
    confirm: {
      en: 'Confirm with passkey',
      nl: 'Bevestigen met passkey',
      de: 'Mit Passkey bestätigen'
    },
    decline: {
      en: 'Decline',
      nl: 'Weigeren',
      de: 'Ablehnen'
    },
    /** The countdown to the gateway's deadline, `1:42`. */
    expires: {
      en: ({ time }: { time: string }) => `Expires in ${time}`,
      nl: ({ time }: { time: string }) => `Verloopt over ${time}`,
      de: ({ time }: { time: string }) => `Läuft ab in ${time}`
    },
    /** While the browser's passkey sheet is up. */
    signing: {
      en: 'Waiting for your passkey…',
      nl: 'Wachten op je passkey…',
      de: 'Warte auf deinen Passkey…'
    },
    sending: {
      en: 'Sending…',
      nl: 'Versturen…',
      de: 'Wird gesendet…'
    },
    /** The gateway refused the assertion; the request is still open. `reason` is the contract's word. */
    refused: {
      en: ({ reason }: { reason: string }) => `The gateway did not accept this answer (${reason}). You can try again.`,
      nl: ({ reason }: { reason: string }) =>
        `De gateway nam dit antwoord niet aan (${reason}). Je kunt het opnieuw proberen.`,
      de: ({ reason }: { reason: string }) =>
        `Das Gateway hat diese Antwort nicht angenommen (${reason}). Du kannst es noch einmal versuchen.`
    },
    notSent: {
      en: ({ message }: { message: string }) => `The answer was not sent: ${message}. You can try again.`,
      nl: ({ message }: { message: string }) =>
        `Het antwoord is niet verstuurd: ${message}. Je kunt het opnieuw proberen.`,
      de: ({ message }: { message: string }) =>
        `Die Antwort wurde nicht gesendet: ${message}. Du kannst es noch einmal versuchen.`
    },
    /**
     * Instead of `notSent` once an answer carrying the passkey got no reply: it may have been delivered, so
     * nothing here may say that nothing was confirmed.
     */
    mayHaveArrived: {
      en: 'The answer may have reached the gateway. You can try again, or check whether the action ran.',
      nl: 'Het antwoord heeft de gateway misschien bereikt. Je kunt het opnieuw proberen, of nagaan of de actie is uitgevoerd.',
      de: 'Die Antwort hat das Gateway vielleicht erreicht. Du kannst es noch einmal versuchen oder prüfen, ob die Aktion ausgeführt wurde.'
    },
    /** The end of a confirmation whose answer may have arrived, without the gateway's verdict on it. */
    outcomeUnknown: {
      en: 'The answer may have reached the gateway. Check whether the action ran.',
      nl: 'Het antwoord heeft de gateway misschien bereikt. Ga na of de actie is uitgevoerd.',
      de: 'Die Antwort hat das Gateway vielleicht erreicht. Prüfe, ob die Aktion ausgeführt wurde.'
    },
    /** After `ok`: received and valid, NOT confirmed yet. */
    received: {
      en: 'Received. The gateway checks your passkey and carries on only if it holds.',
      nl: 'Ontvangen. De gateway controleert je passkey en gaat alleen verder als die klopt.',
      de: 'Empfangen. Das Gateway prüft deinen Passkey und macht nur weiter, wenn er stimmt.'
    },
    verificationFailed: {
      en: 'This confirmation did not count: the gateway could not verify it. Nothing was confirmed.',
      nl: 'Deze bevestiging telt niet: de gateway kon haar niet controleren. Er is niets bevestigd.',
      de: 'Diese Bestätigung zählt nicht: Das Gateway konnte sie nicht prüfen. Es wurde nichts bestätigt.'
    },
    tooManyAttempts: {
      en: 'Too many answers were refused. The request was closed and nothing was confirmed.',
      nl: 'Te veel antwoorden zijn geweigerd. Het verzoek is gesloten en er is niets bevestigd.',
      de: 'Zu viele Antworten wurden abgelehnt. Die Anfrage wurde geschlossen, es wurde nichts bestätigt.'
    },
    notAllowed: {
      en: 'This browser may not answer this request. Nothing was confirmed.',
      nl: 'Deze browser mag dit verzoek niet beantwoorden. Er is niets bevestigd.',
      de: 'Dieser Browser darf diese Anfrage nicht beantworten. Es wurde nichts bestätigt.'
    },
    unavailable: {
      en: ({ reason }: { reason: string }) =>
        `This browser cannot use a passkey for this request (${reason}). Nothing was confirmed.`,
      nl: ({ reason }: { reason: string }) =>
        `Deze browser kan voor dit verzoek geen passkey gebruiken (${reason}). Er is niets bevestigd.`,
      de: ({ reason }: { reason: string }) =>
        `Dieser Browser kann für diese Anfrage keinen Passkey verwenden (${reason}). Es wurde nichts bestätigt.`
    },
    settings: {
      intro: {
        en: 'A passkey lets this gateway check that it is really you before an agent does something it asked you to confirm. It stays in your browser or password manager; the gateway keeps only its public key.',
        nl: 'Met een passkey controleert deze gateway dat jij het echt bent voordat een agent iets doet wat je moest bevestigen. Hij blijft in je browser of wachtwoordbeheerder; de gateway bewaart alleen de publieke sleutel.',
        de: 'Mit einem Passkey prüft dieses Gateway, dass du es wirklich bist, bevor ein Agent etwas tut, das du bestätigen solltest. Er bleibt in deinem Browser oder Passwortmanager; das Gateway speichert nur den öffentlichen Schlüssel.'
      },
      notSupported: {
        en: 'Passkeys need this page open over HTTPS at the gateway’s own address, without a path in front, in a browser that supports them.',
        nl: 'Voor passkeys moet deze pagina via HTTPS op het eigen adres van de gateway openstaan, zonder pad ervoor, in een browser die ze ondersteunt.',
        de: 'Passkeys brauchen diese Seite über HTTPS unter der eigenen Adresse des Gateways, ohne vorangestellten Pfad, in einem Browser, der sie unterstützt.'
      },
      notOffered: {
        en: 'This gateway does not offer passkey confirmations.',
        nl: 'Deze gateway biedt geen bevestigingen met een passkey.',
        de: 'Dieses Gateway bietet keine Bestätigungen mit Passkey an.'
      },
      off: {
        en: ({ reason }: { reason: string }) => `Passkey confirmations are off on this gateway (${reason}).`,
        nl: ({ reason }: { reason: string }) => `Bevestigingen met een passkey staan uit op deze gateway (${reason}).`,
        de: ({ reason }: { reason: string }) => `Bestätigungen mit Passkey sind auf diesem Gateway aus (${reason}).`
      },
      rpNotAccepted: {
        en: ({ host }: { host: string }) =>
          `This gateway does not accept passkeys for ${host}. Ask whoever runs it to list this address.`,
        nl: ({ host }: { host: string }) =>
          `Deze gateway accepteert geen passkeys voor ${host}. Vraag wie hem beheert om dit adres toe te voegen.`,
        de: ({ host }: { host: string }) =>
          `Dieses Gateway akzeptiert keine Passkeys für ${host}. Bitte die Person, die es betreibt, diese Adresse einzutragen.`
      },
      baseUrlNotListed: {
        en: ({ host }: { host: string }) =>
          `This gateway does not list ${host} as an address for passkeys. Ask whoever runs it to add this address.`,
        nl: ({ host }: { host: string }) =>
          `Deze gateway heeft ${host} niet als adres voor passkeys in zijn lijst. Vraag wie hem beheert om dit adres toe te voegen.`,
        de: ({ host }: { host: string }) =>
          `Dieses Gateway führt ${host} nicht als Adresse für Passkeys. Bitte die Person, die es betreibt, diese Adresse einzutragen.`
      },
      /** A write the gateway refused (403 `origin_not_listed`): the page's address is not one of its passkey addresses. */
      originNotListed: {
        en: ({ host }: { host: string }) =>
          `The gateway refused this because it does not list ${host} as an address for passkeys. Ask whoever runs it to add this address.`,
        nl: ({ host }: { host: string }) =>
          `De gateway weigerde dit omdat hij ${host} niet als adres voor passkeys in zijn lijst heeft. Vraag wie hem beheert om dit adres toe te voegen.`,
        de: ({ host }: { host: string }) =>
          `Das Gateway hat das abgelehnt, weil es ${host} nicht als Adresse für Passkeys führt. Bitte die Person, die es betreibt, diese Adresse einzutragen.`
      },
      ready: {
        en: 'Passkey confirmations are on for this gateway.',
        nl: 'Bevestigingen met een passkey staan aan voor deze gateway.',
        de: 'Bestätigungen mit Passkey sind für dieses Gateway eingeschaltet.'
      },
      listTitle: {
        en: 'Your passkeys',
        nl: 'Je passkeys',
        de: 'Deine Passkeys'
      },
      empty: {
        en: 'You have no passkey on this gateway yet.',
        nl: 'Je hebt nog geen passkey op deze gateway.',
        de: 'Du hast noch keinen Passkey auf diesem Gateway.'
      },
      forSite: {
        en: ({ rp }: { rp: string }) => `For ${rp}`,
        nl: ({ rp }: { rp: string }) => `Voor ${rp}`,
        de: ({ rp }: { rp: string }) => `Für ${rp}`
      },
      added: {
        en: ({ date }: { date: string }) => `Added ${date}`,
        nl: ({ date }: { date: string }) => `Toegevoegd ${date}`,
        de: ({ date }: { date: string }) => `Hinzugefügt ${date}`
      },
      remove: {
        en: 'Remove',
        nl: 'Verwijderen',
        de: 'Entfernen'
      },
      /** The accessible name of a passkey's Remove button. */
      removeNamed: {
        en: ({ name }: { name: string }) => `Remove ${name}`,
        nl: ({ name }: { name: string }) => `${name} verwijderen`,
        de: ({ name }: { name: string }) => `${name} entfernen`
      },
      removed: {
        en: 'The passkey was removed.',
        nl: 'De passkey is verwijderd.',
        de: 'Der Passkey wurde entfernt.'
      },
      enrolTitle: {
        en: 'Add a passkey from this browser',
        nl: 'Een passkey van deze browser toevoegen',
        de: 'Einen Passkey aus diesem Browser hinzufügen'
      },
      enrolHelp: {
        en: 'You need a one-time code from whoever runs the gateway, or one you made with a passkey you already have.',
        nl: 'Je hebt een eenmalige code nodig van wie de gateway beheert, of een die je met een bestaande passkey hebt gemaakt.',
        de: 'Du brauchst einen Einmalcode von der Person, die das Gateway betreibt, oder einen, den du mit einem vorhandenen Passkey erstellt hast.'
      },
      codeLabel: {
        en: 'Enrolment code',
        nl: 'Koppelcode',
        de: 'Registrierungscode'
      },
      enrol: {
        en: 'Add a passkey',
        nl: 'Passkey toevoegen',
        de: 'Passkey hinzufügen'
      },
      enrolled: {
        en: 'The passkey was added.',
        nl: 'De passkey is toegevoegd.',
        de: 'Der Passkey wurde hinzugefügt.'
      },
      inviteTitle: {
        en: 'Add another device',
        nl: 'Nog een apparaat toevoegen',
        de: 'Ein weiteres Gerät hinzufügen'
      },
      inviteHelp: {
        en: 'Make a one-time code with a passkey of this browser, and enter it on the other device.',
        nl: 'Maak met een passkey van deze browser een eenmalige code en voer die in op het andere apparaat.',
        de: 'Erstelle mit einem Passkey dieses Browsers einen Einmalcode und gib ihn auf dem anderen Gerät ein.'
      },
      invite: {
        en: 'Make a code',
        nl: 'Code maken',
        de: 'Code erstellen'
      },
      /** Said in the live region when a code was made: the code itself is not read out. */
      inviteReady: {
        en: 'Your code is ready below.',
        nl: 'Je code staat klaar hieronder.',
        de: 'Dein Code steht unten bereit.'
      },
      inviteCodeLabel: {
        en: 'Your code',
        nl: 'Je code',
        de: 'Dein Code'
      },
      copyCode: {
        en: 'Copy the code',
        nl: 'Code kopiëren',
        de: 'Code kopieren'
      },
      codeCopied: {
        en: 'The code was copied.',
        nl: 'De code is gekopieerd.',
        de: 'Der Code wurde kopiert.'
      },
      codeNotCopied: {
        en: 'The code could not be copied. Select it and copy it by hand.',
        nl: 'De code kon niet gekopieerd worden. Selecteer hem en kopieer hem zelf.',
        de: 'Der Code konnte nicht kopiert werden. Markiere ihn und kopiere ihn von Hand.'
      },
      inviteExpires: {
        en: ({ time }: { time: string }) => `It works once, until ${time}.`,
        nl: ({ time }: { time: string }) => `Hij werkt één keer, tot ${time}.`,
        de: ({ time }: { time: string }) => `Er funktioniert einmal, bis ${time}.`
      },
      invalidCode: {
        en: 'That is not an enrolment code. It has 20 letters and digits, in groups of five.',
        nl: 'Dat is geen koppelcode. Die heeft 20 letters en cijfers, in groepjes van vijf.',
        de: 'Das ist kein Registrierungscode. Er hat 20 Buchstaben und Ziffern in Fünfergruppen.'
      },
      codeRefused: {
        en: 'The gateway did not accept that code. It may have been used or expired, or be meant for someone else.',
        nl: 'De gateway accepteerde die code niet. Misschien is hij al gebruikt of verlopen, of is hij voor iemand anders.',
        de: 'Das Gateway hat diesen Code nicht angenommen. Vielleicht wurde er schon benutzt, ist abgelaufen oder für jemand anderen.'
      },
      exists: {
        en: 'This browser already holds a passkey for this gateway.',
        nl: 'Deze browser heeft al een passkey voor deze gateway.',
        de: 'Dieser Browser hat schon einen Passkey für dieses Gateway.'
      },
      cancelled: {
        en: 'The passkey prompt was closed. Nothing changed.',
        nl: 'Het passkey-venster is gesloten. Er is niets veranderd.',
        de: 'Das Passkey-Fenster wurde geschlossen. Es hat sich nichts geändert.'
      },
      notEnrolled: {
        en: 'For that you need a passkey of this browser on this gateway.',
        nl: 'Daarvoor heb je een passkey van deze browser op deze gateway nodig.',
        de: 'Dafür brauchst du einen Passkey dieses Browsers auf diesem Gateway.'
      },
      rateLimited: {
        en: 'Too many tries. Wait a few minutes and try again.',
        nl: 'Te veel pogingen. Wacht een paar minuten en probeer het opnieuw.',
        de: 'Zu viele Versuche. Warte ein paar Minuten und versuch es noch einmal.'
      },
      rateLimitedFor: {
        en: ({ time }: { time: string }) => `Too many tries. Try again in ${time}.`,
        nl: ({ time }: { time: string }) => `Te veel pogingen. Probeer het over ${time} opnieuw.`,
        de: ({ time }: { time: string }) => `Zu viele Versuche. Versuch es in ${time} noch einmal.`
      },
      pinTitle: {
        en: 'This gateway’s identity',
        nl: 'De identiteit van deze gateway',
        de: 'Die Identität dieses Gateways'
      },
      pinHelp: {
        en: 'When you added a passkey here, this browser remembered the identity the gateway gave. If the gateway’s passkey store was reset on purpose, it presents a new one and is refused until this browser forgets the old one. Forget it only if you know the store was reset: a gateway you cannot vouch for could otherwise choose it again.',
        nl: 'Toen je hier een passkey toevoegde, onthield deze browser de identiteit die de gateway gaf. Is de passkey-opslag van de gateway met opzet gewist, dan presenteert hij een nieuwe en wordt hij geweigerd tot deze browser de oude vergeet. Vergeet hem alleen als je weet dat de opslag gewist is: een gateway waar je niet voor kunt instaan zou hem anders opnieuw kunnen kiezen.',
        de: 'Als du hier einen Passkey hinzugefügt hast, hat sich dieser Browser die Identität gemerkt, die das Gateway nannte. Wurde der Passkey-Speicher des Gateways absichtlich zurückgesetzt, meldet es sich mit einer neuen und wird abgelehnt, bis dieser Browser die alte vergisst. Vergiss sie nur, wenn du weißt, dass der Speicher zurückgesetzt wurde: Für ein Gateway, für das du nicht bürgen kannst, könnte sie sich sonst neu wählen.'
      },
      pinForget: {
        en: 'Forget this gateway’s passkey pin',
        nl: 'De passkey-pin van deze gateway vergeten',
        de: 'Den Passkey-Pin dieses Gateways vergessen'
      },
      pinConfirmQuestion: {
        en: 'Forget the identity pinned for this gateway? Passkeys of other gateways stay as they are.',
        nl: 'De vastgezette identiteit van deze gateway vergeten? Passkeys van andere gateways blijven zoals ze zijn.',
        de: 'Die für dieses Gateway gemerkte Identität vergessen? Passkeys anderer Gateways bleiben unverändert.'
      },
      pinConfirm: {
        en: 'Yes, forget it',
        nl: 'Ja, vergeet hem',
        de: 'Ja, vergessen'
      },
      pinCancel: {
        en: 'Keep it',
        nl: 'Bewaren',
        de: 'Behalten'
      },
      pinForgotten: {
        en: 'This browser forgot the gateway’s identity. The next passkey you add pins the one it presents now.',
        nl: 'Deze browser is de identiteit van de gateway vergeten. De volgende passkey die je toevoegt zet degene vast die hij nu presenteert.',
        de: 'Dieser Browser hat die Identität des Gateways vergessen. Der nächste Passkey, den du hinzufügst, merkt sich die, die es jetzt nennt.'
      },
      failed: {
        en: ({ message }: { message: string }) => `That did not work: ${message}`,
        nl: ({ message }: { message: string }) => `Dat is niet gelukt: ${message}`,
        de: ({ message }: { message: string }) => `Das hat nicht geklappt: ${message}`
      }
    }
  },
  secureInput: {
    /** The sheet's heading for a `secret`: who asks, in fixed words (the native apps'). */
    titleSecret: {
      en: ({ name }: { name: string }) => `${name} asks for a secret`,
      nl: ({ name }: { name: string }) => `${name} vraagt om een geheim`,
      de: ({ name }: { name: string }) => `${name} fragt nach einem Geheimnis`
    },
    /** The sheet's heading for a `sudo`. */
    titleSudo: {
      en: ({ name }: { name: string }) => `${name} asks for an administrator password`,
      nl: ({ name }: { name: string }) => `${name} vraagt om een beheerderswachtwoord`,
      de: ({ name }: { name: string }) => `${name} fragt nach einem Administratorpasswort`
    },
    /** The sheet's heading for a `vault.unlock_prompt`. */
    titleVaultUnlock: {
      en: ({ name }: { name: string }) => `${name} asks to unlock a password manager`,
      nl: ({ name }: { name: string }) => `${name} vraagt een wachtwoordmanager te ontgrendelen`,
      de: ({ name }: { name: string }) => `${name} möchte einen Passwortmanager entsperren`
    },
    /** The sheet's heading for a `vault.code`. */
    titleVaultCode: {
      en: ({ name }: { name: string }) => `${name} asks for a one-time code`,
      nl: ({ name }: { name: string }) => `${name} vraagt om een eenmalige code`,
      de: ({ name }: { name: string }) => `${name} fragt nach einem Einmalcode`
    },
    /** The sheet's heading for a `vault.save_login`. */
    titleVaultSaveLogin: {
      en: ({ name }: { name: string }) => `${name} asks to save a login`,
      nl: ({ name }: { name: string }) => `${name} vraagt een login te bewaren`,
      de: ({ name }: { name: string }) => `${name} möchte eine Anmeldung speichern`
    },
    /** Under the heading: which gateway asks (its host). */
    gateway: {
      en: ({ host }: { host: string }) => `On gateway ${host}`,
      nl: ({ host }: { host: string }) => `Op gateway ${host}`,
      de: ({ host }: { host: string }) => `Auf Gateway ${host}`
    },
    /** The label over the request's own words, shown as plain text: they are the bot's, not the app's. */
    quoteLabel: {
      en: 'What the request says',
      nl: 'Wat het verzoek zegt',
      de: 'Was die Anfrage sagt'
    },
    /** The label over the variable a secret is stored under, as the request names it. */
    quoteVariable: {
      en: 'Stored under this name, as the request gives it',
      nl: 'Opgeslagen onder deze naam, zoals het verzoek die geeft',
      de: 'Unter diesem Namen gespeichert, wie die Anfrage ihn angibt'
    },
    /** The label over the password manager's name, as the request gives it. */
    quoteManager: {
      en: 'Password manager, as the request names it',
      nl: 'Wachtwoordmanager, zoals het verzoek die noemt',
      de: 'Passwortmanager, wie die Anfrage ihn nennt'
    },
    /** The label over the website's name, as the request gives it. */
    quoteSite: {
      en: 'Website, as the request names it',
      nl: 'Website, zoals het verzoek die noemt',
      de: 'Website, wie die Anfrage sie nennt'
    },
    /** The label over the website's address, as the request gives it. */
    quoteOrigin: {
      en: 'Address, as the request gives it',
      nl: 'Adres, zoals het verzoek het geeft',
      de: 'Adresse, wie die Anfrage sie angibt'
    },
    /** What a sudo prompt is for. */
    sudoLead: {
      en: 'The bot wants to run this command with administrator rights on the gateway’s computer.',
      nl: 'De bot wil dit commando met beheerdersrechten uitvoeren op de computer van de gateway.',
      de: 'Der Bot möchte diesen Befehl mit Administratorrechten auf dem Rechner des Gateways ausführen.'
    },
    /** A sudo prompt that names no command. */
    sudoNoCommand: {
      en: 'The gateway did not say which command.',
      nl: 'De gateway zegt niet welk commando.',
      de: 'Das Gateway nennt den Befehl nicht.'
    },
    /** What an unlock asks for, in fixed words: the manager's name is the request's and stands in its own box. */
    vaultUnlockLead: {
      en: 'Enter the master password of this password manager.',
      nl: 'Voer het hoofdwachtwoord van deze wachtwoordmanager in.',
      de: 'Gib das Master-Passwort dieses Passwortmanagers ein.'
    },
    /** What a code is for, in fixed words: the site is the request's and stands in its own box. */
    vaultCodeLead: {
      en: 'Enter the code the website asked for.',
      nl: 'Voer de code in waar de website om vroeg.',
      de: 'Gib den Code ein, nach dem die Website gefragt hat.'
    },
    /** What a login is for, in fixed words: the site is the request's and stands in its own box. */
    vaultSaveLoginLead: {
      en: 'Save a login for this website.',
      nl: 'Bewaar een login voor deze website.',
      de: 'Speichere eine Anmeldung für diese Website.'
    },
    /** The field of a secret. */
    fieldValue: {
      en: 'Value',
      nl: 'Waarde',
      de: 'Wert'
    },
    /** The field of a sudo prompt and of a login. */
    fieldPassword: {
      en: 'Password',
      nl: 'Wachtwoord',
      de: 'Passwort'
    },
    /** The field of an unlock. */
    fieldMasterPassword: {
      en: 'Master password',
      nl: 'Hoofdwachtwoord',
      de: 'Master-Passwort'
    },
    /** The field of a one-time code. */
    fieldCode: {
      en: 'Code',
      nl: 'Code',
      de: 'Code'
    },
    /** The first field of a login. */
    fieldUsername: {
      en: 'Username',
      nl: 'Gebruikersnaam',
      de: 'Benutzername'
    },
    /** Who receives a secret, and what becomes of it. */
    receiverStored: {
      en: 'Hermie sends this to the gateway, which stores it for this bot. The bot does not see it. Hermie does not keep it.',
      nl: 'Hermie stuurt dit naar de gateway, die het voor deze bot bewaart. De bot ziet het niet. Hermie bewaart het niet.',
      de: 'Hermie sendet dies an das Gateway, das es für diesen Bot speichert. Der Bot sieht es nicht. Hermie speichert es nicht.'
    },
    /** Who receives a password or a code, and what becomes of it. */
    receiverUsed: {
      en: 'Hermie sends this to the gateway, where the bot uses it. Hermie does not keep it.',
      nl: 'Hermie stuurt dit naar de gateway, waar de bot het gebruikt. Hermie bewaart het niet.',
      de: 'Hermie sendet dies an das Gateway, wo der Bot es nutzt. Hermie speichert es nicht.'
    },
    /** Who receives a login, and what becomes of it. */
    receiverLogin: {
      en: 'Hermie sends this to the gateway, which saves it in the bot’s password vault. Hermie does not keep it.',
      nl: 'Hermie stuurt dit naar de gateway, die het in de wachtwoordkluis van de bot bewaart. Hermie bewaart het niet.',
      de: 'Hermie sendet dies an das Gateway, das es im Passworttresor des Bots speichert. Hermie speichert es nicht.'
    },
    /** Answers a secret, a password or a code. */
    send: {
      en: 'Send',
      nl: 'Versturen',
      de: 'Senden'
    },
    /** Answers a login. */
    save: {
      en: 'Save',
      nl: 'Bewaren',
      de: 'Speichern'
    },
    /** Answers with nothing: the bot is told the person skipped it. */
    skip: {
      en: 'Skip',
      nl: 'Overslaan',
      de: 'Überspringen'
    },
    /** The countdown to the gateway's deadline. */
    expiresIn: {
      en: ({ time }: { time: string }) => `Expires in ${time}`,
      nl: ({ time }: { time: string }) => `Verloopt over ${time}`,
      de: ({ time }: { time: string }) => `Läuft ab in ${time}`
    },
    /** The gateway asks again because an earlier answer never reached it. */
    earlierAnswerLost: {
      en: 'Your earlier answer did not reach the gateway. Enter it again.',
      nl: 'Je eerdere antwoord heeft de gateway niet bereikt. Voer het opnieuw in.',
      de: 'Deine frühere Antwort hat das Gateway nicht erreicht. Gib sie erneut ein.'
    },
    /** The gateway asks again because an earlier Skip never reached it. */
    earlierSkipLost: {
      en: 'You skipped this before, but the gateway did not get that. Skip again, or answer it.',
      nl: 'Je sloeg dit eerder over, maar de gateway heeft dat niet ontvangen. Sla het opnieuw over of beantwoord het.',
      de: 'Du hast das schon übersprungen, aber das Gateway hat es nicht erhalten. Überspring es erneut oder beantworte es.'
    },
    /** Send or Skip was pressed while the connection was down: nothing went out, the field keeps what was typed. */
    offline: {
      en: 'Not connected to the gateway. Nothing was sent; try again once the connection is back.',
      nl: 'Niet verbonden met de gateway. Er is niets verstuurd; probeer het opnieuw zodra de verbinding terug is.',
      de: 'Nicht mit dem Gateway verbunden. Es wurde nichts gesendet; versuch es erneut, sobald die Verbindung wieder da ist.'
    }
  },
  connections: {
    /** The sheet's heading. */
    title: {
      en: ({ name }: { name: string }) => `${name} wants to connect a service`,
      nl: ({ name }: { name: string }) => `${name} wil een dienst koppelen`,
      de: ({ name }: { name: string }) => `${name} möchte einen Dienst verbinden`
    },
    /** Under the heading: what happens, and who waits. */
    lead: {
      en: ({ host }: { host: string }) =>
        `The bot waits on ${host} until each service below is connected or skipped, or until the time runs out.`,
      nl: ({ host }: { host: string }) =>
        `De bot wacht op ${host} tot elke dienst hieronder gekoppeld of overgeslagen is, of tot de tijd om is.`,
      de: ({ host }: { host: string }) =>
        `Der Bot wartet auf ${host}, bis jeder Dienst unten verbunden oder übersprungen ist oder die Zeit abläuft.`
    },
    /** The list of services: its accessible name. */
    targets: {
      en: 'Services',
      nl: 'Diensten',
      de: 'Dienste'
    },
    /** Opens a service's authorisation page in a new tab. */
    open: {
      en: 'Authorise',
      nl: 'Autoriseren',
      de: 'Autorisieren'
    },
    /** The open button's accessible name: where it goes. */
    openLabel: {
      en: ({ name, host }: { name: string; host: string }) => `Authorise ${name} at ${host} (opens a new tab)`,
      nl: ({ name, host }: { name: string; host: string }) =>
        `${name} autoriseren op ${host} (opent een nieuw tabblad)`,
      de: ({ name, host }: { name: string; host: string }) =>
        `${name} auf ${host} autorisieren (öffnet einen neuen Tab)`
    },
    /** Beside the open button: the host the link goes to. */
    opensAt: {
      en: ({ host }: { host: string }) => `Opens ${host}`,
      nl: ({ host }: { host: string }) => `Opent ${host}`,
      de: ({ host }: { host: string }) => `Öffnet ${host}`
    },
    /** Once the person opened the link from here. */
    opened: {
      en: 'Opened. Finish there; this sheet follows when the service is connected.',
      nl: 'Geopend. Rond het daar af; dit venster volgt zodra de dienst gekoppeld is.',
      de: 'Geöffnet. Schließe es dort ab; dieses Fenster folgt, sobald der Dienst verbunden ist.'
    },
    /** The gateway sent a link the page does not open. */
    linkRefused: {
      en: 'The gateway sent a link Hermie does not open: only https links to a named host are opened.',
      nl: 'De gateway stuurde een link die Hermie niet opent: alleen https-links naar een benoemde host worden geopend.',
      de: 'Das Gateway hat einen Link gesendet, den Hermie nicht öffnet: Nur https-Links zu einem benannten Host werden geöffnet.'
    },
    /** The label over the gateway's own instructions for a row. */
    instructions: {
      en: 'What the gateway says',
      nl: 'Wat de gateway zegt',
      de: 'Was das Gateway sagt'
    },
    /** Skips one service. */
    skip: {
      en: 'Not now',
      nl: 'Niet nu',
      de: 'Nicht jetzt'
    },
    /** The skip button's accessible name. */
    skipLabel: {
      en: ({ name }: { name: string }) => `Not now: ${name}`,
      nl: ({ name }: { name: string }) => `Niet nu: ${name}`,
      de: ({ name }: { name: string }) => `Nicht jetzt: ${name}`
    },
    /** Ends the whole operation now, so the bot stops waiting. */
    cancel: {
      en: 'Stop waiting',
      nl: 'Stop met wachten',
      de: 'Nicht mehr warten'
    },
    /** The countdown to the gateway's deadline. */
    timeLeft: {
      en: ({ time }: { time: string }) => `Time left: ${time}`,
      nl: ({ time }: { time: string }) => `Resterende tijd: ${time}`,
      de: ({ time }: { time: string }) => `Verbleibende Zeit: ${time}`
    },
    /** While an answer goes out. */
    sending: {
      en: 'Sending…',
      nl: 'Versturen…',
      de: 'Wird gesendet…'
    },
    /** An answer that did not go out. */
    failed: {
      en: ({ message }: { message: string }) => `That did not reach the gateway: ${message}`,
      nl: ({ message }: { message: string }) => `Dat kwam niet aan bij de gateway: ${message}`,
      de: ({ message }: { message: string }) => `Das kam nicht beim Gateway an: ${message}`
    },
    state: {
      pending: {
        en: 'Waiting for you',
        nl: 'Wacht op jou',
        de: 'Wartet auf dich'
      },
      initiated: {
        en: 'Started, waiting for the service',
        nl: 'Gestart, wacht op de dienst',
        de: 'Gestartet, wartet auf den Dienst'
      },
      connected: {
        en: 'Connected',
        nl: 'Gekoppeld',
        de: 'Verbunden'
      },
      skipped: {
        en: 'Skipped',
        nl: 'Overgeslagen',
        de: 'Übersprungen'
      },
      failed: {
        en: 'Failed',
        nl: 'Mislukt',
        de: 'Fehlgeschlagen'
      },
      expired: {
        en: 'Expired',
        nl: 'Verlopen',
        de: 'Abgelaufen'
      },
      unavailable: {
        en: 'Not available',
        nl: 'Niet beschikbaar',
        de: 'Nicht verfügbar'
      },
      notConnected: {
        en: 'Not connected',
        nl: 'Niet gekoppeld',
        de: 'Nicht verbunden'
      },
      /** A state this build has no word for: the gateway's own, cleaned. */
      other: {
        en: ({ status }: { status: string }) => `State: ${status}`,
        nl: ({ status }: { status: string }) => `Status: ${status}`,
        de: ({ status }: { status: string }) => `Status: ${status}`
      }
    }
  },
  mcp: {
    settings: {
      intro: {
        en: 'MCP lets an AI agent, such as a coding assistant, work on this gateway as you. You allow each client once; it then acts with your access, and what it sends is marked as sent by an agent. Hermie only shows the endpoint and the clients here and lets you revoke them; the gateway runs the endpoint.',
        nl: 'Met MCP kan een AI-agent, zoals een codeerassistent, als jij op deze gateway werken. Je geeft elke client één keer toestemming; daarna werkt hij met jouw toegang en wat hij verstuurt wordt gemarkeerd als verstuurd door een agent. Hermie toont hier alleen het endpoint en de clients en laat je ze intrekken; de gateway draait het endpoint zelf.',
        de: 'Mit MCP kann ein KI-Agent, etwa ein Coding-Assistent, als du auf diesem Gateway arbeiten. Du erlaubst jeden Client einmal; danach handelt er mit deinem Zugriff, und was er sendet, wird als von einem Agenten gesendet markiert. Hermie zeigt hier nur den Endpunkt und die Clients und lässt dich sie widerrufen; das Gateway betreibt den Endpunkt selbst.'
      },
      loading: {
        en: 'Reading MCP access…',
        nl: 'MCP-toegang wordt gelezen…',
        de: 'MCP-Zugriff wird gelesen…'
      },
      notOffered: {
        en: 'This gateway does not offer MCP.',
        nl: 'Deze gateway biedt geen MCP aan.',
        de: 'Dieses Gateway bietet kein MCP an.'
      },
      signIn: {
        en: 'MCP access is per person, and this gateway does not know who you are. Sign in with your account to see it.',
        nl: 'MCP-toegang is per persoon en deze gateway weet niet wie je bent. Log in met je account om het te zien.',
        de: 'Der MCP-Zugriff gilt pro Person, und dieses Gateway weiß nicht, wer du bist. Melde dich mit deinem Konto an, um ihn zu sehen.'
      },
      failed: {
        en: ({ message }: { message: string }) => `MCP access could not be read: ${message}`,
        nl: ({ message }: { message: string }) => `MCP-toegang kon niet gelezen worden: ${message}`,
        de: ({ message }: { message: string }) => `Der MCP-Zugriff konnte nicht gelesen werden: ${message}`
      },
      retry: {
        en: 'Try again',
        nl: 'Opnieuw proberen',
        de: 'Erneut versuchen'
      },
      on: {
        en: 'MCP is on for this gateway.',
        nl: 'MCP staat aan voor deze gateway.',
        de: 'MCP ist für dieses Gateway eingeschaltet.'
      },
      endpointTitle: {
        en: 'Endpoint address',
        nl: 'Adres van het endpoint',
        de: 'Adresse des Endpunkts'
      },
      commandTitle: {
        en: 'Add it to a client',
        nl: 'Aan een client toevoegen',
        de: 'Zu einem Client hinzufügen'
      },
      commandHelp: {
        en: 'Run this command in a terminal to add the endpoint to an MCP client that supports it. Hermie shows it and copies it; it never runs it.',
        nl: 'Voer dit commando uit in een terminal om het endpoint toe te voegen aan een MCP-client die dat ondersteunt. Hermie toont en kopieert het alleen en voert het nooit uit.',
        de: 'Führe diesen Befehl in einem Terminal aus, um den Endpunkt zu einem MCP-Client hinzuzufügen, der das unterstützt. Hermie zeigt und kopiert ihn nur und führt ihn nie aus.'
      },
      configTitle: {
        en: 'Or use a config file',
        nl: 'Of gebruik een configuratiebestand',
        de: 'Oder eine Konfigurationsdatei verwenden'
      },
      configHelp: {
        en: 'The same entry as JSON, for a client that reads its servers from a file.',
        nl: 'Hetzelfde item als JSON, voor een client die zijn servers uit een bestand leest.',
        de: 'Derselbe Eintrag als JSON, für einen Client, der seine Server aus einer Datei liest.'
      },
      instructionsTitle: {
        en: 'From the gateway',
        nl: 'Van de gateway',
        de: 'Vom Gateway'
      },
      copy: {
        en: 'Copy',
        nl: 'Kopiëren',
        de: 'Kopieren'
      },
      copyEndpoint: {
        en: 'Copy the endpoint address',
        nl: 'Het adres van het endpoint kopiëren',
        de: 'Die Adresse des Endpunkts kopieren'
      },
      copyCommand: {
        en: 'Copy the add command',
        nl: 'Het toevoegcommando kopiëren',
        de: 'Den Hinzufügen-Befehl kopieren'
      },
      copyConfig: {
        en: 'Copy the JSON config',
        nl: 'De JSON-configuratie kopiëren',
        de: 'Die JSON-Konfiguration kopieren'
      },
      copied: {
        en: 'Copied.',
        nl: 'Gekopieerd.',
        de: 'Kopiert.'
      },
      notCopied: {
        en: 'This browser did not allow copying. Select the text and copy it yourself.',
        nl: 'Deze browser stond kopiëren niet toe. Selecteer de tekst en kopieer hem zelf.',
        de: 'Dieser Browser hat das Kopieren nicht erlaubt. Markiere den Text und kopiere ihn selbst.'
      },
      clientsTitle: {
        en: 'Connected clients',
        nl: 'Verbonden clients',
        de: 'Verbundene Clients'
      },
      empty: {
        en: 'No client is connected yet.',
        nl: 'Er is nog geen client verbonden.',
        de: 'Es ist noch kein Client verbunden.'
      },
      unnamed: {
        en: 'Unnamed client',
        nl: 'Client zonder naam',
        de: 'Unbenannter Client'
      },
      allowed: {
        en: ({ date }: { date: string }) => `Allowed ${date}`,
        nl: ({ date }: { date: string }) => `Toegestaan ${date}`,
        de: ({ date }: { date: string }) => `Erlaubt ${date}`
      },
      allowedFrom: {
        en: ({ date, address }: { date: string; address: string }) => `Allowed ${date} from ${address}`,
        nl: ({ date, address }: { date: string; address: string }) => `Toegestaan ${date} vanaf ${address}`,
        de: ({ date, address }: { date: string; address: string }) => `Erlaubt ${date} von ${address}`
      },
      lastUsed: {
        en: ({ date }: { date: string }) => `Last used ${date}`,
        nl: ({ date }: { date: string }) => `Laatst gebruikt ${date}`,
        de: ({ date }: { date: string }) => `Zuletzt verwendet ${date}`
      },
      lastUsedFrom: {
        en: ({ date, address }: { date: string; address: string }) => `Last used ${date} from ${address}`,
        nl: ({ date, address }: { date: string; address: string }) => `Laatst gebruikt ${date} vanaf ${address}`,
        de: ({ date, address }: { date: string; address: string }) => `Zuletzt verwendet ${date} von ${address}`
      },
      neverUsed: {
        en: 'Never used',
        nl: 'Nog niet gebruikt',
        de: 'Noch nie verwendet'
      },
      expires: {
        en: ({ date }: { date: string }) => `Allowed until ${date}`,
        nl: ({ date }: { date: string }) => `Toegestaan tot ${date}`,
        de: ({ date }: { date: string }) => `Erlaubt bis ${date}`
      },
      revoke: {
        en: 'Revoke',
        nl: 'Intrekken',
        de: 'Widerrufen'
      },
      /** The accessible name of a client's Revoke button, and of the confirming one. */
      revokeNamed: {
        en: ({ name }: { name: string }) => `Revoke ${name}`,
        nl: ({ name }: { name: string }) => `${name} intrekken`,
        de: ({ name }: { name: string }) => `${name} widerrufen`
      },
      revokeQuestion: {
        en: ({ name }: { name: string }) =>
          `Revoke ${name}? It stops working at once and has to ask for your permission again.`,
        nl: ({ name }: { name: string }) =>
          `${name} intrekken? Het werkt direct niet meer en moet opnieuw om je toestemming vragen.`,
        de: ({ name }: { name: string }) =>
          `${name} widerrufen? Er funktioniert sofort nicht mehr und muss erneut um deine Erlaubnis bitten.`
      },
      cancel: {
        en: 'Cancel',
        nl: 'Annuleren',
        de: 'Abbrechen'
      },
      revoked: {
        en: ({ name }: { name: string }) => `${name} was revoked.`,
        nl: ({ name }: { name: string }) => `${name} is ingetrokken.`,
        de: ({ name }: { name: string }) => `${name} wurde widerrufen.`
      },
      gone: {
        en: 'That client was already gone. The list is up to date.',
        nl: 'Die client was al weg. De lijst is bijgewerkt.',
        de: 'Dieser Client war schon weg. Die Liste ist aktuell.'
      },
      revokeFailed: {
        en: ({ message }: { message: string }) => `Could not revoke: ${message}`,
        nl: ({ message }: { message: string }) => `Intrekken is niet gelukt: ${message}`,
        de: ({ message }: { message: string }) => `Widerrufen hat nicht geklappt: ${message}`
      },
      /** A write the gateway refused (403 `origin_not_listed`): it does not list this page's address. */
      originNotListed: {
        en: ({ host }: { host: string }) =>
          `The gateway refused this because it does not list ${host} as an address of this page. Ask whoever runs it to add this address.`,
        nl: ({ host }: { host: string }) =>
          `De gateway weigerde dit omdat hij ${host} niet als adres van deze pagina in zijn lijst heeft. Vraag wie hem beheert om dit adres toe te voegen.`,
        de: ({ host }: { host: string }) =>
          `Das Gateway hat das abgelehnt, weil es ${host} nicht als Adresse dieser Seite führt. Bitte die Person, die es betreibt, diese Adresse einzutragen.`
      },
      /** Another tab, the app or the operator allowed a client. */
      changedGranted: {
        en: ({ name }: { name: string }) => `${name} was allowed.`,
        nl: ({ name }: { name: string }) => `${name} is toegestaan.`,
        de: ({ name }: { name: string }) => `${name} wurde erlaubt.`
      },
      /** The gateway said something changed and this build has no word for it. */
      changedOther: {
        en: 'The list of clients changed.',
        nl: 'De lijst met clients is gewijzigd.',
        de: 'Die Liste der Clients hat sich geändert.'
      }
    }
  }
} as const satisfies Branch

export type SheetStrings = Translated<typeof SHEET_STRINGS_SOURCE>

/** The sheets' web-only strings in the language the reader is using. */
export const sheetStrings = localise(SHEET_STRINGS_SOURCE) as unknown as SheetStrings
