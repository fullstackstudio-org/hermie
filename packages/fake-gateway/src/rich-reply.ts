/**
 * A reply that uses everything a Hermie client draws in an answer, reached with a prompt containing `rich answer`:
 * links (a web one, a mail one), a callout of each kind, a `hermie-cards` stack and grid, a `hermie-chart`, and the
 * pages it used (`sources: 'guide'`, `sources.ts`). For looking at the clients, not for asserting on them: the
 * blocks are the contract's (`contract/markup/`), so a client that cannot draw one shows the listing.
 */

const CARDS_STACK = JSON.stringify(
  {
    title: 'Hoe ik het zou opzetten',
    layout: 'stack',
    connector: 'arrow',
    cards: [
      {
        icon: 'server',
        title: 'Gateway per klant',
        subtitle: 'k3s, eigen Postgres',
        tags: ['k3s', 'Postgres'],
        highlight: true,
        next: 'deployt naar'
      },
      { icon: 'globe', title: 'Website', subtitle: 'Next.js standalone', tags: ['Next.js'], next: 'stuurt mail via' },
      { icon: 'mail', title: 'Mailbox', subtitle: 'no-reply op het eigen domein' }
    ]
  },
  null,
  2
)

const CARDS_GRID = JSON.stringify(
  {
    layout: 'grid',
    cards: [
      { icon: 'lock', title: 'Inloggen', subtitle: 'Passkey of wachtwoord' },
      { icon: 'chart', title: 'Rapporten', subtitle: 'Per week', highlight: true },
      { icon: 'bell', title: 'Meldingen', tags: ['push', 'mail'] },
      { icon: 'gear', title: 'Instellingen' }
    ]
  },
  null,
  2
)

const CHART = JSON.stringify(
  {
    type: 'bar',
    title: 'Omzet per kwartaal',
    unit: 'EUR',
    x: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [
      { name: '2025', values: [12, 15.5, 9, 18] },
      { name: '2026', values: [14, 17, 13, 21] }
    ]
  },
  null,
  2
)

/** The opening of the reply: links, a callout and the stack of cards. Reached alone with `rich cards`. */
export const RICH_CARDS_DELTAS: string[] = [
  'Hier is het plan, met de [handleiding](https://example.org/guide/install) erbij. ',
  'Vragen? Mail naar [ons](mailto:hallo@example.org).\n\n',
  '> [!TIP]\n> Begin met de gateway; de rest volgt vanzelf.\n\n',
  '```hermie-cards\n',
  CARDS_STACK,
  '\n```\n\n'
]

/** The grid of cards, and a listing 200 columns wide (a code block scrolls sideways). Reached with `rich grid`. */
export const RICH_GRID_DELTAS: string[] = [
  'Als overzicht van de onderdelen:\n\n',
  '```hermie-cards\n',
  CARDS_GRID,
  '\n```\n\n',
  'En een lange regel code:\n\n',
  '```text\n',
  `${'0123456789'.repeat(20)}\n`,
  '```\n\n',
  'Een lijst die lang genoeg is om te scrollen:\n\n',
  '1. een\n2. twee\n3. drie\n4. vier\n5. vijf\n6. zes\n\n'
]

export const RICH_REPLY_DELTAS: string[] = [
  ...RICH_CARDS_DELTAS,
  ...RICH_GRID_DELTAS,
  '```hermie-chart\n',
  CHART,
  '\n```\n\n',
  '> [!NOTE]\n> De bedragen zijn afgerond.\n\n',
  '> [!IMPORTANT]\n> Maak eerst een back-up.\n\n',
  '> [!WARNING]\n> Dit kan niet ongedaan worden gemaakt.\n\n',
  '> [!CAUTION]\n> Gegevens kunnen verloren gaan.\n\n',
  'Een gewone quote blijft een quote:\n\n> Wie goed doet, goed ontmoet.\n'
]
