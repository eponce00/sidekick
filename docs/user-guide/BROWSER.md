# Visual browser

SideKick gives conversations an isolated Chromium session for visual inspection and
interaction. This is a first-party tool surface in the trusted Electron main process; it does not
require an MCP server, browser extension, or the user's everyday browser profile.

## What an agent can do

An eligible agent can open a local or remote page, inspect its accessible structure, capture a
screenshot, click or hover an element, type into fields, choose options, scroll, resize the
viewport, move between tabs, wait for page state, inspect console and failed network activity, and
verify an expected result. Screenshots are delivered as actual image input when the selected model
supports vision, and each one the agent is shown also appears as a thumbnail on its step in the
chat; click it to see it larger. To check an animation, the agent can capture a few frames a moment apart, which
it sees side by side in one image. An SVG file opened on its own is shown like an image: fitted to
the page and centred on a checkerboard, so the panel and the agent's screenshots show the whole
drawing at any size.

When the agent changes a page, styles, or UI components and is about to finish without having
looked at the result since, SideKick asks it once to open the result here and check it, then fix
what does not match. This happens only with a model that can see images.

`browser_hold` provides one bounded, atomic press-and-hold gesture for ordinary controls such as
maps, sliders, canvases, and test interfaces. It always releases the mouse even if the action is
cancelled. It is not a CAPTCHA solver.

`browser_fill_form` batches up to 25 native textboxes, selects, checkboxes, and radio buttons in
one model turn. It uses current semantic references or unambiguous selectors/accessible names,
never coordinates. Fields are filled in order and their actual browser state is checked after each
action. Independent fields continue after a field-level failure; navigation or page changes stop
the remaining batch. It then returns one
fresh semantic observation with per-field filled, unchanged, failed, or skipped status. Entered
text, selected option values, and checked choices are redacted from durable tool records and
results. The batch intentionally omits a result screenshot because text fields could expose those
values visually; the live Browser panel still shows the current page. A date field takes an ISO
date such as 2026-11-14: a native date input is set directly, and a text box whose placeholder
names a format such as MM/DD/YYYY gets the date written that way, whatever separators its input
mask adds.

`browser_select` chooses values in any picker, not only a native select: an autocomplete field
whose suggestions come from the server, an ARIA combobox, a menu built from plain elements, a
multi-select that adds chips, or a button that opens a dialog with a search box and a results
table. It opens the picker or types into it with real input, waits for the options to stop
changing, clicks the one option the value names, presses the dialog's Select or OK button when it
has one, and checks the control then shows the choice. A value two options share, such as
"Deluxe" for Deluxe King and Deluxe King, ocean view, or one no option has, is refused with the
options listed rather than guessed, and the picker is closed again.

After every action the agent waits until what the action set off has finished: the requests it
started, the changes it made to the page, and any spinner or loading bar it brought up. The page's
own background activity, such as a carousel, a clock, analytics or a connection held open, does
not hold the wait open.

The Browser tab in the right workspace panel contains the actual interactive page. Its toolbar
reads like a browser's: back, forward and reload, the address field, **Annotate**, the page's tools
(the puzzle piece), and the **⋯** menu. Type an address and press Enter to open it; anything that is
not an address, such as a few words, is searched on DuckDuckGo. Create and switch tabs yourself; the agent uses these same tabs. Click
the page to type, scroll, select text, and edit forms. Ordinary browsing has no takeover or
resume button: the agent can use the same session on its next browser action without waiting
for your approval. Manual page input is blocked during an in-flight browser action to avoid
interleaving; retry your input when it finishes. Manual changes invalidate old element references,
so the agent must observe fresh state before reusing them. Focusing the address bar does not
pause the agent. Right-click offers native text editing actions.

The **⋯** menu holds the rest, as in a browser:

- **Find in page** opens a find bar under the toolbar. Matches are highlighted on the page, the
  selected one brighter, with how many there are; Enter and Shift+Enter move between them, Escape
  closes the bar.
- **Print…** opens the system's print dialog for the page.
- **Zoom** steps the page out and in, and the percentage returns it to 100%; the menu stays open
  while you zoom.
- **Device size** lists the standard sizes described below.
- **Take a screenshot** marks all of the page in view, as a picture with a note, for your next
  message (see [Pointing at the page](#pointing-at-the-page)).
- **Import bookmarks and history…** opens the import described
  [below](#bookmarks-and-history-from-your-other-browsers).
- **Browser settings** opens Settings where the browser's settings are.

The page is responsive by default: it lays out at the panel's width at 100%, like a browser window. Zoom it as in a browser: Ctrl + and Ctrl − while the page has focus, Ctrl 0 for 100%, or the zoom row in the **⋯** menu. A tab keeps its zoom, and the address field shows it while it is not 100%; select it to return to 100%. **Device size** chooses a standard size instead, as in Chrome's device toolbar: phones and tablets, which also get mobile layout, touch, and a mobile user agent, or a laptop or desktop. The agent can choose the same devices, or an exact size. A size wider than the panel is drawn scaled down to fit, so you see the whole page: a laptop or desktop width also grows taller to fill the panel, while a phone or tablet keeps its exact size, centred; and the address field shows the size in effect: select it, or choose **Responsive**, to return to the panel's width. Drag the panel wider, or past the chat to the full window (see [the side panel](CHAT.md#the-side-panel)), so a laptop size shows at full size on a wide window. A size the agent set returns to responsive when its reply ends. The agent's screenshots are taken from the page itself at full size, never from the panel.

## Pointing at the page

To show the agent what you mean, choose **Annotate** (the speech-bubble button beside the address
field). The pointer becomes a crosshair and the part of the page under it is outlined and named, such
as **Image** or **Link**. Click an element, or drag over an area: the mark is numbered on the page,
and a comment field floats beside it, ready for what should change. Type, or choose the microphone
to dictate it when [voice](VOICE.md) is on; Enter or the check keeps the note and the field goes
away, Escape leaves it as it was. Select a mark's number to edit its note again, or remove it.

For an element, the sliders button in the comment field opens a style editor: text size, weight,
font, text color, background and opacity. Each change shows on the page at once, so you can try what
you mean; the note then says what you changed, such as “Style: text size 20px, text color #1d4ed8”.
**Reset** puts the element back. The changes stay on the page until it reloads.

A bar at the top of the page, which you can drag elsewhere, counts your marks and has a screenshot
button that marks all of the page in view, buttons to hide the marks and to remove them all,
**Send**, which sends your message with them, and a close button. Press Escape on the page, close
the bar, or choose **Annotate** again, to stop marking. The wheel still scrolls the page while you mark, except
during an agent's action on it, like the rest of your input. Marking works the same on a page you
opened and on one the agent is using, even while the agent works.

Your marks appear as numbered chips above the message box and go with your next message, up to
eight at a time. Each one tells the agent:

- your note;
- the page's address and title;
- for an element, its role and accessible name as the browser reports them, a CSS selector, the text
  it shows, and where it is; for an area, where it is and the element at its centre;
- a picture of what you saw around the mark, with the mark outlined.

A model that can see images gets the pictures as images; a model that cannot gets everything else.
Many models take only a few images per request: the first marks' pictures are kept and the agent is
told the rest were left out. The sent message shows the marks and their pictures, on
[your phone](PHONE.md) too. Marks you have not sent stay until you close SideKick.

The page cannot tell you are marking it: the outline, numbers, comment field and bar are drawn by
SideKick over the page, and nothing runs in the page to read the marks. Only a style you change is
written to the page, on that element. Dictation is heard and transcribed by SideKick on this
computer; the page never has the microphone. What you type into the page is never sent:
text from fields, lists and editable areas is left out, and in the picture those, and frames from
other sites, are covered with grey stripes, so a marked field shows as grey. No picture is taken
while a password a stored sign-in filled in is shown as plain text. A user name or password in the
page's address is removed. What the page says about itself, such as its title, an element's name and
its text, reaches the agent marked as the page's content, never as your words.

## Bookmarks and history from your other browsers

To make the Browser panel feel like your own browser, import the bookmarks and history you already
have, in **Settings › Agent › Imported browser data**. Pick the browser and, if it has several, the
profile; SideKick shows how many bookmarks and pages of history it holds before anything is kept,
and you choose which of the two to import.

| Browser                              | Where                 |
| ------------------------------------ | --------------------- |
| Google Chrome, Microsoft Edge, Brave | Windows, macOS, Linux |
| Chromium                             | Windows, macOS, Linux |
| Arc                                  | macOS                 |
| Firefox, including Snap and Flatpak  | Windows, macOS, Linux |
| Safari                               | macOS                 |

Any other browser, or a browser on another computer, can export its bookmarks as an HTML file; choose
**Import a bookmarks file** in the same window. Arc keeps its sidebar in its own format, so its
pinned tabs and spaces do not come across; its history does.

- **Bookmarks** and **history**, the 20,000 most visited pages, become suggestions as you type in
  the address bar; use the arrow keys and Enter, or click one. Your own browsing in SideKick is
  not added to it.
- Only web addresses are imported: bookmarklets (`javascript:`), local files, browser pages such as
  `chrome://settings`, and addresses with a username or password in them are left out.
- Importing the same profile again replaces what it imported before, for each kind you chose. Each
  import is listed in Settings, where you can remove it.

The browser can stay open while you import: SideKick reads a private copy of its files and leaves
the browser undisturbed. If the browser holds a file locked, quit it and try again. macOS shows
Safari's data only to apps you have given Full Disk Access in System Settings; without it, export
Safari's bookmarks with **File › Export › Bookmarks** and import that file instead.

Imported bookmarks and history stay on this computer, in SideKick's database. The agent has no tool
that reads them and never sees them.

**Sign-ins are not imported.** SideKick does not read another browser's cookies or saved passwords:
browsers encrypt them so that other programs, including malware, cannot take them, and SideKick does
not work around that. To use a site signed in, sign in in the Browser panel, which lasts as long as
that chat's browser session, or store the sign-in in [Credentials](CREDENTIALS.md#browser-sign-in)
so the agent can sign in for you without seeing the password.

## Tools that websites offer

Some websites offer tools to in-browser agents through
[WebMCP](https://webmachinelearning.github.io/webmcp/): a store might offer "add to cart", a travel
site "search flights". The puzzle piece beside the address field shows a dot when the page in the
active tab offers tools. Choose it to see which site offers them and each tool's name, and whether
the site marks it read-only; a page without tools says so. Choose a tool
to read the site's own description of it.

The agent learns which tools a page offers when it looks at the page. It lists them with
`browser_list_webmcp_tools` and calls one with `browser_call_webmcp_tool`, which runs the site's own
code in the page, as when you use that feature yourself. Calls appear in the chat as browser steps,
such as "Call add_to_cart on shop.example".

- A call acts on the site as you. It follows your [permission mode](PERMISSIONS.md) like a click:
  **Ask for sensitive actions** asks before each call unless the site marks the tool read-only, and
  **Ask before every change or command** asks before every call. A tool the site marks as having
  consequences asks every time, even in **Full access**. The card shows the site, the tool and the
  site's description of it. A read-only mark is the site's claim, which SideKick cannot check.
- **Allow for this chat** is offered for a site's tools on the web, not for files on your computer.
- A call goes only to the site where the agent listed the tools, and only to the tab and tool you
  were shown. If the tab has moved on to another page or another site, another tab is in front, or
  the page has changed the tool, the call is refused and the agent lists the tools again.
- While a password from a stored sign-in is filled in on the page, the page's tools are not called,
  since the page's code could read it.
- SideKick checks the agent's input against what the tool says it takes before anything runs.
- Only the page's own tools are offered, not those of frames embedded in it.
- A tool's description and result are the page's content: the agent treats them as information,
  not instructions. A result is cut to 256 KB, a call is cancelled after 30 seconds, and stored
  credentials are hidden in results as everywhere else.

A page can also describe one of its forms as a tool. Calling it fills in the form, and submits it if
the site says to; it always counts as a change.

## Human-only site checks

When SideKick detects a CAPTCHA or anti-bot verification, automated input and page evaluation stop.
The agent first tries another source, such as another search engine, without bothering you. Only
when that page is the one way to finish the task does it wait for you: its step in the chat says what
the site wants, for example **Waiting for you in the browser: DuckDuckGo wants you to confirm you
are human**, the chat shows as waiting, and the Browser panel opens on the page. Complete the check
right there in the panel. SideKick notices when it is gone and the agent continues on the same page
by itself; there is nothing to press. If you stop the run, or the check is still there after ten
minutes, the agent moves on without it.

CAPTCHA and anti-bot checks are always human-only; SideKick does not ask the model to bypass or solve
them.

## Isolation and safety

The browser opens HTTPS, files inside the project, and plain HTTP on your own computer. A plain
HTTP address on your local network, such as a device or gateway at `http://10.0.0.5:8080`, opens
only after you allow it in a dialog, once per address and port. If SideKick is not in front when
the agent asks, a notice in the corner of your screen tells you, and the agent waits for your answer rather than timing
out; stopping the run withdraws the question. Devices on a local network often
trust anyone who can reach them, so a page the agent reads cannot send it to one you have not
chosen, and requests a page makes to any other local address are blocked. Allowed addresses are
listed in **Settings › Agent › Local network**, where you can remove them. The same answer
applies to `web_fetch`, so the agent cannot read a device you have not allowed by switching tools;
see [Addresses on your network](SEARCH.md#addresses-on-your-network).

`browser_upload` selects up to eight project-relative regular files (25 MiB total)
on an observed file input, then verifies the actual selection. Symlinks, files with
more than one hard link, and paths outside the project are rejected. Selection can immediately expose files to the site
if its JavaScript auto-uploads; it is not inherently a local-only action.

`browser_download` saves a direct HTTPS resource using the conversation browser's
session into a new project-relative file (25 MiB maximum). Its parent directory must
exist; existing files are never overwritten. Plain HTTP follows the same rule as browsing.
Downloads publish only after the complete file is written. The destination filesystem
must support hard links; unsupported filesystems fail without a partial final file.
A process crash can leave a `.sidekick-download-*.partial` staging file.
Each redirect is checked before following it, with a five-hop limit. Neither tool
submits a form automatically.

- Browser sessions use a dedicated Electron partition and do not inherit cookies or logins from
  the user's normal browser.
- Navigation and interactions are executed in the trusted main process and remain scoped to the
  active conversation.
- Inspection-only evaluation rejects expressions that attempt page mutation.
- Agent downloads, camera, microphone, and other sensitive capabilities remain restricted;
  native text copy/paste is available during user control.
- Sessions can remain available across turns. Explicit browser closure releases the session;
  inactive sessions remain subject to the session manager's normal cleanup limits.

Browser pages are untrusted content. Text found on a page is evidence or data, not a system
instruction, and cannot expand the agent's file, command, network, or permission authority.
