# Tools that websites offer the agent (WebMCP)

Status: design note. Listing and calling a page's tools, with permissions, limits, the Browser
panel's list and chat cards, has shipped; it is described in
[WebMCP](../architecture/WEBMCP.md) and the [browser guide](../user-guide/BROWSER.md#tools-that-websites-offer).
This file keeps the research, the reasoning, and the work still open.

## Problem

A growing number of websites describe actions they support as tools for in-browser agents: search
flights, add an item to the cart, read the order history. The page registers each tool with a name,
a description, a JSON Schema for its input and a function that runs it. An agent that can call such
a tool needs no clicking, typing or reading of the layout, so the action is faster and does not
break when the page's design changes. SideKick's agent drives its own browser, but it could not see
or call these tools.

## The standard

WebMCP is a draft from the W3C Web Machine Learning Community Group, edited by Google and
Microsoft: the [specification](https://webmachinelearning.github.io/webmcp/) and its
[repository](https://github.com/webmachinelearning/webmcp), read at commit `51ed7565`
(2026-10-20), with Chrome's [developer guide](https://developer.chrome.com/docs/ai/webmcp) and
[agent security guidance](https://developer.chrome.com/docs/agents/security).

- A page calls `document.modelContext.registerTool({name, title, description, inputSchema,
execute, annotations}, {signal})`. Aborting the signal unregisters the tool. Names are 1–128
  characters of letters, digits, `_`, `-` and `.`; the description is required.
- `execute(input, {signal})` returns any JSON value. The browser does not check the input against
  the schema; the tool must.
- Annotations are the site's own claims: `readOnlyHint` (changes nothing), `untrustedContentHint`
  (the result holds content the site did not write, such as reviews), and `consequentialHint`.
- A new document starts with no tools; nothing announces the old document's tools going away.
- Earlier drafts had `navigator.modelContext`, `provideContext`, `clearContext`, `unregisterTool`
  and `requestUserInteraction`; all were removed between March and June 2026. Confirming actions
  with the user is now the agent's job.
- A declarative form (`<form toolname tooldescription toolautosubmit>`) left the specification on
  2026-10-08 and lives on in an [explainer](https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md).

### What Electron 43 ships

SideKick runs Electron 43, which bundles Chromium 150.0.7871.250. It has a native WebMCP behind the
Blink feature `WebMCP` (off by default; Chrome runs an origin trial from M149 to M156) and the
DevTools protocol domain [`WebMCP`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/WebMCP.pdl),
which is on by default. Probing it in Electron 43 confirmed the source reading:

- `WebMCP.enable` replays the top frame's tools as `toolsAdded` events, each with its name,
  description, input schema, frame and the annotations `readOnly`, `untrustedContent` and
  `autosubmit`. There is no title and no `consequential`.
- `WebMCP.invokeTool {frameId, toolName, input}` returns an invocation id; the result arrives as
  `toolResponded` with `Completed`, `Error` or `Canceled`. `WebMCP.cancelInvocation` cancels one.
- `toolsRemoved` fires only when a page unregisters a tool. A call still running when the page
  navigates never answers.
- Chromium checks names and requires a description, but does not bound the description (200 KB
  passes), check the schema's type, or check the input.
- Declarative form tools appear too. Calling one fills the form and, with `toolautosubmit`,
  submits it.
- Cross-origin iframes are separate protocol targets and their tools are not reported on the page's
  session.

Chromium 150 predates the current specification in two ways a page notices: `registerTool` returns
nothing, so `registerTool(…).catch(…)` throws, and `execute` receives no second argument, so a page
written as Chrome's guide shows, `async (input, {signal}) => …`, fails on every call. Chromium has
since fixed both; Electron 44 (Chromium 152) also drops `navigator.modelContext`.

### How others consume it

- Chrome DevTools has an [Application › WebMCP panel](https://developer.chrome.com/docs/devtools/application/webmcp)
  built on the same protocol domain.
- `chrome-devtools-mcp` exposes `list_webmcp_tools` and `execute_webmcp_tool` to agents; SideKick's
  two tools follow the same split.
- The [official polyfill](https://github.com/w3c-oss/webmcp-polyfill) and MCP-B's `@mcp-b/global`
  implement the API in pages; both keep a native implementation when they find one.

## Decisions

- **Chromium's implementation, read over the DevTools protocol.** A shim of SideKick's own,
  injected into every page and bridged with `Runtime.addBinding`, would follow the current
  specification more closely, but it would be a second implementation of a moving standard in every
  page SideKick opens, and it would lose declarative forms. A short compatibility script closes only
  the two gaps pages notice, and defers to Chromium wherever it already behaves as specified, so it
  stays correct as Electron's Chromium catches up.
- **Only the page's own tools.** Tools that iframes register belong to embedded content the user
  does not see in the address bar, and the specification's discussion leans the same way for
  built-in agents.
- **The model names the site.** A call carries the origin from the listing, so the approval card
  shows the site, a chat-wide grant is bound to it, and a call on any other site is refused.
- **Listing binds calls.** A call is refused once the page loads a new document or registers the
  tool again, so a navigation cannot turn a call into one on another page.
- **A read-only mark only lightens the prompt.** It is the site's claim; it decides whether
  **Ask for sensitive actions** asks, and never widens what a call can reach. A form never counts as
  read-only.

## Open work

- Tools from same-origin and `allow="tools"` iframes, each shown with its own origin, if the
  specification settles that built-in agents should see them.
- `title`, `consequential` and `debugging`: Chromium 150's protocol reports none of them. SideKick
  already asks before a tool marked consequential in every mode and never offers one marked for
  debugging, so these take effect when Electron's Chromium reports them; the title is not shown yet.
- Electron 44 (Chromium 152) removes `navigator.modelContext` and changes result and event shapes;
  rerun the protocol probe and the smoke on every Electron upgrade before trusting them, and drop
  the compatibility script once Chromium matches the specification.
- `toolactivated` and `toolcancel` still fire at `window` in Chromium 150 rather than at
  `document.modelContext`; pages that listen on the latter do not hear them.
- A page can return up to whatever Chromium serializes before SideKick cuts the result to 256 KB,
  so a hostile page can still make the main process read a very large message once.
- A Settings switch to turn the feature off, if users ask for one. Origin-trial tokens are not known
  to work in Electron, so the feature is on for every page SideKick opens.
