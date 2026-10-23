# Tools that websites offer (WebMCP)

SideKick's agent can list and call the tools a page registers through
[WebMCP](https://webmachinelearning.github.io/webmcp/). Users see this in the
[browser guide](../user-guide/BROWSER.md#tools-that-websites-offer); the research behind the
design and the work still open are in the [roadmap note](../roadmap/WEBMCP.md).

## Chromium does the work

Pages run Chromium's own WebMCP, and the trusted main process reads and calls it through the
DevTools protocol domain `WebMCP` on the debugger session each tab already has.

- Every tab SideKick creates sets `webPreferences.enableBlinkFeatures: 'WebMCP'`, so pages in the
  agent's browser get `document.modelContext` while SideKick's own window and renderer do not. The
  feature is off by default in Electron 43 (Chromium 150).
- When a tab is created, before its first page loads, the
  [native browser service](../../src/main/services/nativeBrowserSessionService.ts) adds a
  compatibility script with `Page.addScriptToEvaluateOnNewDocument`, reads the top frame with
  `Page.getFrameTree`, and sends `WebMCP.enable`. A tab where this fails offers no tools; attached
  surfaces never enable it.
- The compatibility script closes the two gaps between Chromium 150 and the current specification
  that pages notice: `registerTool` returns a promise, and `execute(input, {signal})` gets a signal
  that aborts when Chromium fires `toolcancel`. It uses Chromium's own options and promise where
  they exist. It lives in [webMcpPageTools.ts](../../src/main/services/webMcpPageTools.ts).

## Each tab's tools

`WebMcpPageTools` keeps one tab's state from protocol events.

- Only tools whose `frameId` is the tab's top frame are kept. Tools from iframes are ignored.
- `Page.frameNavigated` for the top frame starts a new document: the origin comes from Chromium's
  `securityOrigin`, the document counter increases, and the tools are cleared, since Chromium
  sends no removal for them. `toolsAdded` and `toolsRemoved` keep the list current; a tool
  registered again gets a new version.
- Names must match the specification (`[A-Za-z0-9_.-]`, 1–128 characters) and descriptions must not
  be empty. Descriptions are cut to 2,000 characters, a schema larger than 16 KB is dropped, and a
  page keeps at most 50 tools. `readOnly` comes from the page's `readOnlyHint` and is always false
  for a declarative form; `consequential` comes from the protocol's `consequential` annotation when
  Chromium reports it. A tool the page marks `debugging` is never kept, so the model never sees it.
- Calls bind only to a web origin or to the one origin local files share; a page whose origin is
  opaque offers no callable tools.

## Listing and calling

`browser_list_webmcp_tools` records which document and tool versions the agent saw.
`browser_call_webmcp_tool {origin, tool, arguments}` is refused, before anything runs, when:

| Refusal             | When                                                                                                                             | Result code         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `cross_origin`      | The tab's origin is not `origin`                                                                                                 | `permission_denied` |
| `not_listed`        | The tab's tools were not listed on this origin                                                                                   | `conflict`          |
| `navigated`         | The tab loaded another document since the listing                                                                                | `conflict`          |
| `not_found`         | The tool was not listed, or the page removed it                                                                                  | `not_found`         |
| `changed`           | The page registered the tool again since the listing, or the tab, its document or the tool differ from when the call was checked | `conflict`          |
| `invalid_arguments` | The arguments are not an object or do not fit the schema                                                                         | `invalid_arguments` |
| `secret_on_page`    | A stored password is filled in on the page                                                                                       | `conflict`          |
| `unavailable`       | The tab never enabled WebMCP, or its origin is opaque                                                                            | `unsupported`       |

The arguments are checked with the registry's schema checker in its external mode
(`externalSchemaIssues`): types, required properties, enums, ranges, lengths and alternatives, but
never a page's `pattern`, and for at most 5,000 steps, after which the page checks its own input. A
malformed schema is reported as an issue. The issues name the page's own properties and values, so
they reach the model in a `<webmcp_schema_issues>` block, never in SideKick's refusal message. A
call to a page whose human-verification check is showing is refused like every automated input, and
so is a call while a password from a stored sign-in is filled in on the page, as `browser_evaluate`
is.

An accepted call sends `WebMCP.invokeTool {frameId, toolName, input}`. Chromium starts the tool as
it answers, so SideKick always waits for the invocation id, for up to ten seconds, and cancels the
call if the run stopped meanwhile. If the top frame loaded a new document before the id came back,
the call is cancelled and reported, since it may have reached a same-named tool on the new page.
The answer arrives as `toolResponded`. An answer that comes before the id is kept, bounded like
any answer, for at most eight invocations per tab. A call ends:

- when the page answers. A result is cut to 256 KB of JSON; a thrown error's description is cut to
  2,000 characters and its remote object released;
- after 30 seconds, or when the run stops, with `WebMCP.cancelInvocation`;
- when the page navigates. Chromium never answers a script tool after that, so SideKick waits one
  second and reports where the page went. A form's answer comes from the page its submission loaded,
  so a form waits for it until the timeout.

## Permissions

`browser_list_webmcp_tools` is a read. `browser_call_webmcp_tool` has `execute` risk, and the run
kernel asks the tool router for its requested access (`requestedAccess`) before deciding:

- `always` for a tool the page marks consequential: it asks every time, even in **Full access**,
  and **Allow for this chat** is not offered;
- `auto` for a listed, current tool the page marks read-only;
- `confirm` for any other callable tool;
- `auto` for a call that will be refused, since it runs nothing.

The router records what it decided against, by tool call: the tab, its document and the tool as
they stood, or the refusal. The approval card shows that tool. When the call runs, a refused
decision is refused again, and a call whose tab, document or tool differ from the decision is
refused as `changed`. This holds whatever the user or the page does while the card waits, such as
switching tabs, opening a popup or closing the page.

The permission mode then applies as to any tool. An **Allow for this chat** grant covers the exact
arguments, including the origin, and is offered only on web origins, since every local file shares
a single origin. The approval card shows the site, the tool, the site's description and its
read-only and consequential marks.

## What the model sees

Listings, results, page errors, schema issues and the address a page navigated to reach the model
inside `<webmcp_tools>`, `<webmcp_result>`, `<webmcp_error>`, `<webmcp_schema_issues>` and
`<webmcp_navigation>` blocks marked `trust="untrusted-data"`. The block's body is JSON with every
`<` written as `\u003c`, so no text from the page can close the block. A tool that returns JSON as
text, as most do, has that text parsed first, so the model reads the JSON once rather than escaped
inside a string. A result too long for the chat keeps the start and end of its JSON, and the agent
finds a value in the rest with `tool_output`'s `find`. A result the page marks
`untrustedContentHint` carries a note saying so. Routine browser observations name the page's tools
so the agent can find them.

Stored credentials are taken out of a result and an error before they are quoted, so escaping
cannot hide a value. The result then passes through the tool output bounds and the credential
redaction that apply to all tool results, which also matches the JSON forms other writers produce:
`<`, `>` and `&` as `\u` escapes, non-ASCII escaped, and JSON quoted inside JSON.

## Browser panel

`workspaceSnapshot` reports the active tab's tools with the origin, each description cut to 300
characters. The panel's toolbar shows a plug button with the count, which opens the list inline
under the toolbar, so the page view, which is drawn above the app, is never covered.

## Verification

- Unit suites cover the registry, the compatibility script against a model of Chromium 150, the
  schema checker's limits and malformed schemas, the service's calls through a fake surface
  (including a stop before the invocation id, a filled password, and a tab or tool that changed
  after the decision), the handlers' wrapping, redaction, refusals, access and approval card, the
  kernel hook and its ordering within one reply, and the panel.
- The native browser smoke drives a fixture page through the real kernel with a scripted model in
  real Chromium: a read-only call runs without asking in **Ask for sensitive actions** and its
  `execute` receives a signal, the changing call asks, invalid arguments, a new document and another
  site are refused without asking, **Full access** asks nothing, and **Ask before every change or
  command** asks even for the read-only tool.
