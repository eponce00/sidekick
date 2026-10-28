# SideKick UI guidelines

SideKick uses a quiet, workspace-first visual system. The chat is the primary surface; files,
browser, terminal, and settings should support it without competing for attention.

## Design principles

- Preserve the workspace. At compact widths, secondary panels overlay or collapse instead of reducing the chat to an unusable column.
- Use elevation sparingly. Surfaces, borders, and shadows should explain hierarchy rather than decorate every element.
- Keep accent color meaningful. Accent is reserved for active state, focus, progress, primary action, and links.
- Make empty states useful. Explain what appears in the surface and offer a concrete next action when one exists.
- Keep controls accessible. Interactive rows must be keyboard reachable, icon-only buttons need accessible names, and focus must remain visible.

## Tokens

Global tokens live in `src/renderer/src/styles/App.css`. Component styles should use the shared aliases instead of introducing hard-coded neutral colors:

- Surfaces: `--app-bg`, `--surface-0` through `--surface-4`
- Borders: `--border-subtle`, `--border-color`, `--border-strong`, `--card-edge` for the outer
  edge of a raised group on the canvas (see Rows, cards and chips), `--panel-border` for floating
  surfaces (in the dark theme about `#333` over a card, near `--border-strong`, so a menu that
  shares the fill of the card under it keeps an edge), and `--rail-border` for the hairline
  between the chat and its rails (the sidebar, the side panel, the Settings navigation)
- Text: `--text-primary`, `--text-secondary`, `--text-muted`, and `--content-color` for reading
  text (chat prose and the file viewer's documents), a step under `--text-primary` in the dark
  theme so long passages are not drawn at full brightness; their headings and strong text stay
  `--text-primary`. In the light theme it equals `--text-primary`.
- Accent: `--accent`, `--accent-strong`, `--accent-subtle`, `--accent-muted`, and `--on-accent`
  for anything drawn on an accent fill (dark accents are light, so white text would not read)
- Semantic: `--color-success`, `--color-error`, `--color-warning` for text and icons; the
  `-fill` variants for filled controls carrying `--on-semantic` text; the `-subtle` variants for
  tinted backgrounds; `--color-warning-mark` for a warning drawn with no text on it (a status dot,
  a fill), which needs only 3:1, so the light theme can use a brighter orange than its text colour
  (equal to `--color-warning` in the dark theme); `--color-error-mark` likewise for an error drawn
  with no text (a failed dot), a brighter rose in the light theme so a 6px failed dot stays apart
  from the near-black unread one (equal to `--color-error` in the dark theme). Text and icons keep
  `--color-error`. `--error`, `--danger`, `--success`, and `--warning` are aliases of these.
- Interaction: `--focus-ring`, `--shadow-panel`, `--shadow-md`, motion duration and radius tokens

- Brand: `--brand-helmet`, `--brand-shade`, `--brand-visor`, `--brand-glint`, and `--brand-led`
  colour the robot wherever the app draws it. The helmet sits a step under white in the dark theme
  and lower still in the light one, where it has to keep its shape on a pale surface; the LEDs stay
  at full brightness, so they are the one bright thing.

Type and shape stay on fixed scales rather than ad-hoc values:

- Sizes: `--text-xs` (11px) through `--text-3xl`. 11px is the floor for text; `--text-2xs` (10px)
  exists only for a numeral or initial inside a fixed circle of 21px or less. Reading text (chat
  prose, the user's message, and the file viewer's documents) uses `--content-text` (14px) at
  `--content-leading` (1.6), so a document is never set larger than the reply that cites it.
  Code (a command and its output, live output, fenced code blocks, a change card's paths, and the
  Terminal panel) uses `--code-text` (12px) at `--code-leading` (1.5); inline code and file chips
  in prose stay at 0.9em of the text around them. Headings in the file viewer take the chat's
  ramp (h1 1.32em with a hairline under it, h2 1.18em, h3 1.1em, all 600 `--text-primary`), and
  the space above an h2 is at most `--space-6`. A horizontal rule takes `--space-5` on each side,
  and a heading straight after it only `--space-3`, so a rule never adds more than one step.
- Secondary text that carries the content (the pull-request bar, a command's status row, diff
  counts, the Sources row, a question's progress and chips) is `--text-sm`; `--text-xs` is for
  footnotes such as timestamps and credits.
- Diff counts are drawn by one `DiffCounts` component, in the surrounding sans, tabular figures:
  additions `--color-success`, deletions `--color-error`, and a zero count `--text-muted`, so
  colour appears only where lines changed. A change card for one file shows its counts only in
  its header, not again on the file's row.
- Weights: 400, 500, 600, 700. Inter is loaded at exactly these four; any other value silently
  rounds to one of them, so writing it only hides the real weight.
- Radius: `--radius-xs` through `--radius-xl` and `--radius-full`.

## Brand

SideKick is a superhero's robot sidekick: a helmet in the tile's continuous-corner shape, a glass
visor cut like a domino mask with pointed tips, pixel LED eyes, an antenna, an ear module, and a red
cape fastened with a badge that carries a prompt chevron, flying in from the side of its tile.
Surfaces, text, and borders are pure greys with no hue, so the interface stays quiet and colour
means something. Accents are soft: the default Blue (`#86AEE8`, deepening to `#2850B8` in light
themes so it reads as text), with the other palettes in Settings, among them Lime, the icon's LED
colour, and Mono, which uses no colour at all. The robot on an empty chat lights its LEDs in each
palette's full-brightness shade, so it stays the one bright thing on screen.

- The robot is drawn once, in `scripts/generate-brand-assets.cjs`, which writes the app icon, its
  small cut for 16 to 32 px, and the peeking robot on an empty chat. Change the drawing there and
  run it; never edit the generated files. The cape is one piece of fabric with a softly waving hem
  and two creases, as the app's moving cape draws it. The small cut keeps a plain cape but leaves
  out the creases, the badge and the mask's tips, which are noise at 16 px.
- Semantic colours stay clear of the accent's hue so a working dot is never mistaken for a warning
  or a failure at 6 px: warnings are orange rather than yellow, and errors are rose.
- The robot appears where it adds character and no information: the icon, the title bar, the
  loading screen, and an empty chat, where it leans out from behind the side panel and blinks now
  and then. It is decoration, hidden from screen readers.
- On an empty chat its cape is cloth (`utils/capeCloth.ts`): a Verlet-integrated chain from the
  neck to the hem, with one piece of fabric drawn around it, so it folds wherever it bends, its
  creases deepen with the bend, and it shades toward the neck. Gravity drapes it, a light breeze
  sways it, a gust now and then streams it back with ripples running down it, the pointer pushes
  the cloth where it brushes through, and a click flicks it up. Streaks
  (`utils/windStreaks.ts`) sweep past behind the robot while the wind blows, with a burst as a gust
  arrives, so it is plain what moves the cape. With reduced motion the cape stays as drawn.

Both dark and light themes must define every shared alias, and every `var(--…)` a component uses
must exist in `App.css`: an undefined token is not a fallback, it invalidates the whole declaration.
Text and its background must reach 4.5:1 in both themes; interactive controls need a 24px minimum
hit target. New motion must also behave correctly under `prefers-reduced-motion`.

## Surfaces and patterns

Every menu, popover, dialog, toolbar and card follows one pattern for its kind, so the app reads as
one product rather than a set of screens built one at a time. Prefer reusing the component that
already draws a pattern (`AppMenuHost`'s `.app-menu`, `Select`, `ConfirmDialog`,
`components/SettingsLayout.tsx`) over a new look.

**Colour.** Greys carry the interface; colour is a signal. The accent marks exactly: the selected
or active item, keyboard focus, progress or something live, the one primary action of a view, and
links in prose, which keep their site icon.
It is not decoration: icons, headings, chips, counts, badges, borders and empty-state art are grey
(`--text-secondary` / `--text-muted`) unless they show one of those states. A view shows at most one
accent-filled control. Semantic colours (`--color-success`, `--color-warning`, `--color-error`) mean
only what they say. Use the accent's own steps for its states (`--accent-subtle` for a selected
row's tint, `--accent-muted` for a pressed or stronger tint, `--accent-strong` for hover on an
accent fill) rather than ad-hoc `color-mix` percentages.

**Elevation.** Three levels and no others. In the dark theme the chat (`--app-bg`) is the deepest
surface and the sidebar, side panel and title bar sit one step up on `--surface-0`; in the light
theme the chat is a near-white canvas with that chrome on a rail a few percent darker, cards step
up to white `--surface-1`, and fills (`--surface-2`: the composer, the user's message, chips) step
down, so every "one surface up" pairing is a visible step in both. In the light theme the fills
sit a step under the rail too, so a chip or a hover on the sidebar still shows. Flat content on
`--surface-0`/`--surface-1`; raised
groups (`SettingsSection`, cards) on `--surface-1` with `--card-edge` and no shadow; floating
surfaces (menus, popovers, dialogs, the annotation bar) on `--surface-1` or `--surface-2` with
`--panel-border` and `--shadow-panel`; a small floating control (the jump-to-latest button) takes
the lighter `--shadow-md`. Fills, the composer among them, take no shadow. The light theme's
composer is the one exception to it being a fill: a grey box on the near-white canvas read as
disabled, so there it is a raised white control (`--surface-1` with a `--border-color` border,
as a light secondary button is), still with no shadow; its chips step down to `--surface-2`, and
the user's message stays `--surface-2`. The composer's fills are tokens (`--composer-bg`,
`--composer-chip-bg`, `--composer-chip-hover-bg`, `--send-disabled-bg`), so each theme sets them
once.
`--shadow`, `--shadow-lg` are colours, not shadows.

**Menus** (any list of actions that opens from a button): `.app-menu` look — `--surface-1` at 97%,
`--panel-border`, `--radius-md`, `--shadow-panel`, 4px padding, rows 30px tall with a fixed 18px
icon column (and, on a list of choices, a fixed trailing check column on every row, so trailing
text shares a right edge), label in `--text-secondary` turning `--text-primary` on hover/active with a
`--surface-3` row tint, shortcuts right-aligned in `--text-muted`, hairline separators, group
headings in the shared `.section-heading` style. A heading alone starts a group: no hairline is
drawn directly above one, a heading after the first takes 8px of space above it instead, and a
hairline splits off only a group without a heading. Icons in menus are grey. Checked items show a
check, not a colour, and no state changes a row's weight. An action never shows a check; when it
changes something the user has chosen, such as the project folder, the current value is
right-aligned `--text-muted` text that ellipsizes. A group heading starts on the icon column's
left edge, the rows' own inline padding. Trailing text keeps at least 16px from the label it
follows, which ellipsizes first. Rows that explain themselves (the `+` menu's Agent behavior group)
put the description in a fixed second column in `--text-muted`, so descriptions share a left edge.

**Search fields**: one `SearchField` for every searchable list (the sidebar's chats, the Settings
navigation, a provider's models): a `--surface-2` fill with no border, `--radius-sm`, 30px tall in
chrome and 32px in a settings page, a 14px search glyph in `--text-muted` 10px from its edge, text
in `--text-secondary` with a `--text-muted` placeholder, and the standard `--focus-ring`.

**Section headings**: one look for a small heading over a group of rows, `.section-heading` in
`App.css`: `--text-sm`, weight 500, `--text-muted`, sentence case with no letter-spacing, so a
project folder's name reads as written. The sidebar's groups, menu groups, and the side panel's
folder and terminal list headings use it, as does the settings navigation once it has more than one
group; a single group takes no heading, since the title bar already says Settings.

**Selection and weight**: selecting a row never adds weight beyond 500. A selected or highlighted
row (a menu or the command palette's row, the settings navigation, the sidebar tree) shows by its
`--surface-3` tint and `--text-primary` text; rows that are 400 stay 400, and 500 is the most a
selected row or a folder in the file tree takes. No state adds weight either: a manager's steps
share one weight whether open or done, and colour alone says which. A list row's name (a
provider, a model) is a row label, 500. Weight 600 is for headings: a page or section title, a
question, a card's title, a detail pane's title. A form field's value is 400, so it is quieter
than its label.

**Popovers** (a small panel of information or controls): the menu's surface and border, `--radius-md`
or `--radius-lg`, 12px padding, a title in `--text-primary` 600 and body in `--text-secondary`.
No icon tile in the header. They close on outside click and Escape, and return focus.

**Dialogs**: `ConfirmDialog`'s frame. A title (`--text-lg`, 600) and at most one line of
description; content in plain rows, not a stack of bordered cards; footer with secondary actions
left of the primary on the right, one primary only; destructive actions use the danger style. No
decorative icon tile beside the title unless it identifies something specific (a provider, a browser).

**Toolbars and tabs**: icon buttons 28–32px with `--radius-sm` or round, grey icons, `--surface-2`
hover, `--surface-3` pressed/active; text labels only where an icon is ambiguous. Tabs show the
active one by surface and text weight, not by colouring it. A side-panel tab whose app waits on
the user carries the shared `.count-badge` on its icon, and one whose app is working a 6px accent
dot; the selected tab carries neither, since the app it shows says its own state. Folded to its 48px rail, the panel's app buttons
carry the same badge (the number of sessions waiting, ringed in `--surface-0`), where an app
that is only working keeps its 6px accent dot. The panel's second row under its tabs (the Files
folder header, the file viewer's header) is one height, `--panel-header-height`, so switching apps
does not move the first row of content; its buttons are `settings-ghost-action is-small is-icon`,
the last one under the tab strip's fold button.

**Rows, cards and chips**: lists are rows split by hairlines inside one group, not one bordered
card per item. Use a card only for an object the user acts on as a whole (an attachment, a tool
result, a map), with its header and rows on one surface split by `--border-subtle`. Every raised
group's own edge (the change card, the Sources chips, the welcome suggestions, a `SettingsSection`
group, the providers' list and detail pane) is `--card-edge`: `--border-subtle` in the dark theme,
and `--border-color` in the light one, where `--border-subtle` all but vanishes between white and
the near-white canvas; the hairlines between its rows stay `--border-subtle` in both. The question
card keeps `--border-color` in both themes. Chips are
`--radius-full`, `--surface-2`, `--text-secondary`, 22–24px tall, and one surface off the
composer (`--composer-chip-bg`: `--surface-3` on the dark theme's `--surface-2` box,
`--surface-2` on the light theme's white one); a chip turns accent (`--accent-subtle` under
`--accent` text) only when it is selected. A chat's status chip colours only its dot; its words
stay grey, and a worker in another project names that project as a third `·` segment in
`--text-muted` ("api-contract · Working · sidekick-api"), not as a pill inside the chip. The pull-request bar
draws its state ("Blocked") the same way, a 6px dot and a `--text-secondary` word, so its diff
counts are its only coloured text. Its checks control is a ghost dropdown like the composer's: no
fill or border at rest, the bar's height, `--radius-sm`, its dot, a `--text-sm` word and a 12px
`--text-muted` chevron, `--surface-2` with `--text-primary` on hover and focus and
`--surface-3` while open. Its groups (the pull request and its state, its lines, its
checks, the branch) sit 12px apart, and the branch alone ellipsizes, with its full name in its
tooltip; it is set in the bar's sans type (`--text-sm`, `--text-muted`), so the bar is one family,
while `$ command` lines, the terminal and change-card paths keep `--code-text` mono. In a
manager's task list a step whose chat waits on the user is marked with `CircleAlert` in
`--color-warning`, and a step's worker chip trails its title on one 32px line, dropping under it
only when the card is narrower than 480px. A count on a button is one `.count-badge`: 16px on the button's top-right corner, cut
out of the glyph by a ring in the rail's surface, `--surface-4` for a total and
`--color-warning-fill` for a count waiting on you. On the folded rail the Projects and Chats
buttons carry their grey totals, and the sidebar toggle carries the waiting count, since expanding
leads back to the filter it belongs to.
The one holding the open chat shows it by a `--text-primary` icon with no resting tint, since a
tint means a pressed or open control.

**Work steps**: a work block's header ("7 tools · 2 thoughts"), a reply's tool, thought and patch
rows, and an answered question, are one height (`--work-row-height`, 28px) and one size
(`--text-md`), with the chevron 6px after the label; the header is quieter than prose by colour
alone (`--text-secondary`), and a thought differs only by `--text-muted` and its own icon. A
thought's one-line preview stops at `--work-thought-max` (40ch) with an ellipsis, so its chevron
stays near the tool rows'; the whole line is its tooltip and the opened detail. A step's status mark and its 12px disclosure chevron follow the label 6px after
it (`.work-row-marks`), not the column's far edge, so a failure reads with its step. A step that
is already done when it appears shows no mark; one that finishes on screen shows its success mark
briefly and then removes it, so a done step's chevron is always 6px after its label. An opened
work block starts its steps on the column's edge, like its header. Every step's detail (live
output, a command's result, the thought's text) starts at `--work-indent`, the label's edge. A
command's result is one bordered box headed by the `$ command` line, which carries its Copy and
Open in Terminal actions at its end (the Open in Terminal slot is kept, empty, on a command with no
terminal, so Copy sits at one offset on every box); under it come the exit code (coloured only when it failed),
then stdout and stderr, each under the same quiet label, as sections split by hairlines, the whole
box on one `--surface-2` fill. A running or background command draws the same box, headed by the
same `$ command` line and its actions, around its live output, and ends it with one 28px section,
split off by the same hairline and on the same fill: status on the left, its Stop (and, while it
holds the agent, Background) as `settings-ghost-action is-small` on the right. The live box is the
step's open detail, so its chevron points down while it shows, and the row folds it away. Every stop control (this row, the Terminal panel, the composer, a manager's Stop all) draws
`StopGlyph`, one small filled square, beside a `--text-secondary` label; a hollow one reads as an
unchecked checkbox. One that stops several things at once takes the danger colours only on hover
and focus, so at rest the bar's red belongs to a failure.

**Questions**: a pending question is a plain `--surface-1` card with no coloured border or fill.
Its options are rows, plain at rest and on the question's text edge, that take a menu row's
full-width `--surface-3` tint on hover and keyboard focus, and `--accent-subtle` only once
chosen. Its footer's Cancel and Skip are ghost buttons, flush with the card's content edges.

**Terminal panel**: the selected terminal's header has the command box's anatomy in two fixed
lines. Row 1 is the `$ command` in `--code-text`, ellipsized with the full command as its
tooltip, and its Copy, Background and Stop at its end as `settings-ghost-action is-small is-icon`.
Row 2 is one 28px line: a 6px state dot (`--color-warning-mark` waiting, `--accent` running), the
status in `--text-sm` `--text-secondary` with its trailing spaces trimmed, a `·` drawn as its own
`--text-muted` item, then the folder in `--text-muted`, all 6px apart; the status ellipsizes
first, except while the terminal waits, when the status is the instruction and the folder yields
first so it stays whole; the whole line is its tooltip. The terminal body sits on the panel's own surface
(`--surface-0`), and xterm lifts any ANSI colour under 4.5:1 against it. Below 420px the session
list is a 40px rail of 28px icon buttons with 16px glyphs, each with its own state dot cut out on
its corner like a `.count-badge` and a tooltip naming the session and its state. The rail's top
cell, the `+`, spans the selected terminal's two header rows, so its hairline continues the
header's. The user's shells
keep their terminal glyph; an agent session, which would otherwise share one glyph with every
other, draws its place in the list (1, 2, 3) in the glyph's slot, `--text-xs` 500 tabular figures
in `--text-secondary`, `--text-primary` when selected.

**Sidebar tree**: every row uses one grid, chevron and icon columns then the title and its meta,
so titles at one depth share a left edge; each level is indented by `--tree-indent`. Every one-line
row (a project, a chat, a schedule, Phone, New chat) is one 32px pitch (`--sidebar-row-height`),
with no margin between rows; the Files tree is denser, at `--work-row-height` (28px). Text sizes
are the same in both. A manager's two-line row keeps its own height. Above the tree, fixed while it
scrolls, one labelled New chat row on the same grid (16px `SquarePen` in the icon column) opens
the same new chat as Ctrl+N; each project keeps its own New chat action. Inactive
titles are `--text-secondary`, the selected one `--text-primary` 500. Hover actions float over the
row's end rather than reserving width, and a status dot takes room only on rows that have one.
Meta sits inline after the title as `·`-separated `--text-muted` text, never a filled chip (a
worker in another project reads "api-contract · sidekick-api"), with one exception: a manager's row puts its workers' status
summary ("1 needs you · 2 working") on a second line under its title, in `--text-xs`
`--text-muted`, since it is too long to share the title's line.

The phone companion sits under the tree. Expanded, it is a top-level row on the tree's grid: the
16px phone glyph in the icon column in `--text-muted`, "Phone" in `--text-secondary` (both a step
brighter on hover and while its panel is open), and, while a phone is connected, the shared 6px
dot in the accent with no halo in the row's status slot, since a connection is not live work. On
the folded rail it is an icon button whose dot sits on the glyph's corner, cut out of it by a ring
in the rail's surface like the Terminal rail's state dots. No phone connected, no dot.

A chat's state is one 6px dot (`.conversation-run-indicator`, shared by the tree, the folded rail
and its filters). Accent means live work only, and only the live states carry a 3px halo:

| State   | Dot                                             | Halo                     |
| ------- | ----------------------------------------------- | ------------------------ |
| Working | `--accent`, pulsing                             | `--accent-muted`         |
| Waiting | `--color-warning-mark`, steady                  | `--color-warning-subtle` |
| Unread  | `--text-primary` (done, not yet read)           | none                     |
| Failed  | `--color-error-mark`                            | none                     |
| Queued  | 1.5px dashed `--accent` ring inside the 6px box | none                     |
| Stopped | 1.5px `--text-muted` ring inside the 6px box    | none                     |

**Icon tiles**: a tinted square behind an icon is not a default decoration. Use it only for an
identity (an app in the launcher, a provider, a browser), and then grey (`--surface-2`), not accent.

**Copy**: one short line where a paragraph was. Say it once: a heading and its description must
not repeat each other, and a status already shown by a control is not also written out. Secondary
facts go to `title` tooltips or a quiet footnote.

**Motion**: menus and popovers use the existing `motion-menu-down-in` / `motion-fade-in`; nothing
bounces or loops except something live, and everything stops under reduced motion.

## Layout behavior

- The left history rail is expanded by default and can collapse to a 48px shortcut rail.
- The right workspace panel holds tabs in stacked sections (`src/renderer/src/components/sidePanel`); each app (Files, Browser, Terminal, Chats) opens in at most one tab. It starts
  expanded on viewports at least 1100px wide and collapsed below that threshold unless the user
  has saved a preference. Until the user drags its edge it is about 28% of the window, between
  320 and 440px, so the chat stays the primary surface; the sidebar folds to its rail before the
  chat drops below 640px (`MIN_SIDE_BY_SIDE_CONVERSATION_WIDTH`), so a 900px window with the
  panel open or folded to its rail shows the sidebar's rail. A sidebar the user opens on purpose
  stays open, and the panel narrows instead.
- Browser-only size controls belong inside the Browser panel. The live page takes the available
  height while concise session activity stays anchored below it.
- At 767px and below (`ACTIVITY_PANEL_OVERLAY_MAX_VIEWPORT`), an expanded workspace panel overlays
  the chat.
- Below 760px, an expanded history sidebar overlays the chat and suggested prompts become a single column.
- Messages, the composer, and the bars around it share one conversation column
  (`--chat-content-max`, 760px, about 90 characters of prose, inset by `--chat-gutter`, which
  follows the chat pane's own width; a wider pane becomes gutter). The prose, work steps, cards,
  a manager's rows and task list, and the Sources row span it edge to edge. The user's message is a
  `--surface-2` bubble sized to its words (at most 80% of the column, `--radius-lg`, 10px 14px
  padding) with its right edge on the column's edge. The composer's box reaches past the column
  only by its padding, border and the textarea's inset (`--composer-bleed`), so its text lines up
  with the prose.
- Inside a reply, items (prose, work, cards, a steer, a question) are `--turn-item-gap` apart on
  the reply's column and carry no vertical margins of their own. A message sent while the agent
  worked is the user's bubble, right-aligned with the same shape, fill and type, told apart only by
  a `--text-xs` `--text-muted` "You, while it worked" line right-aligned above it.
- The message list fades into the composer over its last `--chat-fade` (40px; a mask, so it needs
  no colour), reaching a quarter of full strength at the jump-to-latest button's top and nothing
  by its middle, so no line of text reads beside or under the button. It keeps exactly
  `--chat-end-room` (the fade plus 8px) under its last item, so the last item can always scroll
  clear of the whole band; the last message's hover-only meta row hangs into that room rather
  than adding to it. The button sits in that band, centred, 8px above the composer, drawn as a small floating
  surface (`--surface-1`, `--panel-border`, `--shadow-md`, a `--text-secondary` icon). It sits on
  a layer under the composer's box, so the box's opaque fill covers the part of its shadow that
  falls below it.
- The composer stays in one place in every state: the line under it that holds the pull-request
  bar is kept even when there is no bar, so it does not move between an empty and a busy chat.

## Composer and icons

- Keep the composer as one surface: writing area above, context and standing settings at bottom
  left (`+`, the project chip, the permission mode), and model/run controls at bottom right (the
  context ring, the model, dictation, send).
- Toolbar controls that can be used are `--text-secondary`, turning `--text-primary` on a
  `--surface-3` tint when hovered or open; `--text-muted` is for supporting metadata such as the
  reasoning level, and a disabled control is dimmed, except the send and a question's submit:
  disabled, they draw their arrow in `--text-muted` at full opacity on a disc one step above their
  container (`--send-disabled-bg`: `--surface-4` on the dark composer, `--surface-3` on the light
  one's white), since the send is the control the composer is built around. A meter on a control (the context ring, the
  dictation model's download) is a thin accent arc over a `--border-color` track, and draws no arc
  at zero.
- The context ring is the first of the run controls, left of the model: a 16px ring with a 1.5px
  stroke, the size of the icons beside it, in a 28px round hit target. It shows on every chat, an
  empty one included, and never in Settings, which has no composer; the title bar holds only the
  theme toggle and the settings button. It shows neither arc nor numeral until its rounded value
  reaches 1%, drawing its track until then in the quieter `--border-subtle`, and no numeral once
  it is full, where the whole `--color-error-mark` arc says so; it stays visible, and its
  accessible name and tooltip, which opens upward, still give the exact value.
- The dictation meter takes the context ring's geometry: a 16px ring with a 1.5px stroke over a
  `--border-color` track, around a 12px mic glyph, in the same 28px round target; Settings' Voice
  status line shows the same meter. A ready mic is the plain borderless 16px glyph in
  `--text-secondary`, with no ring. The download arc is drawn only while bytes are arriving. A download that is
  queued, paused, or failed draws no arc, so nothing accent looks alive, and the button's tooltip
  says which ("Dictation download paused at 40%", "Dictation download failed at 40%").
- As the composer narrows, the model's name and the project or worktree chip are the only
  controls that give way, each ellipsizing, so the send button never leaves the box; the
  permission label goes only below 380px, since a crossed shield alone reads as "disabled".
- The `+` menu opens directly above the composer at the same width. Keep rows compact, organize them
  by purpose, and explain unfamiliar behavior with short secondary text or hover help.
- Images, files, and folders are first-class message context. Clipboard images and attached images
  use the same preview path and open in a focused lightbox from both composer and history.
- A long paste (2,000 characters or 30 lines) becomes a pasted-text attachment instead of filling
  the composer. Its card shows the opening lines and line count and opens the whole text, where it
  can be copied, turned back into typed text, or removed. Ctrl+Shift+V pastes inline, as does any
  paste while editing a sent message. The text is stored with the message's attachments, so queued,
  retried, and forked messages keep it, and the model receives it whole ahead of the typed message
  in a `<sidekick_pasted_text>` block. Since the text is sent again with every later turn, a
  message's pasted text may fill about half the selected model's context window (3.5 characters a
  token), at least 20,000 characters and at most 2,000,000; 200,000 when the window is unknown.
- When a run is active, Enter queues a follow-up. Pressing Enter again with an empty composer sends
  the oldest queued message immediately as steering.
- Do not render permanent pills for capabilities the agent manages automatically. Built-in web search and auto-discovered skills remain invisible unless their execution appears in the conversation.
- Use Lucide for interactive and semantic UI icons. Default to a 1.75–1.8 stroke, use 13–16px inside dense controls, and reserve 18px or larger for primary actions and empty states.
- Use `ProviderIcon` everywhere a provider or provider-owned model is identified. Resolve from `providerKind` before transport so OpenAI-compatible connections, LM Studio, and llama.cpp remain visually distinct.
- Provider icons are one set: each provider's official mark simplified to a solid shape on a
  24-unit grid, drawn in `currentColor` (`--text-secondary`) so it follows the theme and reads at
  14px. OpenAI-compatible servers, which have no brand, get a neutral plug. Keep a new mark's source
  and license notice in `ProviderIcon.tsx`.
- Custom SVG is reserved for official provider marks and genuine data visualizations such as the context ring or research progress—not ordinary buttons.

## Settings pages

The title bar's crumb, after the robot, has two parts: the chat's project in `--text-muted`, which
ellipsizes first, then `/` and the chat's title ("sidekick-demo / Refine the desktop
experience"), with the whole string as its tooltip. A chat outside any project shows only its
title, with no slash.

Settings opens in the app's own shell: the title bar stays, with the robot and "Settings" in the
breadcrumb slot in the chat's type (it belongs to no project, so it has no slash), and its navigation column is the sidebar's width
(`--sidebar-width`) with the sidebar tree's inline padding, so no edge moves when it opens. Its
rows' hover and selected tint is inset to the search field's edges above it, while their icons
and labels keep the tree's positions. Back to app sits on the same grid, its 16px arrow in the
icon column and its label on the labels' edge, so the column has one text edge.

Settings pages are built from the blocks in `components/SettingsLayout.tsx`, so a new setting looks
like the rest without new CSS:

- `SettingsPageHeader`: the page title, one line of description, and any page-level action.
- `SettingsSection`: a heading with a Lucide icon and description, then one bordered group whose
  rows are split by hairlines. Every direct child of the group is one row or block. The heading
  and description start on the rows' label edge (`--settings-label-edge`: the group's border plus
  its inline padding), and the 16px icon sits 8px left of that edge, so a page has two left
  edges: the group's border and its labels.
- Type comes in three tiers: the page title, a section's heading (600), and a row's label (500,
  `--text-primary`). A form field's label is `--text-sm` 500 `--text-secondary`, under a
  sub-section heading at `--text-md` 600.
- `SettingsRow`: label and description on the left, the control on the right; the description
  fills the left column, so it stays on one line where the row has room. Pass `controlId` so
  the label focuses the control; `stacked` puts a wide control, such as a path, under the label;
  children add detail under the row, such as a level meter. Row icons are a page-level choice: on
  a page whose sections have enough rows that icons help scanning, every row of every section has
  one, and otherwise no row does (General has none, so its Voice rows have none either); the icon
  sits in the row's own column, since 8px left of the label edge would cross the group's border.
  A status line under a row (Voice's "Setting up · Dictation: 41% of 671 MB") starts on the label
  edge with no glyph, in `--text-sm` `--text-muted`, and a download it reports shows the
  composer's dictation meter in the control column, centred under the switch.
- `ToggleField`: a row whose control is a switch, label on the left and switch on the right (a
  standalone switch, such as a provider's Enabled, keeps that order); the whole row toggles it. An on switch's knob
  takes `--on-accent`, so its position, which is the state, reads against either accent. An off
  switch is an outlined track (`--surface-4` inside a `--border-strong` ring) with a
  `--text-secondary` knob, so it never outshines one that is on.
- `Checkbox`: the app's one checkbox, wherever a choice is ticked rather than switched (a
  provider's model list, an import's parts, a schedule's catch-up). A 16px `--radius-xs` box over a
  visually hidden native input that reaches 4px past it, so the hit target is 24px and keyboard and
  `<label>` behaviour are the browser's: off is a 1.5px `--text-muted` outline, which keeps 3:1
  against `--surface-1` in both themes, `--surface-3` on hover; on is an `--accent` fill with a 12px check in `--on-accent`; focus takes the standard
  `--focus-ring`, and disabled is dimmed. No native checkbox is drawn anywhere else.
- Credits, licences and similar facts go in a `settings-footnote` under the row they belong to
  (`--text-xs`, `--text-muted`, no hairline of its own), so the row's description stays one line.
  It keeps to a 72ch measure and wraps with `text-wrap: pretty`, so no word is left alone.
- `SettingsEmptyState`: an icon, a title, a sentence, and the next action; `compact` for a list
  that is simply empty.

Buttons use `settings-primary-action` for the one action a view leads with,
`settings-secondary-action` for other actions, `settings-ghost-action` for quiet actions in lists
and headers, and `settings-danger-action` for removal; add `is-small` inside rows and headers and
`is-icon` for icon-only buttons. Controls are 32px tall (28px small) with `--radius-sm`. A
secondary button is drawn from `--button-secondary-bg`, `-hover-bg` and `-active-bg`: in the dark
theme a `--surface-2` fill that turns `--surface-3`; in the light theme, where a grey fill on a
white card reads as pressed or disabled, a raised white `--surface-1` control with a
`--border-color` border, turning `--surface-2` with `--border-strong` on hover and `--surface-3`
while pressed; its text is `--text-primary` 500 in both. A ghost action that starts or ends a
card's footer takes `is-flush-start` or `is-flush-end`, which pull it out by its own inline
padding so its label sits on the card's content edge and its hover tint bleeds outward (the
question card's Cancel and Skip). Changes
are kept until **Save changes**, and the footer says when there are unsaved ones: its note
("Unsaved changes", `--text-sm` `--text-secondary`) shows only then, when the button takes the
accent fill, and its line stays empty while nothing waits to be saved, when the button is a
secondary one. The footer's Cancel beside it is a ghost button (`settings-ghost-action`). The
footer is one row across the window, so its hairline and surface span it; the app's version sits
in it in the navigation's column, while its note and buttons keep to the page's column.
Device-only preferences, such as voice devices, apply at once and say so.

## References in replies

- A file path a reply mentions becomes a chip only once the main process confirms it exists in the
  project. A path the model imagined stays plain text rather than becoming a dead link.
- Clicking a file chip opens the file in the workspace panel, not in an external editor. The panel
  renders markdown, highlighted code with line numbers, and images; anything else, and the
  "open externally" action in its header, fall back to the OS. A `path:line` reference scrolls to
  and marks that line.
- Single-clicking a file in the tree opens the same viewer; double-click still opens it externally.
- External links carry the linked site's own icon. Icons are fetched by the main process from that
  site only, never from an icon service, and cached on disk for a week. A site with no usable icon
  gets a globe. See PRIVACY.md.
- In running text a file chip, like inline code, is inline content on the line's own pitch:
  `--surface-2`, no border, `--radius-xs`, mono at 0.9em, in the sentence's `--content-color` at
  weight 400, so only the chip's grey icon marks a file. A chip's or link's icon stays on one line
  with the first word of its label. Before a full stop, comma, semicolon, colon, `!`, `?` or `)`, a chip or
  inline code ends with 2px of padding instead of 4px, and after an opening bracket or quote
  (`(`, `[`, `{`, `“`, `‘`, `"`, `'`) it starts with 2px, so the mark sits as close as it does
  beside plain text. The `Sources` row and attachments keep the bordered chip.
- A reply that links out gets one compact `Sources` row beneath it, one chip per site in order of
  first mention, deduplicated by host. It appears only after the reply finishes streaming.
- A markdown table sits in a card (`--border-subtle`, `--radius-sm`) bounded by its column (the
  file viewer's padded document column included), which scrolls sideways inside its four borders
  when the table is wider; only then is the scroller focusable, a region named "Table, scrolls
  sideways", so the keyboard can scroll it too, and a table that fits adds no tab stop. While it overflows, a 16px mask fades the edge that has more to show (the right at rest,
  the left once scrolled to the end, both between), so a cut column reads as more to scroll to.
- Syntax highlighting uses the tokens in `styles/codeTheme.css`, which define both themes. Do not
  import a highlight.js theme stylesheet directly; those are single-theme and were unreadable on
  the light theme.

## Welcome state

- Keep the empty chat visually quiet: one short heading, no decorative product initial, and no explanatory paragraph that repeats the composer’s purpose.
- The heading and the suggestions are one group whose foot sits 32px above the composer's box, so
  the eye goes from them to where the message is typed; the composer sits where it does in a
  populated chat. The robot peeks from behind the side panel just above the group. The
  suggestions sit `--space-5` under the heading as 36px rows on `--surface-1` with
  `--card-edge`; their labels are `--text-secondary` 500 and their 14px trailing arrow
  `--text-muted`, both a step brighter on hover and focus, so the heading leads.
- Show exactly two compact, single-line suggestions sharing the composer's width. Prefer recent non-placeholder conversation titles and the active project name; use two neutral local fallbacks for a new profile. Only a quoted title ellipsizes, and the full label is the tooltip.
- A new chat outside any project picks one from a chip in the composer's context controls, not a
  card above the composer.
- Derive welcome suggestions locally from already-visible history. Rendering the welcome screen must not spend model tokens or send conversation metadata to a provider.
- Clicking a suggestion should populate the composer for review rather than immediately sending a message.

## Responsiveness in long conversations

A conversation can hold replies with hundreds of steps and runs with tens of thousands of events.
The chat stays responsive by keeping per-keystroke and per-update work independent of that size:

- `MessageItem` is memoized, and its comparator checks callback identity. Every callback the chat
  passes to it must be stable (`useCallback`, or one handler taking the message id). A closure
  created per render re-renders every message on every keystroke: markdown re-parses and links
  remount, which shows as flicker while typing.
- Markdown shares one syntax highlighter. `rehype-highlight` registers every common language each
  time it is instantiated, and `react-markdown` creates a processor per render, so the plugin must
  not be passed directly.
- A work block mounts its latest 30 steps; earlier ones load on request. The live block is open and
  re-rendered on each update, so mounting all of a long run made the app slower the longer the
  agent worked.
- Live run projection is coalesced to 50 ms, and to 250 ms once a run passes 4,000 events, because
  each projection rebuilds the whole run.
- Effects that call the main process depend only on values that change with the conversation.
  `useConversationRun` reads its `onProjection` callback through a ref: when the callback was a
  dependency, every keystroke re-ran the effect that asks for the latest run, and the main process
  read and sent up to 10,000 events per key.

To measure, start the dev app with `npm run dev -- --remoteDebuggingPort 9222 --inspect 9229` and
profile both processes: the renderer over the Chrome DevTools Protocol (per-keystroke latency, long
tasks, and heap growth while typing in the longest conversation available), and the main process
through its V8 inspector, where IPC work caused by typing shows up. Compare against a new chat.

## UI preview and visual QA

Development builds expose a deterministic renderer preview when Electron's preload API is unavailable:

1. Run `npm run dev`.
2. Open `http://localhost:5173/?ui-preview=1`.
3. Review the welcome state, the populated `Refine the desktop experience` conversation, the
   full-window Settings workspace, Browser/Files/Terminal panels, both themes, and compact widths.

For a design review, `node scripts/capture-ui-screens.cjs --out <dir>` serves the same preview and
reaches each state by the clicks and keys a user would make, writing one screenshot per state,
theme and width plus a `manifest.json` that describes them (`--list` names the states, `--only`
picks some). The mock's dictation model is ready by default; add `&dictation=downloading` to the
preview URL to see it mid-download, which the capture script does for its own state.

The preview mock is development-only and is never installed when `window.api` already exists. It must stay aligned with the preload contract closely enough for representative renderer testing.

Before merging a broad UI change, verify at minimum:

- dark and light themes;
- welcome, populated chat, settings, and secondary-panel states;
- default desktop width (900px) plus a wide viewport;
- keyboard focus and accessible names for new controls;
- no horizontal overflow or clipped primary actions.
