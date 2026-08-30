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

The Browser tab in the right workspace panel shows the live page, a highlighted cursor, and a
short user-facing activity history. The page scales to the available panel without allowing a
narrow or mobile viewport to stretch an image beyond the layout. Browser details remain available
to the model and diagnostics without filling the user interface with developer-only telemetry.

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
