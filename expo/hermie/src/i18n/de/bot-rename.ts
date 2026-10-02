/**
 * `features/bot-rename/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { renameStrings } from '../../features/bot-rename/strings'
import type { Translation } from '../catalogue'

export const botRename: Translation<typeof renameStrings> = {
  displayLabel: 'Anzeigename',
  displayHint: 'Wie dieser Bot in deiner Liste heißt. Das Gateway behält den eigenen Namen des Profils.',
  clearHint: 'Leer lassen, um auf den Namen zurückzufallen, den das Gateway meldet.',
  displayAppOnly: 'Nur in Hermie gespeichert; das Plug-in auf dem Gateway ist zu alt, um es dort zu speichern.',
  displayForbidden: 'Dieses Gateway-Konto darf Profilnamen nicht ändern.',

  profileLabel: 'Profilname',
  profileHint: 'Der Name, unter dem der Rest der App diesen Bot anspricht.',

  renameRow: 'Profil umbenennen…',
  renameHint: 'Ändert das Profil auf dem Gateway selbst, nicht das, was Hermie anzeigt.',
  renameField: 'Neuer Profilname',
  renameAction: 'Profil umbenennen',
  renameBusy: 'Wird umbenannt…',
  renameCancel: 'So lassen',
  profileWarning: 'Umbenennen ändert den Profilnamen, den andere Tools verwenden',
  renameDefault: 'Das Standardprofil behält seinen Namen. Sein Zuhause ist das eigene Verzeichnis des Gateways.',

  placeholder: 'Nicht gesetzt',

  refused: 'Das Gateway hat diesen Namen nicht angenommen.',
  missing: (name: string) => `Das Gateway kennt kein Profil namens ${name}.`,
  failed: 'Dieser Name konnte nicht gespeichert werden.',
  clearRefused: 'Das Standardprofil braucht einen Namen.',
  // The parts are the accusative OBJECT here and Hermie is the subject, so one
  // part reads the same as two. A German verb agreeing with the joined list
  // would need a singular and a plural wording for the same sentence.
  partial: (parts: string[]) =>
    `Das Gateway hat diesen Bot umbenannt, aber ${parts.join(' und ')} konnte Hermie lokal nicht nachziehen. Verbinde dich neu, um das nachzuholen.`,
  partialStores: 'die offenen Chats',
  partialCache: 'das zwischengespeicherte Transkript'
}
