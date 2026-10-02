/**
 * The app's line icons, drawn as paths rather than typed as characters.
 *
 * **Why this exists at all.** Every icon in the app used to be a Unicode glyph —
 * `◉ ⇄ ◷ ⚙` in the tab strip, `⌕` in the search field, `›`/`⌄` on every
 * disclosure. A glyph is rendered by whichever font on the device happens to
 * cover that code point, and the four tab characters come from four different
 * fonts with four different design sizes: at one `fontSize` the chat circle and
 * the clock drew visibly smaller than the exchange arrows and the gear, which is
 * what the owner reported. There is no font metric that fixes that, because the
 * glyphs do not agree about how much of their em box the mark should fill. A path
 * in a known viewBox does.
 *
 * Two smaller problems it also removes: iOS gives several of these characters
 * their EMOJI presentation unless asked for the text one (the gear was a
 * colourful sticker in a monochrome strip without a trailing U+FE0E), and a glyph
 * that is missing from every font on Android draws the empty box.
 *
 * ## The slot is not the drawing
 *
 * `size` is how big the mark is drawn; `slot` is the box it is centred in. They
 * are separate because a row of icons aligns on its BOXES — four 24pt slots put
 * four labels on one baseline whatever each mark's own weight wants to be — while
 * the marks inside them are sized for legibility. `slot` defaults to `size`,
 * which is what a lone icon in a round button wants.
 *
 * ## Conventions
 *
 * One 24 × 24 viewBox for every icon, stroked rather than filled, round caps and
 * joins, `strokeWidth` scaled to the drawn size so a 14pt caret is not a hairline
 * and a 22pt one is not a slab. `color` is a resolved colour string, never a role
 * name: the caller already has a theme and the active/inactive decision belongs to
 * it, not here.
 *
 * Icons are decorative by default. Every one of them sits beside a label, inside a
 * `Pressable` with its own `accessibilityLabel`, or both — so the mark repeats
 * something a screen reader has already read, and repeating it is how a tab gets
 * announced twice.
 */
import { View, type StyleProp, type ViewStyle } from 'react-native'
import Svg, { Circle, Path, Rect } from 'react-native-svg'

export type IconName =
  | 'chats'
  | 'activity'
  | 'crons'
  | 'settings'
  | 'sidebar'
  | 'search'
  | 'plus'
  | 'photo'
  | 'file'
  | 'close'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'ellipsis'
  | 'arrowRight'
  | 'arrowUp'
  | 'queue'
  | 'bellMuted'
  | 'pin'
  | 'grip'
  | 'mic'
  | 'check'
  | 'folder'
  | 'person'
  | 'server'
  | 'bell'
  | 'idCard'
  | 'book'
  | 'contrast'
  | 'lock'
  | 'bolt'
  | 'sliders'
  | 'info'

export interface IconProps {
  name: IconName
  /** How big the mark is drawn. */
  size?: number
  /** The box the mark is centred in; defaults to `size`. */
  slot?: number
  /** A resolved colour, not a role — see the note above. */
  color: string
  /** Overrides the weight derived from `size`. */
  strokeWidth?: number
  style?: StyleProp<ViewStyle>
  testID?: string
}

/**
 * The icon sizes the app actually uses, named for where they are.
 *
 * `tab` is the mark in the bottom strip and `tabSlot` the box around it; the two
 * differ, which is the whole point of the pair. `control` is the mark inside a
 * round glass button, `inline` a caret or a marker sitting in a line of text.
 *
 * `listMark` is a mark that describes a whole list ROW rather than a word in it
 * — the muted bell on a chat. It is bigger than `marker` on purpose: the owner
 * reported the bell as "small and not clear", and the reason was that a 13pt
 * marker is sized to sit beside metadata type, while this one has to be read
 * against the row's name at a glance from a scrolling list.
 */
export const ICON_SIZE = { tab: 20, tabSlot: 24, control: 19, listMark: 17, inline: 15, marker: 13 } as const

/** The default weight, as a fraction of the drawn size. 1.7 at 20pt, 1.3 at 15. */
function weightFor(size: number): number {
  return Math.max(1.2, Math.min(2.2, size * 0.086))
}

export function Icon({ color, name, size = ICON_SIZE.control, slot, strokeWidth, style, testID }: IconProps) {
  const box = slot ?? size
  const stroke = strokeWidth ?? weightFor(size)

  return (
    <View
      accessibilityElementsHidden
      // The third spelling, and the only one the web hears. `accessibilityElementsHidden`
      // is iOS and `importantForAccessibility` is Android; react-native-web honours
      // neither, so every mark in the app was a node in the accessibility tree —
      // which is what made a tab whose label is its own text (`SidebarFooter`, the
      // archived row, the DM rollup, `DisclosureRow`) read as unnamed to one screen
      // reader while Chrome's own tree computed a name for it anyway.
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[{ alignItems: 'center', height: box, justifyContent: 'center', width: box }, style]}
      // The slot and the mark are two different numbers, and a test that checks a
      // row of icons aligns has to be able to reach the first one. It cannot get
      // there from the mark: `react-native-svg` puts a wrapper of its own around
      // the view it renders, so "the parent" is its box rather than this one.
      testID={testID ? `${testID}-box` : undefined}
    >
      <Svg height={size} testID={testID} viewBox="0 0 24 24" width={size}>
        <Glyph color={color} name={name} stroke={stroke} />
      </Svg>
    </View>
  )
}

/** One stroked path with the shared caps, which is what most of these are. */
function Line({ color, d, stroke }: { color: string; d: string; stroke: number }) {
  return <Path d={d} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={stroke} />
}

/**
 * The gear's eight teeth, as short radial stubs just outside its ring.
 *
 * Generated rather than written out: eight hand-typed coordinate pairs are eight
 * chances for one tooth to sit a degree off, and the arithmetic is the drawing.
 *
 * The first attempt drew them long and thin, from r5.1 to r8.1, and on the iPad
 * it read as a SUN rather than a gear — thin rays radiating from a circle are a
 * sun, whatever they were meant to be. Teeth are short and thick and start at the
 * ring they belong to, so the mark reads as one toothed wheel instead of a disc
 * with spokes around it.
 */
const GEAR_RING = 6.1

const GEAR_TEETH = Array.from({ length: 8 }, (_, index) => {
  const angle = (index * Math.PI) / 4
  const at = (radius: number) =>
    `${(12 + radius * Math.cos(angle)).toFixed(2)} ${(12 + radius * Math.sin(angle)).toFixed(2)}`

  return `M${at(GEAR_RING - 0.4)} L${at(GEAR_RING + 2.1)}`
}).join(' ')

function Glyph({ color, name, stroke }: { color: string; name: IconName; stroke: number }) {
  switch (name) {
    /**
     * A speech bubble, which is what §6.8 of the token document draws and what the
     * filled circle it replaces never was.
     */
    case 'chats':
      return (
        <Line
          color={color}
          d="M7.8 4H16.2A3.8 3.8 0 0 1 20 7.8V13.2A3.8 3.8 0 0 1 16.2 17H10.8L7.8 20.3V17A3.8 3.8 0 0 1 4 13.2V7.8A3.8 3.8 0 0 1 7.8 4Z"
          stroke={stroke}
        />
      )

    /** Two arrows passing each other: one bot's message, and the reply coming back. */
    case 'activity':
      return (
        <>
          <Line color={color} d="M4 9H17.5M14.5 6L17.5 9L14.5 12" stroke={stroke} />
          <Line color={color} d="M20 15H6.5M9.5 12L6.5 15L9.5 18" stroke={stroke} />
        </>
      )

    case 'crons':
      return (
        <>
          <Circle cx={12} cy={12} fill="none" r={8} stroke={color} strokeWidth={stroke} />
          <Line color={color} d="M12 7.2V12.2L15.6 14.4" stroke={stroke} />
        </>
      )

    /**
     * Three bars waiting their turn, shortest at the front.
     *
     * Not a clock and not a list. A clock is what a cron wears, and a list says
     * "these are items" where the fact is "these have not gone yet" — the
     * shortening towards the front is the queue moving.
     */
    case 'queue':
      return (
        <>
          <Line color={color} d="M5 7H19" stroke={stroke} />
          <Line color={color} d="M5 12H15" stroke={stroke} />
          <Line color={color} d="M5 17H11" stroke={stroke} />
        </>
      )

    /**
     * A bell with a stroke through it: the chat is quiet on purpose.
     *
     * It used to be a rounded-top box under a diagonal, drawn at the 13pt marker
     * size, and the owner read it as what it was — "small and not clear". A box
     * is not a bell. What makes one legible is the SKIRT: the walls flare out at
     * the bottom and the base is wider than the dome, and that outline is what
     * the eye recognises before it has resolved anything inside it. The clapper
     * below the base is the second half of that reading, and it is affordable
     * now the mark is drawn at `listMark` rather than at `marker` — three marks
     * in thirteen points was a smudge, which is why the old one had two.
     *
     * The slash still runs the full diagonal. A slash that stops at the bell's
     * edge disappears into it.
     */
    case 'bellMuted':
      return (
        <>
          {/* Dome, walls, flared skirt, base — one closed outline. */}
          <Line
            color={color}
            d="M6.7 16.5V11.4A5.3 5.3 0 0 1 12 6.1A5.3 5.3 0 0 1 17.3 11.4V16.5L18.8 18.3H5.2Z"
            stroke={stroke}
          />
          {/* The clapper, hanging under the base. */}
          <Line color={color} d="M10.3 18.3A1.8 1.8 0 0 0 13.7 18.3" stroke={stroke} />
          <Line color={color} d="M4.6 4.6L19.4 19.4" stroke={stroke} />
        </>
      )

    /**
     * A pin seen from the side: a round head, a shaft, a point.
     *
     * Drawn upright rather than at the 45° a desk pin is usually shown at,
     * because this one sits in a row of marks that are all square to the text —
     * the bell beside it, the chevrons, the unread pill — and one glyph leaning
     * over reads as a rendering fault rather than as a style. Three marks is the
     * budget at the 13pt marker size, which is a tighter one than the muted
     * bell next to it works to.
     */
    /** The tick beside the row a list has already chosen. */
    case 'check':
      return <Line color={color} d="M5 12.8L9.6 17.2L19 7.2" stroke={stroke * 1.15} />

    /**
     * A folder, drawn as a tab and a body rather than as one outline.
     *
     * Two paths because a single rounded rectangle with a bump reads as a card
     * with a defect at this size. The tab is a short lid over the left third,
     * which is the shape every file manager has agreed on, and it is what keeps
     * this mark from being confused with the `sidebar` rectangle next to it.
     */
    case 'folder':
      return (
        <>
          <Line color={color} d="M3.5 7.5A1.6 1.6 0 015.1 5.9h3.6l1.9 2.2" stroke={stroke} />
          <Rect fill="none" height={10.6} rx={2} stroke={color} strokeWidth={stroke} width={17} x={3.5} y={7.5} />
        </>
      )

    /*
      The Settings categories' marks (HERM-108). Drawn in the same 24pt box, at
      the same stroke, from as few strokes as each one can be read in — they sit
      in a column of twelve and have to tell apart at a glance, not illustrate.
    */
    case 'person':
      return (
        <>
          <Circle cx={12} cy={8.4} fill="none" r={3.6} stroke={color} strokeWidth={stroke} />
          <Line color={color} d="M5 19.6A7 6.2 0 0 1 19 19.6" stroke={stroke} />
        </>
      )

    case 'server':
      return (
        <>
          <Rect fill="none" height={6.2} rx={1.8} stroke={color} strokeWidth={stroke} width={16} x={4} y={4.4} />
          <Rect fill="none" height={6.2} rx={1.8} stroke={color} strokeWidth={stroke} width={16} x={4} y={13.4} />
          <Line color={color} d="M7.6 7.5H8.4M7.6 16.5H8.4" stroke={stroke * 1.3} />
        </>
      )

    case 'bell':
      return (
        <>
          <Line
            color={color}
            d="M6.7 16.5V11.4A5.3 5.3 0 0 1 12 6.1A5.3 5.3 0 0 1 17.3 11.4V16.5L18.8 18.3H5.2Z"
            stroke={stroke}
          />
          <Line color={color} d="M10.3 18.3A1.8 1.8 0 0 0 13.7 18.3" stroke={stroke} />
        </>
      )

    case 'idCard':
      return (
        <>
          <Rect fill="none" height={13} rx={2.4} stroke={color} strokeWidth={stroke} width={18} x={3} y={5.5} />
          <Circle cx={8.8} cy={10.6} fill="none" r={1.9} stroke={color} strokeWidth={stroke} />
          <Line color={color} d="M5.9 15.6A3 2.4 0 0 1 11.7 15.6M14 10H18M14 13.6H17" stroke={stroke} />
        </>
      )

    case 'book':
      return (
        <>
          <Line color={color} d="M12 6.4C10 5 7.2 4.6 4.5 5V18C7.2 17.6 10 18 12 19.4V6.4Z" stroke={stroke} />
          <Line color={color} d="M12 6.4C14 5 16.8 4.6 19.5 5V18C16.8 17.6 14 18 12 19.4" stroke={stroke} />
        </>
      )

    /** Light and dark: a disc with one half drawn in. */
    case 'contrast':
      return (
        <>
          <Circle cx={12} cy={12} fill="none" r={7.8} stroke={color} strokeWidth={stroke} />
          <Path d="M12 4.2A7.8 7.8 0 0 1 12 19.8Z" fill={color} />
        </>
      )

    case 'lock':
      return (
        <>
          <Rect fill="none" height={9.4} rx={2.2} stroke={color} strokeWidth={stroke} width={14} x={5} y={10.4} />
          <Line color={color} d="M8.2 10.4V8A3.8 3.8 0 0 1 15.8 8V10.4" stroke={stroke} />
        </>
      )

    case 'bolt':
      return <Line color={color} d="M13.2 3.8L6 13.4H11.6L10.8 20.2L18 10.6H12.4Z" stroke={stroke} />

    case 'sliders':
      return (
        <>
          <Line color={color} d="M4.5 7.5H19.5M4.5 16.5H19.5" stroke={stroke} />
          <Circle cx={9} cy={7.5} fill="none" r={2.2} stroke={color} strokeWidth={stroke} />
          <Circle cx={15} cy={16.5} fill="none" r={2.2} stroke={color} strokeWidth={stroke} />
        </>
      )

    case 'info':
      return (
        <>
          <Circle cx={12} cy={12} fill="none" r={7.8} stroke={color} strokeWidth={stroke} />
          <Line color={color} d="M12 11V16.2M12 7.8V7.9" stroke={stroke * 1.15} />
        </>
      )

    case 'pin':
      return (
        <>
          <Circle cx={12} cy={7.4} fill="none" r={3.2} stroke={color} strokeWidth={stroke} />
          <Line color={color} d="M12 10.6V19.4" stroke={stroke} />
          <Line color={color} d="M8.4 10.6H15.6" stroke={stroke} />
        </>
      )

    case 'settings':
      return (
        <>
          <Line color={color} d={GEAR_TEETH} stroke={stroke * 1.55} />
          <Circle cx={12} cy={12} fill="none" r={GEAR_RING} stroke={color} strokeWidth={stroke} />
          {/* The bore. Without it the ring plus its teeth is a cog seen as a disc,
              and a gear is a thing with a hole in the middle. */}
          <Circle cx={12} cy={12} fill="none" r={2.3} stroke={color} strokeWidth={stroke * 0.9} />
        </>
      )

    /** A panel with its leading column drawn in: the thing the button hides and shows. */
    case 'sidebar':
      return (
        <>
          <Rect fill="none" height={14} rx={3} stroke={color} strokeWidth={stroke} width={17} x={3.5} y={5} />
          <Line color={color} d="M9.6 5V19" stroke={stroke} />
        </>
      )

    case 'search':
      return (
        <>
          <Circle cx={10.6} cy={10.6} fill="none" r={5.9} stroke={color} strokeWidth={stroke} />
          <Line color={color} d="M15 15L19.6 19.6" stroke={stroke} />
        </>
      )

    case 'plus':
      return <Line color={color} d="M12 5V19M5 12H19" stroke={stroke} />

    /**
     * The photo library: a frame with a hill and a sun in it.
     *
     * A frame on its own is a frame; the two marks inside are what make it a
     * PICTURE. The hill is drawn as two straight segments rather than a curve
     * because at 19pt a curve of this size renders as a slightly wobbly straight
     * line anyway, and a deliberate fold reads as a landscape.
     */
    case 'photo':
      return (
        <>
          <Rect fill="none" height={15} rx={3.4} stroke={color} strokeWidth={stroke} width={17} x={3.5} y={4.5} />
          <Circle cx={9} cy={9.6} fill="none" r={1.7} stroke={color} strokeWidth={stroke} />
          <Line color={color} d="M4.4 17.2L9.6 12.6L13 15.6L16.2 13L20.1 16.4" stroke={stroke} />
        </>
      )

    /**
     * A file: a sheet with its corner folded.
     *
     * The fold is two strokes and not a filled triangle, so the mark stays a line
     * drawing at the weight everything else in this set is drawn at.
     */
    case 'file':
      return (
        <>
          <Line
            color={color}
            d="M13.6 3.6H7.4A2.4 2.4 0 0 0 5 6V18A2.4 2.4 0 0 0 7.4 20.4H16.6A2.4 2.4 0 0 0 19 18V9Z"
            stroke={stroke}
          />
          <Line color={color} d="M13.4 3.8V8.8H18.8" stroke={stroke} />
        </>
      )

    case 'close':
      return <Line color={color} d="M6.6 6.6L17.4 17.4M17.4 6.6L6.6 17.4" stroke={stroke} />

    case 'chevronLeft':
      return <Line color={color} d="M14.8 5.4L8.2 12L14.8 18.6" stroke={stroke} />

    case 'chevronRight':
      return <Line color={color} d="M9.2 5.4L15.8 12L9.2 18.6" stroke={stroke} />

    case 'chevronDown':
      return <Line color={color} d="M5.4 9.2L12 15.8L18.6 9.2" stroke={stroke} />

    /**
     * Filled dots rather than three stroked rings: at control size a ring of this
     * radius closes up into a blob anyway, and a blob with a lighter middle reads
     * as a printing fault.
     */
    case 'ellipsis':
      return (
        <>
          <Circle cx={5.6} cy={12} fill={color} r={1.75} />
          <Circle cx={12} cy={12} fill={color} r={1.75} />
          <Circle cx={18.4} cy={12} fill={color} r={1.75} />
        </>
      )

    case 'arrowRight':
      return <Line color={color} d="M4 12H18.6M14 7.4L18.6 12L14 16.6" stroke={stroke} />

    /**
     * Send. The same arrow as `arrowRight`, turned a quarter and shortened.
     *
     * It was `↑`, a character, and it was the last glyph left in a round button
     * — with `+`, which this file's header already explains at length. The
     * symptom this time was vertical: a text glyph is centred by its LINE BOX,
     * and the ink inside that box is placed by the font's ascent and descent
     * rather than by its own extents, so both marks sat visibly low in their
     * circles in a browser. A path in a 24-box has no such opinion.
     *
     * The shaft stops short of the box on both ends so the mark reads as
     * centred in a circle rather than as filling it.
     */
    case 'arrowUp':
      return <Line color={color} d="M12 19.2V5.6M6.6 11L12 5.6L17.4 11" stroke={stroke} />

    /**
     * The drag handle every other list in the world draws: six dots in two
     * columns.
     *
     * Filled dots rather than two stroked columns, for the same reason
     * `ellipsis` is: at the size a handle is drawn a ring of this radius closes
     * into a blob anyway, and a blob with a lighter middle reads as a printing
     * fault.
     *
     * It replaces a pair of ↑/↓ buttons. Those were two 15pt text glyphs in a
     * 26pt column — three tap targets stacked in the space of one, where the
     * outer one (the column) was already the thing a reader is meant to hold —
     * so a finger aiming at the drag got a single-step move instead. Reordering
     * by keyboard and by screen reader did not go with them: it moved to the
     * row's `accessibilityActions` and to its context menu, which is where
     * assistive technology looks for it and where a mouse can reach it too.
     */
    case 'grip':
      return (
        <>
          {[8.2, 12, 15.8].map(y => (
            <Circle cx={9.2} cy={y} fill={color} key={`l${y}`} r={1.5} />
          ))}
          {[8.2, 12, 15.8].map(y => (
            <Circle cx={14.8} cy={y} fill={color} key={`r${y}`} r={1.5} />
          ))}
        </>
      )

    /**
     * A capsule in a cradle on a stem: the microphone every platform draws.
     *
     * The cradle is an arc rather than a full circle, and the stem is what makes
     * the mark read as a microphone rather than as a pill with a smile under it.
     * All three are strokes at the same weight so the button's dimmed state
     * fades evenly — a filled capsule beside a stroked cradle would keep its
     * density while the rest of the mark thinned out.
     */
    case 'mic':
      return (
        <>
          <Rect fill="none" height={10.4} rx={2.6} stroke={color} strokeWidth={stroke} width={5.2} x={9.4} y={3.2} />
          <Line color={color} d="M5.8 11.2A6.2 6.2 0 0 0 18.2 11.2" stroke={stroke} />
          <Line color={color} d="M12 17.4V20.8" stroke={stroke} />
        </>
      )
  }
}
