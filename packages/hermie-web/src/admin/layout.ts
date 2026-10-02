/**
 * The chrome every administration page sits in: the head, the mark, the nav,
 * the cards and the footer.
 *
 * `/admin` used to be one document with seven panels stacked down it, and the
 * cost of that was not only length. Every panel was a settings form, so the page
 * had seven submit buttons and no way to tell which of them the notice at the
 * top belonged to; the spacing came from whichever margin happened to collapse;
 * and an operator looking for one switch read the whole thing. It is a set of
 * pages now, one subject each, with a nav that says where they are.
 *
 * ## One style sheet, and no script at all
 *
 * The rules `page.ts` has always kept still hold, and the shared chrome is what
 * makes them cheap to keep: no script anywhere, every control a form that posts
 * and redirects, a double-submit CSRF token checked before the body is read,
 * nothing secret rendered, and every value escaped through the one `escapeHtml`.
 *
 * ## Why the design language is copied rather than imported
 *
 * The colours are Hermie's own — the Blue preset's elevation ladder and the ink
 * that `npm run contrast:check` measures, from `expo/hermie/src/ui/tokens.ts` —
 * and they are written out here as literals. This package imports nothing but
 * `node:` builtins (ADR-0015): the released artefact is a self-contained
 * CommonJS `dist/server` with no `node_modules` beside it, so reaching into the
 * app's TypeScript is not available at any price. The two can drift, and the
 * honest mitigation is that these are the same hex values with a comment saying
 * where they came from, not a claim that they cannot.
 *
 * Light and dark both come from `prefers-color-scheme`. There is no theme
 * switch, because a switch needs somewhere to keep the answer and this page has
 * no script and sets no cookie it does not have to.
 *
 * **No gradients**, per the design board's first rule. The one place the source
 * artwork has one is the app icon's backdrop, and the mark below is drawn on a
 * flat brand blue instead.
 */
import { escapeHtml } from '../setup'
import { htmlLang, type WebLocale, type WebStrings } from '../i18n'
import { CSRF_FIELD } from './session'

/** Which page is open, so the nav can say so and the title can match. */
export type AdminSection = 'overview' | 'people' | 'push' | 'cache' | 'branding' | 'features' | 'identity' | 'danger'

/** Where each section lives. The POST routes are unchanged and are not these. */
export const ADMIN_SECTION_PATHS: Record<AdminSection, string> = {
  overview: '/admin',
  people: '/admin/people',
  push: '/admin/push',
  cache: '/admin/cache',
  branding: '/admin/branding',
  features: '/admin/features',
  identity: '/admin/oidc',
  danger: '/admin/danger'
}

/**
 * The Hermie mark, inlined.
 *
 * `design/icon.svg` is the source and this is its `#mark` on a flat backdrop.
 * Inlined rather than served, because a page an operator reaches when something
 * is already wrong must not depend on a second request succeeding — the same
 * reason there is no script and no font here.
 *
 * The backdrop is the accent fill from `tokens.ts` rather than the icon's own
 * vertical gradient: these pages carry no gradients.
 *
 * Sized rather than fixed at 28px: the thin dashboard header wants it small,
 * and the sign-in family's hero wants it big enough to carry the page on its
 * own — the same mark, the same corner radius ratio, at whatever size the
 * caller needs. `class="mark"` stays literal either way; a test greps for it.
 */
const mark = (size: number): string =>
  `<svg class="mark" viewBox="0 0 1024 1024" width="${size}" height="${size}" aria-hidden="true" focusable="false">
  <rect x="0" y="0" width="1024" height="1024" rx="224" fill="#1668E3"/>
  <path d="M 424 656 C 420 732 358 790 222 818 C 288 752 306 700 304 644 Z" fill="#FFFFFF"/>
  <rect x="168" y="216" width="688" height="464" rx="140" fill="#FFFFFF"/>
  <rect x="336" y="300" width="96" height="296" rx="24" fill="#1668E3"/>
  <rect x="592" y="300" width="96" height="296" rx="24" fill="#1668E3"/>
  <path d="M 336 434 C 452 434 562 396 688 366 L 688 438 C 562 468 452 522 336 522 Z" fill="#1668E3"/>
</svg>`

/**
 * The whole style sheet, once.
 *
 * Read it as four blocks: the tokens, the shell, the type, and the controls.
 * Every colour is a token so the dark half is one `@media` block rather than a
 * second copy of the sheet, and every gap is a step of the app's own 4pt scale
 * so two cards on two pages are the same distance apart.
 */
/**
 * Exported only so a test can grep it. `barePage` is what actually ships it,
 * inline in a `<style>` tag on every administration page — there is no build
 * step here to import a stylesheet through, so the CSS most worth pinning
 * (the roster row's overlap guards below) is pinned by asserting on this
 * string directly. See `layout.test.ts`.
 */
export const STYLE = `
  :root {
    color-scheme: light dark;
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 20px; --s6: 24px; --s8: 32px;
    --r-card: 18px; --r-inset: 12px; --r-pill: 999px; --r-sheet: 28px;
    /*
      What the interface is set in, once. Every "font" shorthand below ends in
      this rather than repeating the stack, because a shorthand that ends in
      "inherit" instead is invalid CSS the moment it also sets a size or a
      weight — see the note on "body" below — and twelve copies of the literal
      stack were twelve places the next change to it could miss one.
    */
    --ui-font: -apple-system, "SF Pro Text", system-ui, sans-serif;
    /* Blue, light: the elevation ladder from expo/hermie/src/ui/themes.ts. */
    --bg: #eaf3ff;
    --panel: #f4f8fe;
    --card: #ffffff;
    --sunk: #dce8fb;
    --ink: #12151c;
    --muted: #4b5462;
    --faint: #586171;
    --accent: #1668e3;
    --accent-ink: #0b57c4;
    --accent-soft: rgba(22, 104, 227, 0.12);
    --on-accent: #ffffff;
    --danger: #c0293a;
    --danger-ink: #a81f30;
    --danger-soft: rgba(192, 41, 58, 0.1);
    --ok-ink: #116038;
    --warn-ink: #865600;
    --hair: rgba(16, 38, 78, 0.13);
    --hair-soft: rgba(16, 38, 78, 0.08);
    /*
      The two greys a switch is drawn from, and why they are not --hair.

      A hairline between two cards may be barely there; the edge of a CONTROL
      may not. These clear 3:1 on the card and on the panel, which is the floor
      the guidelines put on the boundary of something you can operate — 4.16
      and 4.69 respectively, measured the same way "npm run contrast:check"
      measures the app.
    */
    --switch-line: #737d8d;
    --switch-knob: #5d6675;
    /*
      The sign-in family's glass sheet, and the specular edge on it.

      design/liquid-glass-tokens.md's own first rule ("no gradients,
      anywhere") is what turns "glassSheet"'s two-stop wash into one flat
      alpha — the thinner of the two stops the doc still lists, which is the
      one already checked against --ink. --edge-* draws the same doc's "Edge
      highlights": three inset lines, never a blurred fourth.
    */
    --glass-sheet: rgba(255, 255, 255, 0.72);
    --edge-hi: rgba(255, 255, 255, 0.92);
    --edge-lo: rgba(255, 255, 255, 0.4);
    --edge-ring: rgba(255, 255, 255, 0.3);
    --auth-shadow: 0 30px 64px -22px rgba(14, 40, 86, 0.4), 0 10px 26px -14px rgba(14, 40, 86, 0.28);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a1830;
      --panel: #1c2a45;
      --card: #2f4066;
      --sunk: rgba(6, 12, 24, 0.44);
      --ink: #f3f6fb;
      --muted: #c8d2e0;
      --faint: #cbd5e4;
      --accent: #2c7bea;
      --accent-ink: #b4d6ff;
      --accent-soft: rgba(90, 164, 255, 0.18);
      --danger: #d8465a;
      --danger-ink: #ffc2cd;
      --danger-soft: rgba(255, 120, 135, 0.16);
      --ok-ink: #8fe3b0;
      --warn-ink: #ffcb61;
      --hair: rgba(190, 212, 255, 0.22);
      --hair-soft: rgba(190, 212, 255, 0.13);
      --switch-line: #93a3bd;
      --switch-knob: #c2cee2;
      /* glassSheet, dark: #334670 at 0.92 (§1.4), the panel shadow in black (§2). */
      --glass-sheet: rgba(51, 70, 112, 0.92);
      --edge-hi: rgba(255, 255, 255, 0.34);
      --edge-lo: rgba(255, 255, 255, 0.1);
      --edge-ring: rgba(255, 255, 255, 0.12);
      --auth-shadow: 0 30px 64px -22px rgba(0, 0, 0, 0.72), 0 10px 26px -14px rgba(0, 0, 0, 0.5);
    }
  }

  * { box-sizing: border-box }
  body {
    font: 400 16px/1.55 var(--ui-font);
    margin: 0;
    background: var(--bg);
    color: var(--ink);
  }

  /* ---- the shell ---- */
  .top {
    display: flex;
    align-items: center;
    gap: var(--s3);
    flex-wrap: wrap;
    padding: var(--s4) var(--s5);
    border-bottom: 1px solid var(--hair);
    background: var(--panel);
  }
  .brand { display: flex; align-items: center; gap: var(--s2); text-decoration: none; color: inherit }
  .brand-name { font: 600 17px/22px var(--ui-font); letter-spacing: -0.01em }
  .mark { display: block; border-radius: var(--s2) }
  .where { color: var(--muted); font-size: 0.9rem; margin-left: auto }

  .shell {
    display: grid;
    grid-template-columns: 13rem minmax(0, 1fr);
    gap: var(--s6);
    align-items: start;
    max-width: 68rem;
    margin: 0 auto;
    padding: var(--s6) var(--s5) var(--s8);
  }
  nav { display: flex; flex-direction: column; gap: var(--s1); position: sticky; top: var(--s6) }
  nav a {
    display: block;
    padding: var(--s2) var(--s3);
    border-radius: var(--r-inset);
    text-decoration: none;
    color: var(--muted);
    font-size: 0.95rem;
    white-space: nowrap;
  }
  nav a:hover { background: var(--hair-soft); color: var(--ink) }
  nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600 }
  main { min-width: 0 }

  footer {
    border-top: 1px solid var(--hair);
    background: var(--panel);
    padding: var(--s4) var(--s5);
  }
  .footer-inner {
    max-width: 68rem;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: var(--s4);
    flex-wrap: wrap;
  }
  .footer-inner form { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; margin: 0 0 0 auto }

  /* ---- type ---- */
  h1 { font: 700 26px/30px var(--ui-font); letter-spacing: -0.022em; margin: 0 0 var(--s2) }
  h2 { font: 600 17px/22px var(--ui-font); margin: 0 0 var(--s2) }
  p { color: var(--muted); margin: 0 0 var(--s4) }
  p:last-child { margin-bottom: 0 }
  .lede { margin-bottom: var(--s5) }
  .note { font-size: 0.85rem }
  .bad { color: var(--danger-ink) }
  .ok { color: var(--ok-ink) }
  .warn { color: var(--warn-ink) }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.875em; word-break: break-word }
  pre {
    background: var(--sunk);
    border: 1px solid var(--hair-soft);
    border-radius: var(--r-inset);
    padding: var(--s3);
    overflow-x: auto;
    font-size: 0.85rem;
    margin: 0 0 var(--s4);
  }
  a { color: var(--accent-ink) }

  /* ---- cards ---- */
  .card {
    background: var(--card);
    border: 1px solid var(--hair);
    border-radius: var(--r-card);
    padding: var(--s5);
    margin: 0 0 var(--s4);
  }
  .card > :last-child { margin-bottom: 0 }
  .card.danger { border-color: var(--danger); background: var(--danger-soft) }
  .banner {
    border-radius: var(--r-inset);
    padding: var(--s3) var(--s4);
    margin: 0 0 var(--s4);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .banner.bad { background: var(--danger-soft); color: var(--danger-ink) }

  /* ---- facts and tables ---- */
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s1) var(--s4); margin: 0 0 var(--s4); font-size: 0.9rem }
  dt { color: var(--muted) }
  dd { margin: 0 }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin: 0 0 var(--s4) }
  caption { text-align: left; color: var(--muted); font-size: 0.85rem; padding-bottom: var(--s2) }
  th, td { text-align: left; padding: var(--s2) var(--s2) var(--s2) 0; border-bottom: 1px solid var(--hair-soft); vertical-align: top }
  th { color: var(--muted); font: 600 0.85rem/1.4 var(--ui-font) }
  /* A count is compared with the count above it, so counts line up on the right. */
  th.num, td.num { text-align: right; padding-right: 0; font-variant-numeric: tabular-nums }
  /* A column of checkboxes reads as a column, so the box sits under its header. */
  th.tick, td.tick { text-align: center; padding-right: var(--s2); width: 1%; white-space: nowrap }
  tr:last-child td { border-bottom: 0 }
  /*
    A name for a screen reader where the column header is the visible one.
    The ordinary clip-rect recipe: it must stay in the accessibility tree, so
    neither display:none nor visibility:hidden will do.
  */
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* ---- controls ---- */
  label { display: block; font-size: 0.85rem; color: var(--muted); margin: 0 0 var(--s1) }
  label.check { display: flex; align-items: center; gap: var(--s2); color: var(--ink); font-size: 0.95rem; margin-bottom: var(--s2) }
  input[type="text"], input[type="password"], input[type="number"], input[type="email"], select, textarea {
    width: 100%;
    font: inherit;
    padding: var(--s2) var(--s3);
    border: 1px solid var(--hair);
    border-radius: var(--r-inset);
    background: var(--sunk);
    color: inherit;
  }
  button {
    font: 600 0.95rem/1.2 var(--ui-font);
    padding: var(--s3) var(--s5);
    border: 0;
    border-radius: var(--r-pill);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  button:disabled { opacity: 0.45; cursor: default }
  button.quiet { background: transparent; color: var(--accent-ink); border: 1px solid var(--hair) }
  /*
    The colour is restated, and it has to be.

    .bad is also the utility that paints a line of text in the danger ink, and
    on a button that rule beats the element rule it would otherwise inherit
    white from — a single class outranks a bare element. The result was the
    destructive button's own label in dark red ON dark red: legible to nobody,
    and invisible to the contrast check, which reads the app's tokens and not this
    file.
  */
  button.bad { background: var(--danger); color: var(--on-accent) }
  /* The one indication a keyboard gets, since nothing here is hovered into. */
  :focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 2px }

  .fields { display: flex; gap: var(--s3); align-items: flex-end; flex-wrap: wrap; margin: 0 0 var(--s3) }
  .fields > div { flex: 1 1 10rem; min-width: 0 }
  .fields > div.narrow { flex: 0 0 auto }
  .actions { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; margin-top: var(--s3) }
  /* The enrolment page's numbered steps and its one-time recovery codes. */
  ol, ul { color: var(--muted); padding-left: 1.2rem; font-size: 0.9rem; margin: 0 0 var(--s4) }
  li { margin-bottom: var(--s1) }
  .codes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s1);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.9rem;
  }
  /*
    A pill says something about the line it is on. It does not shout it.

    The first version of these was uppercase, letter-spaced and accent-filled,
    and two of them beside a name took more room than the name — so on a roster
    they wrapped, and the wrap was the first thing an operator saw. Sentence
    case at 0.7rem on the softest tint there is reads as an annotation, which is
    what a role or a status is.
  */
  .pill {
    display: inline-block;
    padding: 0 var(--s2);
    border-radius: var(--r-pill);
    background: var(--hair-soft);
    color: var(--muted);
    font: 500 0.7rem/1.6 var(--ui-font);
    white-space: nowrap;
  }
  .pill.on { background: var(--accent-soft); color: var(--accent-ink) }
  /* Restated for the same reason "button.bad" restates it: .bad is also an ink. */
  .pill.bad { background: var(--danger-soft); color: var(--danger-ink) }

  /* ---- the roster: one line per person, and columns that line up ---- */
  /*
    A grid rather than a table, and fixed widths rather than content widths.

    A table sized by its contents gives every row its own column edges the
    moment one name is longer than another, which is what made the old people
    table unreadable at any width. "--cols" is set once per roster, so the head
    strip and every row are laid out from the same template and cannot disagree.
  */
  .roster { margin: 0 0 var(--s4) }
  .roster-head, .roster-row {
    display: grid;
    grid-template-columns: var(--cols);
    gap: var(--s2);
  }
  /*
    The header row is one line everywhere, so centring it is enough. A person's
    row is not: its first cell carries a name and up to two lines under it, and
    centring every cell against that whole block is what put "Last seen" and
    "Bots" between the two lines instead of beside the name — exactly where the
    second line, once it started clipping instead of overflowing, would still
    have run into them. Aligning every cell to the row's first line — its top —
    is what a fixed-width, ellipsis-clipped second line needs to be enough.
  */
  .roster-head { align-items: center }
  .roster-row { align-items: start }
  .roster-head {
    padding: 0 var(--s1) var(--s2);
    border-bottom: 1px solid var(--hair);
    color: var(--muted);
    /*
      One size for every header cell. "Read-only", "Push" and "Administrator"
      used to be smaller than "Who", "Last seen" and "Bots" — a second,
      narrower font-size on the switches' own headers, so the row read as two
      different tables glued together. There is one rule now, sized for the
      narrowest header cell the switches columns give it.
    */
    font: 600 0.72rem/1.3 var(--ui-font);
  }
  .roster-head > span { min-width: 0 }
  .roster-list { list-style: none; margin: 0; padding: 0; color: var(--ink); font-size: 0.9rem }
  .roster-list > li { margin: 0; border-bottom: 1px solid var(--hair-soft) }
  .roster-list > li:last-child { border-bottom: 0 }
  .roster-row { padding: var(--s2) var(--s1) }
  .roster.people { --cols: minmax(0, 1fr) 7rem 6rem 13rem 4.5rem }
  .roster.accounts { --cols: minmax(0, 1fr) 5rem 4.5rem 7rem 4.5rem }
  /* The three words a switch is named by, and they may not wrap either. */
  .roster-head .switches > span { white-space: nowrap }

  .who { display: flex; align-items: center; gap: var(--s2); min-width: 0 }
  .who-text { min-width: 0 }
  .who-name { display: flex; align-items: baseline; gap: var(--s2); min-width: 0; overflow: hidden }
  .who-name strong { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .who-name .pill { flex: 0 0 auto }
  .who-sub, .who-note, .cell { color: var(--muted); font-size: 0.82rem }
  /*
    Never two lines and never wider than the column — the rule the whole
    roster leans on, and the one line of it that matters most: display:
    block. ".cell" gets it for free, because a grid item's inline-level
    display computes to its block equivalent — but ".who-sub" and ".who-note"
    are not grid items, they are ordinary children of ".who-text"'s block box,
    so a plain span (display: inline) stays exactly as wide as its text
    demands and overflow: hidden has nothing to clip. That is what let
    "gateway sign-in" paint over "today 15:33" and "…-at-all@example.invalid"
    run clean across "All bots": the second line was never actually
    constrained to the first column's width. display: block makes it a box
    the size of its container, and only then do overflow and
    text-overflow have a boundary to clip against.
  */
  .who-sub, .who-note, .cell {
    display: block;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell-mid { text-align: center }
  .more { font-size: 0.82rem; white-space: nowrap }

  /*
    The initials disc, tinted from the app's own accent table.

    The colour is picked from the id, so the same person is the same colour on
    every visit and two people are rarely the same. Tint plus ink rather than a
    saturated fill with white on it: "expo/hermie/src/ui/tokens.ts" keeps a
    readable ink per accent for exactly this, and its 13% / 26% soft tint is the
    one an avatar ring already uses in the app.
  */
  .avatar {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    border-radius: var(--r-pill);
    display: grid;
    place-items: center;
    background: var(--av-bg);
    color: var(--av-ink);
    font: 600 0.72rem/1 var(--ui-font);
  }
  .av-0 { --av-bg: rgba(22, 104, 227, 0.13); --av-ink: #0b57c4 }
  .av-1 { --av-bg: rgba(123, 63, 196, 0.13); --av-ink: #6a2fb4 }
  .av-2 { --av-bg: rgba(14, 122, 132, 0.13); --av-ink: #0a6670 }
  .av-3 { --av-bg: rgba(22, 120, 60, 0.13); --av-ink: #12652f }
  .av-4 { --av-bg: rgba(182, 47, 129, 0.13); --av-ink: #a22270 }
  .av-5 { --av-bg: rgba(176, 76, 8, 0.13); --av-ink: #9a4106 }
  @media (prefers-color-scheme: dark) {
    .av-0 { --av-bg: rgba(22, 104, 227, 0.26); --av-ink: #b4d6ff }
    .av-1 { --av-bg: rgba(123, 63, 196, 0.26); --av-ink: #e0c8ff }
    .av-2 { --av-bg: rgba(14, 122, 132, 0.26); --av-ink: #a6e8ee }
    .av-3 { --av-bg: rgba(22, 120, 60, 0.26); --av-ink: #a8ecbe }
    .av-4 { --av-bg: rgba(182, 47, 129, 0.26); --av-ink: #ffc2e2 }
    .av-5 { --av-bg: rgba(176, 76, 8, 0.26); --av-ink: #ffd0a8 }
  }

  /*
    The switches, which are real checkboxes.

    The box is the one the browser posts and the one a keyboard reaches; it is
    clipped rather than hidden, because "display: none" takes it out of the tab
    order, and the track beside it is what gets painted — including the focus
    ring, which is drawn on the track so a keyboard can still see where it is.
    Nothing here animates: a settings page that slides is a settings page an
    operator waits for.
  */
  .switches { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s1); align-items: center }
  .switches > span, .switches > label { justify-self: center }
  .switch { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; margin: 0; cursor: pointer }
  .switch > input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    opacity: 0;
    pointer-events: none;
  }
  .track {
    display: block;
    width: 36px;
    height: 20px;
    border-radius: var(--r-pill);
    background: var(--sunk);
    border: 1px solid var(--switch-line);
    position: relative;
  }
  .track::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: var(--r-pill);
    background: var(--switch-knob);
  }
  /* The border stays: the accent fill alone is 2.5:1 on a dark card. */
  .switch > input:checked + .track { background: var(--accent) }
  .switch > input:checked + .track::after { left: 18px; background: var(--on-accent) }
  .switch > input:focus-visible + .track { outline: 2px solid var(--accent-ink); outline-offset: 2px }
  /* The head strip names the column on a wide screen; the card names it itself. */
  .switch-name { display: none }

  /*
    One person's detail, opened by the link in their row.

    ":target" and not a "<details>", because the panel has to be as wide as the
    whole row and a "<details>" can only be as wide as the cell its summary sits
    in. This way the row keeps its columns, the URL names whoever is open — one
    at a time, which is what keeps the list a list — and it is still nothing but
    HTML and a style sheet.
  */
  .panel { display: none }
  .panel:target { display: block; padding: var(--s2) var(--s1) var(--s4) }
  .panel h3 { font: 600 0.9rem/1.3 var(--ui-font); margin: var(--s3) 0 var(--s2) }
  /* A role picker with three words in it does not need the whole row. */
  .panel .fields > div { flex: 0 1 14rem }
  .panel dl { font-size: 0.85rem }
  .ticks { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: var(--s1) var(--s3) }
  .ticks label { color: var(--ink); font-size: 0.9rem; display: flex; align-items: center; gap: var(--s2) }
  /* Destructive last and quiet: the far end of the line, never beside Save. */
  .spread { margin-left: auto }
  /* The paragraph the list's two-sentence intro left out, for whoever wants it. */
  details.how { font-size: 0.85rem; color: var(--muted) }
  details.how > summary { cursor: pointer; color: var(--accent-ink); width: fit-content }
  details.how > p { margin: var(--s2) 0 0 }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); margin: 0 0 var(--s3) }
  .grid2 > div { min-width: 0 }

  /* ---- one column, and the nav across the top ---- */
  /*
    60rem, and it used to be 52rem.

    A 13rem nav beside a 68rem column is a wide-screen layout; on a 850px window
    it left the roster 578px to lay seven columns out in, and seven columns in
    578px is the wrapping that made the people list unreadable. Above this the
    nav is a rail, below it the nav is a strip and the page gets the width.
  */
  @media (max-width: 60rem) {
    .shell { grid-template-columns: minmax(0, 1fr); gap: var(--s4); padding: var(--s4) var(--s4) var(--s6) }
    nav {
      position: static;
      flex-direction: row;
      gap: var(--s1);
      overflow-x: auto;
      padding-bottom: var(--s1);
      border-bottom: 1px solid var(--hair);
    }
    .where { margin-left: 0; width: 100% }
  }

  /* ---- a phone: every row becomes a card ---- */
  /*
    Columns stop being the point below 48rem — there is no room for five of
    them and nothing to compare across rows on a screen that shows two. The row
    wraps instead: the person on the first line, the facts and the detail link
    on the second, the switches on a line of their own with the names the head
    strip was carrying.
  */
  @media (max-width: 48rem) {
    .roster-head { display: none }
    .roster-list > li {
      border: 1px solid var(--hair);
      border-radius: var(--r-inset);
      background: var(--panel);
      margin-bottom: var(--s2);
    }
    .roster-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--s2) var(--s3);
      padding: var(--s3);
    }
    .roster-row > .who { flex: 1 1 100% }
    .roster-row > .cell { order: 2 }
    .roster-row > .more { order: 2; margin-left: auto }
    .roster-row > .switches {
      order: 3;
      flex: 1 1 100%;
      gap: var(--s3);
      padding-top: var(--s1);
      border-top: 1px solid var(--hair-soft);
    }
    .switches > label { justify-self: start }
    .switch { align-items: flex-start }
    .switch-name { display: block; color: var(--muted); font-size: 0.72rem; line-height: 1.3 }
    .panel:target { padding: 0 var(--s3) var(--s3) }
    .grid2 { grid-template-columns: minmax(0, 1fr) }
  }

  /*
    ---- the sign-in family: one centred glass card, never a dashboard ----

    This used to reuse the dashboard's ".shell" grid and top bar — built for a
    13rem nav rail beside a wide column, asked to hold one form. The result was
    "Inloggen" pinned to the upper-left corner of an otherwise empty screen. The
    sign-in family gets its own shell instead: centred both ways, the mark and
    the deployment's name carrying the page above a glass card that holds
    whatever the page actually is (a form, a refusal, a done page).
  */
  .auth-shell {
    min-height: 100dvh;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--s6);
    padding: var(--s8) var(--s4);
  }
  .auth-hero {
    width: 100%;
    max-width: var(--auth-width, 26rem);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s1);
    text-align: center;
  }
  /*
    The mark "at a size that carries the page" (56px, up from the dashboard
    header's 28px) and the corner radius kept at the source icon's own ratio
    (rx 224 of 1024) rather than the dashboard's fixed --s2.
  */
  .auth-hero .mark { display: block; border-radius: var(--s4) }
  .auth-hero .brand-name { display: block; font: 700 21px/26px var(--ui-font); letter-spacing: -0.016em }
  /*
    The page's own heading, doing double duty as the context line under the
    brand name: "signing in", "the sign-in did not work", "the password is set"
    already say what the page is and, with the brand name just above them,
    where. A second, separate sentence would repeat one of the two, so none of
    those sentences is spelled out literally here — every page in this family
    has that heading embedded in its own translated copy, not in the style
    sheet, and this style sheet ships on every one of them verbatim.
  */
  .auth-hero h1 { font: 400 15px/20px var(--ui-font); color: var(--muted); margin: 0 }
  .auth-card {
    width: 100%;
    max-width: var(--auth-width, 26rem);
    box-sizing: border-box;
    background: var(--glass-sheet);
    -webkit-backdrop-filter: blur(46px) saturate(180%);
    backdrop-filter: blur(46px) saturate(180%);
    border-radius: var(--r-sheet);
    padding: var(--s6);
    box-shadow:
      inset 1.5px 1.5px 0 -0.5px var(--edge-hi),
      inset -1px -1px 0 -0.5px var(--edge-lo),
      inset 0 0 0 1px var(--edge-ring),
      var(--auth-shadow);
  }
  .auth-card > :last-child { margin-bottom: 0 }
  /*
    Something nested inside the sheet — the enrolment page's recovery codes —
    is information beside the form, never a second sheet: "never nest glass
    more than one level" (design/liquid-glass-tokens.md §7.2). It drops to a
    flat tint with a hairline instead of the dashboard's own opaque .card.
  */
  .auth-card .card {
    background: var(--sunk);
    border: 1px solid var(--hair-soft);
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  /* The one action on the card reaches edge to edge, the way a sheet's does. */
  .auth-card .actions { justify-content: stretch }
  .auth-card .actions button[type="submit"] { width: 100% }
  /* A refusal reads as a refusal: a small danger-filled mark ahead of it. */
  .auth-card .banner.bad {
    display: flex;
    align-items: flex-start;
    gap: var(--s2);
  }
  .auth-card .banner.bad::before {
    content: "!";
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    border-radius: var(--r-pill);
    background: var(--danger);
    color: var(--on-accent);
    font: 700 12px/18px var(--ui-font);
    text-align: center;
  }
  @media (max-width: 26rem) {
    .auth-shell { padding: var(--s6) var(--s4); gap: var(--s5) }
    .auth-hero .mark { width: 48px; height: 48px }
  }
`

const head = (locale: WebLocale, title: string): string =>
  `<!doctype html>\n<html lang="${htmlLang(locale)}">\n<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<meta name="robots" content="noindex">\n` +
  `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n`

/** Everything the chrome needs, and nothing a page body needs. */
export interface AdminChrome {
  /** The deployment's name: the branding name where one is set, else Hermie. */
  brand: string
  version: string
  current: AdminSection
  csrf: string
  /** Whether the footer's update button can do anything, and why not. */
  canSelfUpdate: boolean
  updateReason: string
  notice: string
  /** Whether the notice is a complaint. Notices are English; see `routes.ts`. */
  noticeIsBad?: boolean
  locale: WebLocale
  strings: WebStrings
}

const NAV_ORDER: readonly AdminSection[] = [
  'overview',
  'people',
  'push',
  'cache',
  'branding',
  'features',
  'identity',
  'danger'
]

function nav(chrome: AdminChrome): string {
  const labels = chrome.strings.admin.nav

  return `<nav aria-label="${escapeHtml(chrome.strings.common.administration)}">
    ${NAV_ORDER.map(
      section =>
        `<a href="${ADMIN_SECTION_PATHS[section]}"${section === chrome.current ? ' aria-current="page"' : ''}>${
          labels[section]
        }</a>`
    ).join('\n    ')}
  </nav>`
}

/**
 * The page, with a body already rendered into it.
 *
 * `title` is the `<h1>`; the `<title>` gets the deployment's name after it,
 * because a tab strip has no other context and three open tabs of one
 * deployment used to read identically.
 */
export function adminShell(chrome: AdminChrome, page: { title: string; intro?: string; body: string }): string {
  const { strings } = chrome
  const update = strings.admin.service

  return `${head(chrome.locale, `${page.title} — ${chrome.brand}`)}<body>
<header class="top">
  <a class="brand" href="/admin">${mark(28)}<span class="brand-name">${escapeHtml(chrome.brand)}</span></a>
  <span class="where">${strings.common.administration}</span>
</header>
<div class="shell">
  ${nav(chrome)}
  <main>
    <h1>${escapeHtml(page.title)}</h1>
    ${page.intro ? `<p class="lede">${page.intro}</p>` : ''}
    ${chrome.notice ? `<p class="banner${chrome.noticeIsBad ? ' bad' : ''}">${escapeHtml(chrome.notice)}</p>` : ''}
    ${page.body}
  </main>
</div>
<footer>
  <div class="footer-inner">
    <span class="note">${strings.admin.footer.version(escapeHtml(chrome.version))}</span>
    <form method="post" action="/admin/update">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(chrome.csrf)}">
      ${
        chrome.canSelfUpdate
          ? ''
          : `<span class="note">${escapeHtml(chrome.updateReason || update.updateUnavailable)}</span>`
      }
      <button class="quiet" type="submit"${chrome.canSelfUpdate ? '' : ' disabled'}>${update.updateButton}</button>
    </form>
  </div>
</footer>
</body>
</html>
`
}

/**
 * A page with no nav: the sign-in and the refusal.
 *
 * Neither may carry the nav, and for the same reason rather than for symmetry:
 * a reader of either is somebody this service has not let in, and a list of the
 * pages they cannot open is both useless to them and an inventory for anybody
 * else.
 */
export function barePage(input: {
  brand: string
  /** The `<h1>`. Doubles as the context line under the brand name — see `.auth-hero h1`. */
  title: string
  /**
   * The whole `<title>`, where the heading plus the brand will not do.
   *
   * Taken verbatim: "Sign in to Acme Chat" already names the deployment, and
   * appending it again gives a tab reading "Sign in to Acme Chat — Acme Chat".
   */
  documentTitle?: string
  /** `narrow` for a page that is one form: a sign-in has no use for 34rem. */
  width?: 'narrow' | 'wide'
  locale: WebLocale
  strings: WebStrings
  body: string
}): string {
  const column = input.width === 'narrow' ? '26rem' : '34rem'

  return `${head(input.locale, input.documentTitle ?? `${input.title} — ${input.brand}`)}<body>
<main class="auth-shell" style="--auth-width: ${column}">
  <div class="auth-hero">
    ${mark(56)}
    <span class="brand-name">${escapeHtml(input.brand)}</span>
    <h1>${escapeHtml(input.title)}</h1>
  </div>
  <div class="auth-card">
    ${input.body}
  </div>
</main>
</body>
</html>
`
}

/** One card: a heading, an optional sentence, and whatever the page put in it. */
export function card(input: { heading?: string; intro?: string; body: string; kind?: 'danger' }): string {
  return `<section class="card${input.kind === 'danger' ? ' danger' : ''}">
    ${input.heading ? `<h2>${input.heading}</h2>` : ''}
    ${input.intro ? `<p>${input.intro}</p>` : ''}
    ${input.body}
  </section>`
}

/** The hidden field every form on every one of these pages carries. */
export const csrfField = (csrf: string): string =>
  `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(csrf)}">`
