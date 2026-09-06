# Visual browser

SideKick gives conversations an isolated Chromium session for visual inspection and
interaction. This is a first-party tool surface in the trusted Electron main process; it does not
require an MCP server, browser extension, or the user's everyday browser profile.

## What an agent can do

An eligible agent can open a local or remote page, inspect its accessible structure, capture a
screenshot, click or hover an element, type into fields, choose options, scroll, resize the
viewport, move between tabs, wait for page state, inspect console and failed network activity, and
verify an expected result. Screenshots are delivered as actual image input when the selected model
supports vision.

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
values visually; the live Browser panel still shows the current page. Custom widgets and
autocomplete controls remain explicit single-action work.

The Browser tab in the right workspace panel contains the actual interactive page. Enter an address,
use back/forward/reload, or create and switch tabs yourself; the agent uses these same tabs. Click
the page or choose **Take control** to type, scroll, select text, and edit forms. Browser tool calls
wait while you have control. Choose **Resume agent** when finished; the agent must observe fresh
state before targeting elements you changed. The current browser action finishes before takeover
can begin. Right-click offers native text editing actions.

## Human-only site checks

When SideKick detects a CAPTCHA or anti-bot verification, automated input and page evaluation stop.
The run stays suspended and a **Take control** card appears. Choose it to reveal the exact isolated
browser tab, complete the site check yourself, and then choose **I've finished — resume**. SideKick
recaptures the same tab and continues only after the challenge has cleared. The session is pinned
while the card is pending, popups stay in the visible takeover window, and cancelling the run parks
the browser safely. If the check cannot be completed, **Use another source** tells the agent to take
a legitimate alternate route.

When the Browser panel is open, takeover stays inside it. The fallback takeover window's native title
bar shows a main-process-owned origin. CAPTCHA and anti-bot
checks are always human-only; SideKick does not ask the model to bypass or solve them.

## Isolation and safety

`browser_upload` selects up to eight project-relative regular files (25 MiB total)
on an observed file input, then verifies the actual selection. Symlinks and paths
outside the project are rejected. Selection can immediately expose files to the site
if its JavaScript auto-uploads; it is not inherently a local-only action.

`browser_download` saves a direct HTTPS resource using the conversation browser's
session into a new project-relative file (25 MiB maximum). Its parent directory must
exist; existing files are never overwritten. Loopback HTTP is allowed for local tests.
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
