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
  for a declarative form.

## Listing and calling

`browser_list_webmcp_tools` records which document and tool versions the agent saw.
`browser_call_webmcp_tool {origin, tool, arguments}` is refused, before anything runs, when:

| Refusal             | When                                                     | Result code         |
| ------------------- | -------------------------------------------------------- | ------------------- |
| `cross_origin`      | The tab's origin is not `origin`                         | `permission_denied` |
| `not_listed`        | The tab's tools were not listed on this origin           | `conflict`          |
| `navigated`         | The tab loaded another document since the listing        | `conflict`          |
| `not_found`         | The tool was not listed, or the page removed it          | `not_found`         |
| `changed`           | The page registered the tool again since the listing     | `conflict`          |
| `invalid_arguments` | The arguments are not an object or do not fit the schema | `invalid_arguments` |
| `unavailable`       | The tab never enabled WebMCP                             | `unsupported`       |

The arguments are checked with the registry's schema checker in its external mode
(`externalSchemaIssues`): types, required properties, enums, ranges, lengths and alternatives, but
never a page's `pattern`, and for at most 5,000 steps, after which the page checks its own input.
A call to a page whose human-verification check is showing is refused like every automated input.

An accepted call sends `WebMCP.invokeTool {frameId, toolName, input}`. If the top frame loaded a
new document before Chromium returned the invocation id, the call is cancelled and reported, since
it may have reached a same-named tool on the new page. The answer arrives as `toolResponded`; an
answer that comes before the invocation id is kept until it is awaited. A call ends:

- when the page answers. A result is cut to 256 KB of JSON; a thrown error's description is cut to
  2,000 characters and its remote object released;
- after 30 seconds, or when the run stops, with `WebMCP.cancelInvocation`;
- when the page navigates. Chromium never answers a script tool after that, so SideKick waits one
  second and reports where the page went. A form's answer comes from the page its submission loaded,
  so a form waits for it until the timeout.

## Permissions

`browser_list_webmcp_tools` is a read. `browser_call_webmcp_tool` has `execute` risk, and the run
kernel asks the tool router for its requested access (`requestedAccess`): `auto` for a listed,
current tool the page marks read-only, `confirm` otherwise, and `auto` for a call that will be
refused, since it runs nothing. Browser tools run one at a time, so nothing can list or change the
page's tools between that decision and the call; the call still checks everything again. The
permission mode then applies as to any tool, and an **Allow for this chat** grant covers the exact
arguments, including the origin. The approval card shows the site, the tool, the site's description
and its read-only mark.

## What the model sees

Listings, results and page errors reach the model inside `<webmcp_tools>`, `<webmcp_result>` and
`<webmcp_error>` blocks marked `trust="untrusted-data"`. The block's body is JSON with every `<`
written as `<`, so no text from the page can close the block. A result the page marks
`untrustedContentHint` carries a note saying so. Routine browser observations name the page's tools
so the agent can find them. Every result also passes through the tool output bounds and the
credential redaction that apply to all tool results.

## Browser panel

`workspaceSnapshot` reports the active tab's tools with the origin, each description cut to 300
characters. The panel's toolbar shows a plug button with the count, which opens the list inline
under the toolbar, so the page view, which is drawn above the app, is never covered.

## Verification

- Unit suites cover the registry, the compatibility script against a model of Chromium 150, the
  schema checker's limits, the service's calls through a fake surface, the handlers' wrapping,
  refusals, access and approval card, the kernel hook, and the panel.
- The native browser smoke drives a fixture page through the real kernel with a scripted model in
  real Chromium: a read-only call runs without asking in **Ask for sensitive actions** and its
  `execute` receives a signal, the changing call asks, invalid arguments, a new document and another
  site are refused without asking, **Full access** asks nothing, and **Ask before every change or
  command** asks even for the read-only tool.
