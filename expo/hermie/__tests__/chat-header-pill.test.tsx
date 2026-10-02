/**
 * The header pill's width, and the tool name that used to set it.
 *
 * The report was that the pill "resizes constantly while a bot works". It does not
 * have a width to resize: the pill hugs its contents, and the widest content was
 * whichever status line was current — `Online` for one frame and
 * `Running mcp__terminal__run_in_terminal…` for the next. Two things fix it and
 * both are pinned here: the status line is laid out so it cannot contribute a
 * width at all, and an MCP tool is named by its server before it ever gets here.
 *
 * The test renderer has no layout engine, so "the width does not change" is
 * asserted the only way it can be honestly: the subtree that DOES decide the width
 * — the name and the box around it — is identical across four different statuses,
 * and the status itself is inside an absolutely positioned view, which Yoga leaves
 * out of its parent's intrinsic size.
 *
 * The second report is further down. The pill grew a second line and was still
 * being sized to the first, so a name and a handle that both fitted the header
 * were both truncated; those tests hand in BOTH rulers and the room between the
 * buttons, because with no layout engine a measurement is the only honest way to
 * ask which line won.
 */
import { act, fireEvent, render } from '@testing-library/react-native'

import { ChatHeader, PILL_MIN_TEXT_WIDTH, pillTextWidth, widestStatus } from '../src/chat-ui/ChatHeader'
import { chatStrings } from '../src/chat-ui/strings'
import { OWN_CHAT_LABEL_MAX } from '../src/features/sessions'
import { AVATAR_SIZE, type PresenceState } from '../src/ui/tokens'
import { shortToolName, TOOL_NAME_MAX } from '../src/chat-ui/tool-label'
import { ThemeProvider, useTheme, type Theme } from '../src/ui/theme'

/**
 * The theme the provider actually resolved, so an assertion can name a token
 * rather than a hex string that moves the next time the ladder is retuned.
 */
let seen: Theme | undefined

function ThemeProbe() {
  seen = useTheme()

  return null
}

function header(subtitle: string, presence: PresenceState = 'working', name = 'Researcher') {
  return render(
    <ThemeProvider>
      <ThemeProbe />
      <ChatHeader name={name} onOpenOptions={() => undefined} presence={presence} subtitle={subtitle} />
    </ThemeProvider>
  )
}

const STATUSES = ['Online', 'Thinking…', 'Typing…', 'Running terminal…']

/**
 * Lay the ruler out, the way a real layout pass would.
 *
 * The test renderer has no layout engine, so the measurement has to be handed
 * in. That is not a weakening of the assertion — it is the whole mechanism
 * being tested: the pill is supposed to take ONE number from ONE view and
 * never ask anything else.
 *
 * The handler is called rather than dispatched, because the ruler is inert
 * (`pointerEvents="none"`) and `fireEvent` will not deliver to a view that
 * takes no events — which is correct of it, and not what is being tested here.
 */
function measure(tree: ReturnType<typeof header>, width: number) {
  const ruler = tree.getByTestId('chat-header-ruler', { includeHiddenElements: true })
  const onLayout = ruler.props.onLayout as (event: { nativeEvent: { layout: { width: number } } }) => void

  act(() => {
    onLayout({ nativeEvent: { layout: { width } } })
  })
}

/** The style the pill's text column actually resolved to. */
function columnStyle(tree: ReturnType<typeof header>): Record<string, unknown> {
  return tree.getByTestId('chat-header-text', { includeHiddenElements: true }).props.style as Record<string, unknown>
}

describe('the status line cannot widen the pill', () => {
  it('draws the status absolutely, so it is outside the pill’s intrinsic width', () => {
    const tree = header('Running terminal…')
    const status = tree.getByTestId('chat-header-status')
    const [floated] = status.children as { props: { style?: Record<string, unknown> } }[]

    expect(floated?.props.style).toMatchObject({ left: 0, position: 'absolute', right: 0 })
    // A fixed height, because an absolute child contributes no height either and
    // the name would otherwise sit on the pill's bottom rim.
    expect(status.props.style).toMatchObject({ height: 17 })
  })

  it('keeps the name — the one thing that decides the width — identical across statuses', () => {
    const widths = STATUSES.map(status => {
      const tree = header(status)
      const name = tree.getByText('Researcher')

      return JSON.stringify({ props: name.props.style, text: name.props.children })
    })

    expect(new Set(widths).size).toBe(1)
  })

  it('elides a long status inside that width rather than asking for more', () => {
    const tree = header('Running an extremely long tool name that could never fit…')

    expect(tree.getByText('Running an extremely long tool name that could never fit…').props.numberOfLines).toBe(1)
  })
})

/**
 * The transcript scrolls UNDER the header, so the pill's backdrop is whatever
 * bubble is passing behind it. A control wash alone lets that bubble's text
 * through the bot's name; the solid rung is what makes the pill's contrast a
 * number instead of a coincidence. Same rule, same reason, as `AttachMenu`.
 */
describe('the pill does not let the transcript read through it', () => {
  it('lays the control rung under the wash rather than staying transparent', () => {
    const tree = header('Online', 'online')
    const surface = tree.getByTestId('chat-header-pill-surface', { includeHiddenElements: true })
    const style = surface.props.style as Record<string, unknown>[]
    const flattened = Object.assign({}, ...style.filter(Boolean)) as Record<string, unknown>

    expect(seen).toBeDefined()
    expect(flattened.backgroundColor).toBe(seen?.glass.control.solid)
    expect(flattened.backgroundColor).not.toBe('transparent')
  })

  it.each([['chat-header-back-surface'], ['chat-header-options-surface']])(
    'gives %s the same rung, because one row is one material',
    testID => {
      const tree = render(
        <ThemeProvider>
          <ThemeProbe />
          <ChatHeader name="Researcher" onBack={() => undefined} onOpenOptions={() => undefined} subtitle="Online" />
        </ThemeProvider>
      )
      const surface = tree.getByTestId(testID, { includeHiddenElements: true })
      const style = surface.props.style as Record<string, unknown>[]
      const flattened = Object.assign({}, ...style.filter(Boolean)) as Record<string, unknown>

      expect(flattened.backgroundColor).toBe(seen?.glass.control.solid)
    }
  )

  it('gives the presence bead the same colour its ring already assumed', () => {
    const tree = header('Online', 'online')
    const surface = tree.getByTestId('chat-header-pill-surface', { includeHiddenElements: true })
    const style = surface.props.style as Record<string, unknown>[]
    const flattened = Object.assign({}, ...style.filter(Boolean)) as Record<string, unknown>

    // The bead draws a ring in `glass.control.solid` so that it reads as a hole
    // punched in the pill. That is only true once the pill IS that colour.
    expect(flattened.backgroundColor).toBe(seen?.glass.control.solid)
  })
})

describe('the pill takes one number and stops asking', () => {
  it('pins the text column to the measured name, so no status can reach the width', () => {
    const tree = header('Thinking…')

    // Before the ruler answers, the floor is all there is.
    expect(columnStyle(tree).width).toBeUndefined()
    expect(columnStyle(tree).minWidth).toBe(PILL_MIN_TEXT_WIDTH)

    measure(tree, 143.4)

    // An explicit width, not an intrinsic one: from here the column's size is a
    // stored number rather than a question anything can answer.
    expect(columnStyle(tree).width).toBe(144)
  })

  it('keeps that width equal across three states', () => {
    const widths = (['online', 'working', 'needsInput'] as PresenceState[]).map(presence => {
      const tree = header('', presence)

      measure(tree, 143.4)

      return columnStyle(tree).width
    })

    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBe(144)
  })

  it('keeps it equal across the statuses a working bot cycles through', () => {
    const widths = STATUSES.map(status => {
      const tree = header(status)

      measure(tree, 143.4)

      return columnStyle(tree).width
    })

    expect(new Set(widths).size).toBe(1)
  })

  it('re-measures when the BOT is renamed, which is the one thing that may move it', () => {
    const tree = header('Online', 'online', 'Al')

    measure(tree, 24)
    expect(columnStyle(tree).width).toBe(PILL_MIN_TEXT_WIDTH)

    tree.rerender(
      <ThemeProvider>
        <ChatHeader
          name="Alexandra the Researcher"
          onOpenOptions={() => undefined}
          presence="online"
          subtitle="Online"
        />
      </ThemeProvider>
    )
    measure(tree, 260)

    expect(columnStyle(tree).width).toBe(260)
  })

  it('never goes under the floor, whatever the ruler reports', () => {
    expect(pillTextWidth(0)).toBe(PILL_MIN_TEXT_WIDTH)
    expect(pillTextWidth(12)).toBe(PILL_MIN_TEXT_WIDTH)
    expect(pillTextWidth(200.1)).toBe(201)
  })
})

/**
 * The pill grew a second line — `handle · state` — and kept being sized to the
 * first one. The owner's header showed `Juno Mar…` over `techsupport · …` with
 * most of the row empty beside it: two truncations that had nothing to do with
 * the space available and everything to do with which line was measured.
 */
describe('a pill with two lines takes the width of the longer one', () => {
  function pill(subtitle: string, presence: PresenceState = 'online', name = 'Juno Marsh') {
    return render(
      <ThemeProvider>
        <ThemeProbe />
        <ChatHeader
          name={name}
          onOpenOptions={() => undefined}
          presence={presence}
          secondaryName="techsupport"
          subtitle={subtitle}
        />
      </ThemeProvider>
    )
  }

  /** The second ruler, laid out the same way the first one is. */
  function measureSecondary(tree: ReturnType<typeof pill>, width: number) {
    const ruler = tree.getByTestId('chat-header-ruler-secondary', { includeHiddenElements: true })
    const onLayout = ruler.props.onLayout as (event: { nativeEvent: { layout: { width: number } } }) => void

    act(() => {
      onLayout({ nativeEvent: { layout: { width } } })
    })
  }

  /** The centring column between the header's buttons: how much room there is. */
  function measureRoom(tree: ReturnType<typeof pill>, width: number) {
    const room = tree.getByTestId('chat-header-room', { includeHiddenElements: true })
    const onLayout = room.props.onLayout as (event: { nativeEvent: { layout: { width: number } } }) => void

    act(() => {
      onLayout({ nativeEvent: { layout: { width } } })
    })
  }

  it('sizes to the second line when the second line is the long one', () => {
    const tree = pill('Online')

    measure(tree, 86)
    measureSecondary(tree, 152.2)

    expect(columnStyle(tree).width).toBe(153)
  })

  it('still sizes to the name when the NAME is the long one', () => {
    const tree = pill('Online')

    measure(tree, 204)
    measureSecondary(tree, 120)

    expect(columnStyle(tree).width).toBe(204)
  })

  it('reserves room for the widest state rather than the one the bot is in', () => {
    const ruler = pill('Online').getByTestId('chat-header-ruler-secondary', { includeHiddenElements: true })
    const [text] = ruler.children as { props: { children: string } }[]

    expect(text?.props.children).toBe('techsupport · Waiting for you')
  })

  it('keeps that width equal across three states', () => {
    const widths = (['online', 'working', 'needsInput'] as PresenceState[]).map(presence => {
      const tree = pill('', presence)

      measure(tree, 86)
      measureSecondary(tree, 152.2)

      return columnStyle(tree).width
    })

    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBe(153)
  })

  it('keeps it equal across the statuses a working bot cycles through', () => {
    const widths = STATUSES.map(status => {
      const tree = pill(status, 'working')

      measure(tree, 86)
      measureSecondary(tree, 152.2)

      return columnStyle(tree).width
    })

    expect(new Set(widths).size).toBe(1)
  })

  it('never asks for more than the header has left between its buttons', () => {
    const tree = pill('Online')

    measure(tree, 86)
    measureSecondary(tree, 400)
    measureRoom(tree, 240)

    // The room the TEXT has is the column less the pill's own furniture: the
    // avatar, the gap in front of it and the padding either side.
    const chrome = seen!.space.xs + AVATAR_SIZE.header + seen!.space.sm + seen!.space.md

    expect(columnStyle(tree).width).toBe(240 - chrome)
    expect(columnStyle(tree).width).toBeLessThan(400)
  })

  it('leaves the width alone while nothing has measured the room yet', () => {
    const tree = pill('Online')

    measure(tree, 86)
    measureSecondary(tree, 400)

    expect(columnStyle(tree).width).toBe(400)
  })

  it('gives the status all the give, so the handle is never the half that elides', () => {
    const tree = pill('Running an extremely long tool name that could never fit…', 'working')
    const handle = tree.getByTestId('chat-header-handle')
    const fade = tree.getByTestId('chat-header-status-fade')

    const handleStyle = Object.assign(
      {},
      ...(handle.props.style as Record<string, unknown>[]).filter(Boolean)
    ) as Record<string, unknown>

    expect(handle.props.numberOfLines).toBe(1)
    expect(handleStyle).toMatchObject({ flexShrink: 0, maxWidth: '100%' })
    expect(fade.props.style).toMatchObject({ flexShrink: 1 })
  })

  it('draws the two halves as one line, separated', () => {
    const tree = pill('Online')

    expect(tree.getByTestId('chat-header-handle').props.children).toBe('techsupport')
    expect(tree.getByText(/^· Online$/)).toBeTruthy()
  })
})

describe('the status a ruler reserves room for', () => {
  it('is the longest of the ones offered', () => {
    expect(widestStatus(['Online', 'Waiting for you', 'Running'])).toBe('Waiting for you')
  })

  it('is the empty string when nothing is offered, so no room is reserved', () => {
    expect(widestStatus([])).toBe('')
  })
})

describe('a width that has two measurements to take', () => {
  it('takes the larger, and the floor when both are small', () => {
    expect(pillTextWidth(40, 60)).toBe(PILL_MIN_TEXT_WIDTH)
    expect(pillTextWidth(120, 60)).toBe(120)
    expect(pillTextWidth(60, 120.2)).toBe(121)
  })

  it('never exceeds the room it was given, and ignores a room nobody measured', () => {
    expect(pillTextWidth(300, 0, 200)).toBe(200)
    expect(pillTextWidth(300, 0, 0)).toBe(300)
    expect(pillTextWidth(150, 0, 220.8)).toBe(150)
  })
})

describe('what a tool is called in a status line', () => {
  it.each([
    ['mcp__terminal__run_in_terminal', 'terminal'],
    ['mcp__terminal__read_terminal', 'terminal'],
    ['mcp__fullstackstudio__list_customers', 'fullstackstudio'],
    ['mcp__ccd_session__mark_chapter', 'ccd_session'],
    ['mcp__github__create_pull_request', 'github']
  ])('names %s by its server: %s', (raw, expected) => {
    expect(shortToolName(raw)).toBe(expected)
  })

  it.each([
    ['Bash', 'Bash'],
    ['Read', 'Read'],
    ['str_replace_editor', 'str_replace_editor'],
    ['web_search', 'web_search']
  ])('leaves %s alone, because it is already its own name', (raw, expected) => {
    expect(shortToolName(raw)).toBe(expected)
  })

  it('caps a name no rule can shorten', () => {
    const long = shortToolName('a_very_long_tool_name_from_somewhere')

    expect(long).toBe('a_very_long_tool_…')
    expect(long.length).toBe(TOOL_NAME_MAX)
  })

  it('caps an MCP server whose own name is the long part', () => {
    expect(shortToolName('mcp__an_extremely_long_server_name__do_something')).toBe('an_extremely_long…')
  })

  it('answers nothing for nothing, so the caller can fall back to Working…', () => {
    expect(shortToolName('')).toBe('')
    expect(shortToolName('   ')).toBe('')
  })

  it('does not treat a double underscore that is not a namespace as one', () => {
    expect(shortToolName('read__file')).toBe('read__file')
  })
})

/**
 * The header's own conversations button (Task 6): the trailing group's round
 * button, left of `(…)`, present exactly when `ChatScreen` has an entry point
 * to offer — a gateway `canCreate` has said yes to.
 */
describe('the conversations button', () => {
  it('is absent when the caller has nowhere to send the tap', () => {
    const tree = render(
      <ThemeProvider>
        <ChatHeader name="Researcher" onOpenOptions={() => undefined} />
      </ThemeProvider>
    )

    expect(tree.queryByTestId('chat-header-conversations')).toBeNull()
  })

  it('sits in the trailing group and calls back on press', () => {
    const onOpenConversations = jest.fn()
    const tree = render(
      <ThemeProvider>
        <ChatHeader name="Researcher" onOpenConversations={onOpenConversations} onOpenOptions={() => undefined} />
      </ThemeProvider>
    )

    fireEvent.press(tree.getByTestId('chat-header-conversations'))

    expect(onOpenConversations).toHaveBeenCalled()
    // Left of `(…)`: same trailing group, the conversations button drawn first.
    expect(tree.getByTestId('chat-header-options')).toBeTruthy()
  })
})

/**
 * `secondaryName` becomes a conversation's own label once sub-chats are on
 * (`ChatScreen`), which can run up to `OWN_CHAT_LABEL_MAX` characters — longer
 * than the bot's other name ever was. The pill still takes one number and
 * elides inside it, the same rule R4 pinned for the status half.
 */
describe('a conversation label on the second line', () => {
  it('elides a label at the cap rather than asking the pill to grow for it', () => {
    const longest = 'A'.repeat(OWN_CHAT_LABEL_MAX)
    const tree = render(
      <ThemeProvider>
        <ChatHeader name="Researcher" onOpenOptions={() => undefined} secondaryName={longest} subtitle="Online" />
      </ThemeProvider>
    )

    const handle = tree.getByTestId('chat-header-handle')

    expect(handle.props.children).toBe(longest)
    expect(handle.props.numberOfLines).toBe(1)
    // The same clamp the status half already had: `maxWidth: '100%'` rather
    // than letting the label run past the pill's own rim.
    expect(Object.assign({}, ...(handle.props.style as Record<string, unknown>[]).filter(Boolean))).toMatchObject({
      maxWidth: '100%'
    })
  })

  it('says "Group chat" for the group and nothing else, when the caller passes it', () => {
    const tree = render(
      <ThemeProvider>
        <ChatHeader
          name="Researcher"
          onOpenOptions={() => undefined}
          secondaryName={chatStrings.conversations.groupChat}
          subtitle="Online"
        />
      </ThemeProvider>
    )

    expect(tree.getByTestId('chat-header-handle').props.children).toBe(chatStrings.conversations.groupChat)
  })
})
