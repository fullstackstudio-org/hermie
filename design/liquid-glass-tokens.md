# Hermie design tokens — Liquid Glass

Reference mockup: `liquid-glass.html` (open it in a browser, no build step). These
are the values as they should land in `expo/hermie/src/ui/tokens.ts`. Every number
below is the one the mockup actually uses; the contrast ratios were measured on the
composited surfaces, not on the raw hex values.

---

## 0. Two rules that outrank everything below

These were set by the owner on 2026-09-20 against a reference he picked himself —
iPadOS 26 Messages in dark mode — and they beat any value in this file that
disagrees with them.

### 0.1 No gradients. Anywhere.

Flat colours only, per theme: the wallpaper, every glass wash, every button, and
the outgoing bubble. His verdict on the gradients that were there was that they
look **generated**, and the reference bears it out — the Messages window is a
near-black field with nothing painted on it, and every impression of depth comes
from the glass in FRONT of the floor rather than from a ramp on the floor itself.

What this cost, and what it did not:

- `WallpaperSpec` is one `fill` per scheme. The value kept is the end of the old
  ramp furthest from the ink, so every contrast ratio could only improve.
- `GlassRecipe.fill` and `BubbleRecipe.fill` are one colour, at the alpha of the
  THINNEST stop the gradient used to carry — the stop `contrast:check` already
  measured the ink against, so no floor moved.
- `AccentSwatch.bubble` is one colour, the old gradient's lighter stop, which is
  the one white was already being checked on.
- The **only** surviving `LinearGradient` in the app is the reading fold's mask
  (`chat-ui/primitives/Fold.tsx`). That is not decoration: it is an alpha ramp
  whose whole job is to make a clipped body fade instead of ending in a cut line.
  A flat mask there is a rectangle drawn over the last two lines.

### 0.2 Glass must be REAL glass where the OS has it

The benchmark is the Messages search field and the button beside it: the blue
selected row scrolling underneath shows through them, blurred and bent at the rim,
with no opaque tint over it. That is `UIGlassEffect` lensing, and nothing built out
of a blur plus a tint reaches it.

So on iOS 26+ and on the Mac (the iPad build on macOS 26) every glass element is a
real `expo-glass-effect` `GlassView` — `glassEffectStyle` `regular`, minimal tint,
`isInteractive` on the ones that are buttons, `GlassContainer` where adjacent
elements should merge. `GLASS_MATERIAL` (`ui/glass/material.ts`) decides once, from
`isLiquidGlassAvailable()` and `isGlassEffectAPIAvailable()`, and the developer
screen prints which of the three paths is live so the question is answerable on a
device instead of by reading this paragraph. The blur fallback is for older OS
versions, Android and the web, and there it is a low-opacity flat tint — never a
thicker one standing in for the real material.

---

## 1. Colour

### 1.1 Text and content

| Role                       | Light     | Dark      |
| -------------------------- | --------- | --------- |
| `text`                     | `#12151C` | `#F3F6FB` |
| `textMuted`                | `#4B5462` | `#C8D2E0` |
| `textFaint` (metadata)     | `#586171` | `#CBD5E4` |
| `onAccent` (bubble/button) | `#FFFFFF` | `#FFFFFF` |
| `accent` (solid fill)      | `#1668E3` | `#2C7BEA` |
| `accentText` (on glass)    | `#0B57C4` | `#B4D6FF` |
| `danger` (fill)            | `#C0293A` | `#D8465A` |
| `dangerText`               | `#A81F30` | `#FFC2CD` |
| `ok` (status dot fill)     | `#1C8547` | `#5CCB86` |
| `okText`                   | `#116038` | `#8FE3B0` |
| `warnText`                 | `#865600` | `#FFCB61` |

`ok` is a FILL, the way `danger` is, and `okText` is the ink beside it. Until
this round there was only one value and it was used as both, which measured
3.47–4.54 : 1 as ink on every surface but the dark sunk tint — so a `Success`
line was below AA everywhere anybody would read one. The four other values above
moved for the same reason: `textFaint` and `dangerText` cleared AA on a panel and
failed on a dark bubble, which is precisely where a metadata line and a failed
delivery live.

`accent` and `accentText` are the one pair in this table that a THEME replaces.
The values above are what Blue resolves to; under Graphite or Lime the same two
roles carry that preset's accent — `accent` its fill, `accentText` its ink form —
because a link, a chevron and the navigator's tint all read them, and a lime
window whose links are blue is a window with one colour left over from another
theme. The merge is `colorsForFace` in `ui/themes.ts`, and it is one function
because the contrast check reads it too. A chat's own colour is untouched: that
is `theme.accent(name)`.

Every pair in this table is checked on the COMPOSITED surface by
`npm run contrast:check`, which reads `expo/hermie/src/ui/tokens.ts` rather than
a copy of it. 4.5 : 1 for ink, 3 : 1 for a mark. Change a value here and there,
and let the check say whether it holds. `accentText` is measured per theme, on
every surface in the table.

### 1.2 Outgoing bubble gradient (default chat)

Vertical, top → bottom. Deliberately deeper than `#0A84FF`: white body text must
clear AA at the **top** stop, which is the lighter one.

| Theme | Top       | Bottom    | White text (top / bottom) |
| ----- | --------- | --------- | ------------------------- |
| Light | `#2A72DC` | `#0F4FBE` | 4.63 : 1 / 7.29 : 1       |
| Dark  | `#2A72DC` | `#0F52C2` | 4.63 : 1 / 6.99 : 1       |

### 1.3 Per-chat colour

Each chat carries one of eight curated colours, or Default. Set it in the chat
options sheet. It tints exactly four things and nothing else:

1. the avatar ring in the list and the header,
2. the selected row's glass tint,
3. the header accent and in-chat links,
4. the outgoing bubble gradient for that chat.

| Name     | Fill      | Bubble top | Bubble bottom | White text (top / bottom) |
| -------- | --------- | ---------- | ------------- | ------------------------- |
| Default  | `#1668E3` | `#2A72DC`  | `#0F4FBE`     | 4.63 / 7.29               |
| Indigo   | `#4B4CC8` | `#5556CE`  | `#33309F`     | 5.82 / 10.17              |
| Violet   | `#7B3FC4` | `#8244CE`  | `#5B23A0`     | 5.73 / 9.58               |
| Magenta  | `#B62F81` | `#C0368A`  | `#8E1B64`     | 5.08 / 8.43               |
| Red      | `#C5303A` | `#CF3B44`  | `#9C1A24`     | 4.81 / 8.12               |
| Orange   | `#B04C08` | `#B8540C`  | `#8B3A05`     | 4.87 / 7.76               |
| Teal     | `#0E7A84` | `#14828C`  | `#07606A`     | 4.56 / 7.27               |
| Green    | `#16783C` | `#1A8043`  | `#0E5C2E`     | 4.98 / 8.11               |
| Graphite | `#485468` | `#54607A`  | `#343E52`     | 6.30 / 10.73              |

Each colour also needs a _text_ variant for links and the header subtitle, because
the fill is too dark to read on glass in dark mode and too light in light mode:

| Name     | `accentText` light | `accentText` dark |
| -------- | ------------------ | ----------------- |
| Default  | `#0B57C4`          | `#B4D6FF`         |
| Indigo   | `#3F3FB4`          | `#CCCDFF`         |
| Violet   | `#6A2FB4`          | `#E0C8FF`         |
| Magenta  | `#A22270`          | `#FFC2E2`         |
| Red      | `#AE2029`          | `#FFC2C7`         |
| Orange   | `#9A4106`          | `#FFD0A8`         |
| Teal     | `#0A6670`          | `#A6E8EE`         |
| Green    | `#12652F`          | `#A8ECBE`         |
| Graphite | `#3D4859`          | `#D2DAE6`         |

The dark text variants are lighter than they look like they need to be: they have to
clear 4.5 : 1 on a **reading bubble**, the lightest surface they ever sit on
(measured 4.48–5.30 : 1).

### 1.4 Glass

Glass is a stack: a blur, one or two translucent gradients, an inner highlight
stroke and a drop shadow. Alphas are what makes it legible, so they are tokens.

| Surface                                                     | Light                           | Dark (over the rung below)                |
| ----------------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| `glassPanel` (sidebar/chat)                                 | white 0.74 → 0.48 → 0.60, 155°  | `#1C2A45` 0.80 + white 0.10 → 0.03 → 0.07 |
| `glassFloat` (chat header, `PageChrome`, composer, popover) | white 0.80 → 0.58, 170°         | `#425A88` 0.74 + white 0.12 → 0.05        |
| `glassSheet`                                                | white 0.86 → 0.72               | `#334670` 0.92 + white 0.11 → 0.04        |
| `glassCard` (tool, cron, DM thread)                         | white 0.70 → 0.52               | `#2F4066` 0.86 + white 0.09 → 0.035       |
| `bubbleIn` (frosted)                                        | white 0.76 → `#F4F8FF` 0.64     | `#3E5480` 0.82 + white 0.10 → 0.035       |
| `bubbleInRead` (tint layer)                                 | white 0.93 → `#F3F7FF` 0.88     | `#3E5480` 0.94 + white 0.08 → 0.03        |
| `bubbleDm` (incoming bot)                                   | `#F3EEFF` 0.88 → `#EBE5FD` 0.80 | `#413470` 0.88 + violet 0.16 → 0.08       |
| `tint1` (level-3 chip)                                      | white 0.52                      | white 0.12                                |
| `tintSunk` (field, code well)                               | `#0E2040` 0.055                 | `#060C18` 0.44                            |
| `hairline`                                                  | `#10264E` 0.13                  | `#BED4FF` 0.22                            |
| `hairlineSoft`                                              | `#10264E` 0.08                  | `#BED4FF` 0.13                            |

Edge highlights (the specular 1px stroke):

```
edge      = inset 1.5px 1.5px 0 -0.5px  white 0.92 (light) / 0.34 (dark)
            inset -1px -1px 0 -0.5px    white 0.40 (light) / 0.10 (dark)
            inset 0 0 0 1px             white 0.30 (light) / 0.12 (dark)
edgeSoft  = the first and third line only, at 0.80 / 0.26 (light), 0.24 / 0.10 (dark)
```

A corner sheen sits on top of panels only, limited to the outer 12 % of the
gradient (`linear-gradient(148deg, white .40, transparent 12%)`), so it never falls
under running text.

### 1.5 Wallpapers

Three, each with a light and a dark variant, all built from layered radial
gradients — no image files. Dark wallpapers are deep but **coloured**; `#000000` is
not a wallpaper.

| Wallpaper | Light base            | Dark base             |
| --------- | --------------------- | --------------------- |
| Blue      | `#EAF3FF` → `#C5DAFB` | `#0C1B33` → `#070F1D` |
| Warm      | `#FFF3E6` → `#F8D6BC` | `#2A1708` → `#160C05` |
| Graphite  | `#EFF1F5` → `#CFD5E0` | `#171B22` → `#0D0F14` |

### 1.6 Presence

| State       | Light     | Dark      | Shape                                     |
| ----------- | --------- | --------- | ----------------------------------------- |
| Online      | `#20A24B` | `#3ED374` | filled bead                               |
| Working     | `#1668E3` | `#5AA4FF` | filled bead + a **still** white inner dot |
| Needs input | `#E09000` | `#FFB531` | filled bead + white notch, slow pulse     |
| Offline     | `#8A93A3` | `#7E8798` | hollow ring, transparent centre           |

Definitions: **Online** = gateway connected and the bot's session attached.
**Working** = the bot is on a turn. **Needs input** = an approval or clarify request
is waiting. **Offline** = gateway unreachable or no session; the row shows
`Offline · last seen 21:09`.

Presence never depends on colour alone: the shape differs per state and the chat
header subtitle repeats the state in words. Bead sizes: 14 px on a 48 px avatar
(2.5 px ring in the panel colour), 9 px inline in the header and the connection
line, 18 px in the legend.

The **global** connection state is not a bot state, and it is shown the SAME way
on every layout: one slim glass status line under the `Chats` title, and nothing
else anywhere.

There is no gateway card. The wide layout used to carry one permanently at the
foot of the sidebar, with the host and `Connected · 12 ms`; it spent a row of
the sidebar saying the thing it says every second of every day, in different
words from the phone's own line, and the latency in it was never measurable from
the app anyway. The bottom of the list is the four-tab strip and nothing else,
on both layouts.

What the line says:

- **Ready** — nothing at all. It does not render. A row that only ever says
  `Connected` is a row nobody reads, and the presence bead beside every chat
  already carries it.
- `Connecting…`, `Reconnecting…`, `Offline` — the state, beside a static
  hollow bead.
- **`needs_signin`** — `Signed out`, in amber, and the line itself is the
  button: tapping it starts the sign-in. This is in ADDITION to the Signed out
  card, which still takes the whole content column (wide) or the whole screen
  (phone, list AND inside a chat). The sidebar stays usable while that card is
  up, and the sidebar is what a reader is looking at.

The line is **static** in every state, including signed out. The pulse belongs
to a bot's `needs input` presence and to nothing else. The host and the state
live in Settings → Gateway as well, where they are looked up rather than
glanced at.

---

## 2. Dark elevation ladder

The first dark pass read as one flat black field. Every dark surface now sits on a
named rung of a single blue-slate ramp, each rung a measurable step lighter than the
one below it, and every rung carries a hairline so two adjacent rungs still show an
edge.

| Rung  | Hex       | Used by                                  | Ratio vs. rung below |
| ----- | --------- | ---------------------------------------- | -------------------- |
| `e0`  | `#0A1830` | wallpaper floor                          | —                    |
| `e1`  | `#1C2A45` | the sidebar pane, and the overlay panels | 1.24 : 1             |
| `e2`  | `#28385A` | list row hover, inset groups             | 1.23 : 1             |
| `e2s` | `#334670` | selected row (plus the chat colour tint) | 1.25 : 1             |
| `e3`  | `#3E5480` | incoming bubble                          | 1.24 : 1             |
| `e4`  | `#50699A` | round controls, pressed segments, chips  | 1.37 : 1             |

Two side rungs keep like-for-like surfaces apart:

| Rung  | Hex       | Used by          | Ratio                    |
| ----- | --------- | ---------------- | ------------------------ |
| `e3c` | `#2F4066` | machine cards    | 1.36 : 1 vs. `e3` bubble |
| `e3f` | `#425A88` | composer, header | 2.08 : 1 vs. `e1` panel  |

So in dark mode a card on a panel on a wallpaper is three distinguishable tones, and
an incoming bubble, a tool card and the composer are three more.

**Measured text contrast in dark** (worst of the three wallpapers): body on panel
12.88, muted on panel 9.14, body on incoming bubble 7.08, body on reading bubble
6.67, muted on reading bubble 4.73.

**Measured text contrast in light** (worst of the three wallpapers, worst point of
the panel gradient): body on panel 15.02, muted on panel 6.29, body on reading
bubble 16.72, muted on reading bubble 7.01, metadata on panel 4.69.

---

## 3. Type

One scale, shared by phone and the wide layout. Body text is **not** scaled up on
the wide layout — the same 17 pt reads correctly at both sizes and it is the same
React Native code.

| Role         | Value                 | Notes                                   |
| ------------ | --------------------- | --------------------------------------- |
| `title`      | 700 28 / 32, -0.022em | sidebar title on phone                  |
| `titleWide`  | 700 30 / 34, -0.022em | sidebar title on the wide layout        |
| `sheetTitle` | 700 21 / 26, -0.016em |                                         |
| `chatName`   | 600 18 / 22, -0.014em | chat header                             |
| `name`       | 600 17 / 22           | conversation name                       |
| `body`       | 400 17 / 25           | bubbles, both layouts                   |
| `bodyRead`   | 400 17 / 27           | long markdown replies — looser leading  |
| `preview`    | 400 15 / 20           | list preview, sheet copy, thread text   |
| `meta`       | 400 13 / 17           | timestamps, tool rows, bot-to-bot lines |
| `micro`      | 600 11 / 14, +0.055em | uppercase labels, date stamps, chips    |
| `code`       | 400 13.5 / 21 mono    | commands, arguments, diffs, code blocks |

Families: `-apple-system, "SF Pro Text", "SF Pro Display", system-ui, sans-serif`
and `ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace`. Monospace is
reserved for machine text: commands, arguments, results, diffs, durations.

Wide-layout-only additions: the 30 pt title, and the composer caption
`Enter to send · Shift+Enter for a new line` at 12 px. The phone shows neither.

---

## 4. Spacing, radii, sizes

**Spacing scale**: 4, 8, 12, 16, 20, 24, 32, 40, 48.

**The window gap is gone on the wide layout.** It was 14, between a floating panel
and the window edge and between the two panels, and the owner rejected the result
on a Mac screenshot on 2026-09-20: he does not want the space around everything.
The wide shell is edge to edge now, after Messages on the Mac — sidebar flush to
the leading edge and the full height of the window, chat column flush to the other
three, no rounding on either, and one hairline where they meet. The constant
survives for the two things that still float over a window rather than filling it
(`SidebarOverlay`, `BottomSheet`'s wide column). The compact shell never had a
gutter to lose.

**Radii**: panel 30, sheet and composer 28, bubble 22 with a 6 px sender-side bottom
corner, cards 18, thumbnails 14, inset controls 12, pills 999, phone frame 46,
window frame 22.

**Sizes**: list avatar 48, header avatar 38, inline avatar 26. Round glass controls
38 on the wide layout, 40 on phone; list rows 74 (72 on phone); every primary
control is at least 44 tall on phone. Sidebar width **340 above 1100pt of window width, 300 below
it** — this said 344 flat, which is a landscape number wearing no label: in portrait 344 is a third
of an iPad Pro 13" (344 of 1032) and two fifths of an 11" (344 of 834), and what it takes comes out
of the one column that has to hold prose. `sidebarWidth()` in `expo/hermie/src/ui/tokens.ts` is the
one place that decides.

**Max bubble width** — the rule that fixes edge-to-edge text walls:

```
wide layout: min(68%, 640px)   /* of the chat column */
phone:       min(78%, 320px)
```

68 % is too narrow to read at phone width, hence the override; the 640 px cap is
what keeps a long report from spanning a Mac window.

---

## 5. Shadows, blur, motion

**Blur**: panel `blur(36px) saturate(185%)`, float `blur(24px) saturate(175%)`,
sheet `blur(46px) saturate(180%)`, scrim `blur(3px) saturate(115%)`.

**Shadows**:

```
panel  0 30px 64px -22px rgba(14,40,86,.40), 0 10px 26px -14px rgba(14,40,86,.28)
float  0 14px 30px -12px rgba(14,40,86,.30), 0 3px 10px -6px  rgba(14,40,86,.20)
card   0 6px 16px -10px  rgba(14,40,86,.24)
sheet  0 -18px 60px -16px rgba(14,40,86,.34)
```

In dark the same geometry with black at .72 / .55 / .45 / .62.

**Motion**:

| Token        | Value                         | Used for                         |
| ------------ | ----------------------------- | -------------------------------- |
| `durMicro`   | 120 ms                        | press, hover, colour swaps       |
| `durFast`    | 180 ms                        | chevrons, switch knob, jump pill |
| `durBase`    | 260 ms                        | disclosure open, scrim fade      |
| `durSheet`   | 420 ms                        | sheet and overlay panel travel   |
| `easeOut`    | `cubic-bezier(.22,.61,.36,1)` | entries, travel                  |
| `easeInOut`  | `cubic-bezier(.4,0,.2,1)`     | pulses, loops                    |
| `easeSpring` | `cubic-bezier(.34,1.28,.5,1)` | sheet arrival, switch knob       |

**The motion rule: animation is reserved for things that need the reader.**

- The **only** presence state that animates is _Needs input_: a 2 s, low-amplitude
  amber ring pulse. It stops under `prefers-reduced-motion`.
- _Working_ is static — a solid blue bead with a still inner mark. A bot being busy
  is information, not a request.
- The agents bar, the `Delivered · waiting for reply` marker on bot-to-bot lines and
  every other status indicator are static. Waiting uses a hollow dot, not a blink.
- Typing dots inside a bubble **do** animate: that is streaming content, not status.
- Under `prefers-reduced-motion` all durations collapse to ~0 and the amber pulse
  resolves to a static ring.

---

## 6. Component rules worth writing down

### 6.1 Bubble tails

The tail is a **single path that belongs to the bubble element** — an inline SVG
child of the bubble, absolutely positioned at the bubble's bottom corner, offset
6 px so it overlaps the 6 px sender-side corner radius:

```
M0 0 L5 0 C5 7 7.6 13.4 13 16 C8.4 17.7 3 16 0 12.4 Z    (13 × 17)
```

Outgoing uses it as drawn, filled with the bubble's **bottom** gradient stop (the
tail sits at the bottom, so a flat fill matches exactly). Incoming mirrors it with
`scaleX(-1)` and fills with `tailIn` / `tailDm` — flat colours that match the
bubble's lower edge.

It is rendered **only on the last bubble of a group**. There is no separately
positioned tail view; that is what produced the stray square in the previous build.

### 6.2 Typing and streaming

One bubble from start to finish. While the turn is pending, the bubble is compact
and holds three animated dots; when tokens arrive the dots are replaced by text and
the bubble's width animates to fit. No placeholder box, no grey rectangle, no
swapping one view for another.

### 6.3 Long markdown replies

Long replies get the **reading treatment**: the `bubbleInRead` tint (near-opaque, so
contrast no longer depends on the wallpaper), `bodyRead` leading, and generous
horizontal padding. Inside: real rendered markdown — headings, bold, ordered and
unordered lists, inline code chips that wrap on word boundaries, code blocks and
tables that scroll horizontally inside their own wrapper rather than widening the
bubble.

Past roughly 14 lines (352 px at 25 px leading; 300 px on phone) the body is folded
with a gradient mask and a `Show more` / `Show less` control.

### 6.4 Machine events are not speech

Tool calls, thinking, cron deliveries and outgoing bot-to-bot messages are never
bubbles. They read as a quiet ledger in the bot's gutter: same left edge, distinct
silhouette.

- **Tool row** (collapsed): glyph + `terminal` + the command in monospace + duration,
  expanding to Arguments and Result wells.
- **Diff variant**: added lines on `ok` at 14 % with a `+` mark, removed on `danger`
  at 13 % with `−`.
- **Error variant**: danger-tinted glyph and title, the message in `dangerText`, the
  raw output in a well, and Retry / Copy output.
- **Thinking**: a single muted line, `Thought for 8s`, expanding to a short summary.

### 6.5 Cron deliveries

The scheduled-jobs feature is called **Crons** everywhere — the nav label, the list
view, the card. A delivery is its own glass card with a clock glyph:

```
CRON
Nightly domain scout
ran 04:22 · delivered to this chat
```

collapsed, expanding to the body plus _Open cron_ and _Run now_. It is never drawn
as the owner's own blue bubble.

The Crons list view shows name, schedule in words (`Every day at 04:22 · Researcher`),
next run, and a status bead, with paused crons under their own divider.

### 6.6 Bot to bot

**Neither direction is a bubble, a pill or a card.** Both are the ASIDE — the
silhouette §6.4's thoughts have: left-aligned, muted ink at the smaller size, no
background, a one-line header with the time and a chevron, and a body that opens
in place. The header is the direction and the counterpart, and nothing else:
`To @writer` on a message this bot sent, `From @writer` on one it received. One
component draws both, and the presentation is the same at every verbosity —
including Quiet, which is where the sending side used to be a centred
`Message to Writer` chip while the answer beside it was already an aside.

On an outgoing row a reply indicator is **always present**, because a row with
nothing on its right would read as delivered and answered:

| Situation              | Indicator                                             |
| ---------------------- | ----------------------------------------------------- |
| A reply came back      | `↩︎ replied`                                           |
| Still pending          | hollow dot + `Delivered · waiting for reply` (static) |
| The recipient is on it | hollow dot + `@writer is writing…`                    |
| It did not go          | `Failed` in `dangerText`                              |

An inbound row gains `↩︎ answered` once this bot has replied to it.

Consecutive rows sit 9 px apart, keyed on the PAIR: an errand and the answer to it
sit tight, and a message to somebody else starts a new run. More than three in a
row — **in either direction, in one run** — roll up into
`6 messages with @writer · 4 replies`, which expands in place; `replies` counts the
errands that were answered.

Tapping a row **opens it inline**: the body rendered as Markdown, selectable, and a
secondary `Open @writer's chat` link. The row itself never navigates away and never
scrolls the transcript somewhere else, and the open state survives being scrolled
out of the list and back.

The bot-to-bot switch in the chat's options folds both directions to a one-line
chip. It never hides them: a message the reader cannot see makes the bot's own
reply unexplainable.

### 6.7 Files and images

The composer's `+` opens a small glass menu: _Photo library_, _Choose file_. The
attachment tray holds image thumbnails and file chips side by side. A file chip
carries a type glyph, the file name middle-truncated (head ellipsised, tail kept so
the extension stays visible), the size, and a remove `×`. While uploading it shows a
progress ring instead of the `×`; if it is rejected it takes the danger tint and
says what the limit is: `Too large · 100 MB max`.

In the transcript a sent file is a compact file chip attached under the owner's
bubble — name, size, type glyph. Never a raw `@file:` token in the message text.

### 6.8 Sidebar organisation

The list is the owner's, not the gateway's. Rows can be reordered by hand and
grouped under **named dividers** (`Work`, `Finance`, …). _Edit_ reveals drag handles
on rows, Rename / Remove on dividers, and an _Add divider_ action.

A named divider with no rows under it **keeps its heading and gets a row of its
own** (`No chats in this section`), in and out of edit mode. Dropping an empty
section leaves nothing to move a chat back INTO, and two headings whose rows have
all moved away then meet with only a heading's own padding between them and read
as one run-on line.

A bot can be **archived** — swipe on phone, context menu on the wide layout — and
lives under a collapsed `Archived (1)` disclosure at the bottom of the list.

The compose button does not apply, because there is one canonical chat per bot and
you never create a conversation. Its place is taken by a round glass **New cron**
button, the one thing you do create from this screen.

Footer navigation is a four-tab glass strip: **Chats · Activity · Crons ·
Settings**. The strip is the whole footer on every layout — nothing sits under
it (see §1.6).

### 6.9 Overlays, sheets and Esc

On the wide layout, Activity, Crons, Settings and chat options open as a glass panel
that slides in over the **chat column only**, from the right, behind a dimmed scrim;
the sidebar stays put and stays usable. The panel has a round glass close button.

On phone the same destinations push or present as a normal sheet.

A **bottom sheet is glass** — the sheet recipe, opaque so its body text and any
command it shows keep a fixed contrast — with a grabber at the top, which a
blocking sheet omits because its only ways out are its own buttons.

On the wide layout a sheet is **capped at 560 pt and parked over the content
column**, whose left edge is the sidebar plus the gaps around it. Spanning the
window would put `Allow once` and `Deny` a hand's width apart and lay the scrim
over the chat list, which stays usable while a sheet is up. Where the column is
narrower than the cap, the column wins.

A sheet with **pages** inside it (chat options → model, reasoning, colour) is
still one sheet. Each page has a back control, and **Esc goes back exactly one
level**: the first pops the page, the second closes the sheet. The same rule
holds for sub pages inside the overlay panel. Nothing coordinates it — the
handler stack delivers to whatever registered last, and a page registers after
the sheet it is in.

**Every sheet, popover and overlay closes on Esc on the Mac.** The approval sheet
closes only through one of its four buttons. Sheet actions are exactly
`Allow once`, `Allow for this session`, `Always allow`, `Deny` (danger tint) — there
is no swipe-to-answer, because an approval is not a notification.

### 6.10 Transcript behaviour

The transcript **opens at the bottom**, on the newest message. While the reader is
at the bottom it follows new messages automatically. Once they scroll up, following
stops and a glass **Jump to latest** pill appears, centred above the composer, with
the count of messages that arrived since. Tapping it returns to the bottom and
resumes following.

### 6.11 Who sent it

In the shared **Bot Chat**, and only there, a message somebody else sent draws with
a name over its first bubble and an avatar beside it — the way any messenger shows a
group. **The gate is three things, all of them:** this is the group chat, not one of
the reader's own conversations, a branch or a retired one; the row carries an
author; and that author is not the reader. Miss any one and the row draws exactly as
it always has — the reader's own silhouette, no name, no avatar. A row nobody
attributed is the honest cost of there being no record, not a guess dressed up as
one.

**The run.** The name and the avatar sit on the FIRST bubble of a sender's run only;
a run breaks the moment the sender changes, which is what makes the avatar read as
"appearing when the sender changes" with no rule of its own beyond the grouping this
document already describes in §6.1. The avatar's gutter is reserved for the WHOLE
run, drawn or not, so every bubble in it keeps one left edge instead of stepping in
and out as the avatar comes and goes.

**Two palettes, kept apart on purpose.** The name is inked from `SENDER_INK_ORDER`
in `tokens.ts` — `ACCENT_ORDER` minus `default`, `red` and `green` — indexed by a
hash of their IDENTITY, never their display name: a rename must not recolour a
conversation, and two people who both call themselves the same thing must not
merge. `default` stays out because it is the chat's own accent; `red` and `green`
stay out because in this app they are not colours, they are `danger` and `ok` —
the same call Settings' category marks make for `CATEGORY_TINTS`
(`features/settings/navigation/category-look.ts`), and for the same reason: a
person's name in red reads as a warning about that person, not as their colour.
`lime` stays in — it is a text ink read against glass here, never a white glyph on
a lime fill, so the contrast floor that rules it out for a category mark's well has
nothing against it as a sender ink. That leaves eight: `indigo`, `violet`,
`magenta`, `orange`, `teal`, `graphite`, `slate`, `lime`. The avatar circle keeps
its own four-tint palette (§4, "inline avatar 26") unchanged; only what picks a
slot from it moves, from the name to the same identity. **No new colour was added
for either.** The eight sender inks were already in `tokens.ts`;
`scripts/check-contrast.ts` measures exactly those eight against the panel,
elevation e1/e2/e3 and the sunk tint, on every preset in both schemes, floor 4.5 —
worst case measured 4.94 : 1.

**The name is real text, not a caption on a picture.** It sits ahead of the bubble in
reading order, so a screen reader says the name and then the message; the avatar is
`aria-hidden`, as every avatar in this document already is.

---

## 7. Implementation notes

### 7.1 Which surfaces are glass

Glass: the two panels, the chat header, the agents bar, the composer, the overlay
panel, sheets, popovers (slash, attach menu), machine cards, cron cards, bot-to-bot
thread blocks, file chips, and the jump pill.

**Not glass**: the interior of a long-text bubble. It gets the `bubbleInRead` tint
layer instead — a near-opaque wash — so body-text contrast is a fixed number rather
than a function of whatever is behind it. This is the whole reason the reading
treatment exists; it is not a stylistic variant.

Also not glass: anything at level 3. A chip inside the composer, a segment inside a
segmented control, a button inside a sheet — these use `tint1` / `tintSunk` plus a
hairline, no blur of their own.

### 7.2 Never nest glass more than one level

Panel (level 1) → header / composer / sheet / card (level 2) → **tint only**
(level 3). Two stacked blurs on the wide layout cost real frame time and visually
they cancel out: the second blur samples an already-blurred backdrop and returns
mud. One level of nesting is the hard limit.

### 7.3 Platform

- **iOS 26 and newer**: use the native material — `expo-glass-effect`, `GlassView`
  for a single surface and `GlassContainer` when several glass surfaces sit next to
  each other and should merge (the header buttons, the composer's controls). On the
  SDK 54 line that package is on the `0.1.x` range; pin it there.
- **Older iOS**: fall back to `expo-blur` (`BlurView`, `intensity` mapped from the
  blur tokens) plus the same gradient, hairline and shadow layers.
- **Android**: fall back to a translucent solid — the glass gradient composited over
  the rung colour, no blur view at all. The ladder in §2 is defined so that the
  solid fallback still reads as the same hierarchy.
- The `Reduce transparency` setting swaps every glass surface for its solid tint on
  all platforms and keeps the identical token set.

### 7.4 Performance in long transcripts

Do not put a blur view behind every bubble. On Android there are no per-bubble blur
views at all, and on iOS the incoming bubble uses the material only while it is on
screen — a virtualised list with a blur view per row is the fastest way to make a
long report scroll badly. The reading treatment helps here too: a near-opaque tint
is a plain view.

Machine cards, cron cards and bot-to-bot thread blocks are collapsed by default, so
the expensive content (code blocks, tables, diffs) is not mounted until asked for.

---

## 8. Fixture data

The mockup uses bots **Researcher**, **Writer**, **Bookkeeper**, **Postman**, one
archived bot **Default**, and the gateway `gateway.example.com`. Domains are drawn
from the reserved documentation ranges (`example.org`, `example.net`,
`example.com`); addresses from `203.0.113.0/24`. No real person, company or domain
appears anywhere.
