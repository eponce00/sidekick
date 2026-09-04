# Visual browser

SideKick gives project-bound agents an isolated Chromium session for visual inspection and
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
action. The batch stops before later fields when a field fails or the page changes, then returns one
fresh semantic observation with per-field filled, unchanged, failed, or skipped status. Entered
text, selected option values, and checked choices are redacted from durable tool records and
results. The batch intentionally omits a result screenshot because text fields could expose those
values visually; the live Browser panel still shows the current page. Custom widgets and
autocomplete controls remain explicit single-action work.

The Browser tab in the right workspace panel shows the live page, a highlighted cursor, and a
short user-facing activity history. The page scales to the available panel without allowing a
narrow or mobile viewport to stretch an image beyond the layout. Browser details remain available
to the model and diagnostics without filling the user interface with developer-only telemetry.

## Human-only site checks

When SideKick detects a CAPTCHA or anti-bot verification, automated input and page evaluation stop.
The run stays suspended and a **Take control** card appears. Choose it to reveal the exact isolated
browser tab, complete the site check yourself, and then choose **I've finished — resume**. SideKick
recaptures the same tab and continues only after the challenge has cleared. The session is pinned
while the card is pending, popups stay in the visible takeover window, and cancelling the run parks
the browser safely. If the check cannot be completed, **Use another source** tells the agent to take
a legitimate alternate route.

The takeover window's native title bar shows a main-process-owned origin. CAPTCHA and anti-bot
checks are always human-only; SideKick does not ask the model to bypass or solve them.

## Isolation and safety

- Browser sessions use a dedicated Electron partition and do not inherit cookies or logins from
  the user's normal browser.
- Navigation and interactions are executed in the trusted main process and remain scoped to the
  active run.
- Inspection-only evaluation rejects expressions that attempt page mutation.
- Downloads, clipboard, camera, microphone, external navigation, and other sensitive boundaries
  continue through SideKick's permission policy.
- Closing or ending a run releases its browser session and temporary visual artifacts according to
  the normal run cleanup path.

Browser pages are untrusted content. Text found on a page is evidence or data, not a system
instruction, and cannot expand the agent's file, command, network, or permission authority.
