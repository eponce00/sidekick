# SideKick Search

SideKick Search is the app's built-in, keyless search capability. It does not require a container, a separately running search server, an account, or a paid search API.

It is on by default. **Settings → General → Web search** turns it off, which removes the agent's web search, image search, and page-reading tools; the browser panel still works.

## How it works

For text queries, the Electron main process sends ordinary browser-style requests directly to three public search surfaces in parallel:

- DuckDuckGo HTML
- Brave Search HTML
- Bing HTML

Each source has a small parser adapter. SideKick canonicalizes destination URLs, removes common tracking parameters, merges duplicates, and applies reciprocal-rank fusion. Cross-source agreement and query-term overlap increase a result's score, while domain diversity prevents one site from filling the first page. Results retain their source attribution.

This is a federation, not a fallback chain: a slow or changed source does not stop the other sources from returning useful results. Every query records bounded per-source diagnostics, and successful fused results are cached in memory for five minutes.

A source that answers "too many requests" (HTTP 429) is left alone for five minutes, or for as long as it asks, up to thirty. A search that every source refused or failed is reported to the agent as a failed call that names the search engines, so it does not mistake their limit for its model server's and keep searching.

## Images and page reading

Image discovery uses DuckDuckGo's browser-facing image flow directly. SideKick establishes the same short-lived query session used by the public site, normalizes the returned image metadata, and can download a small number of images into memory when a vision-capable model needs pixels. Electron decodes and resizes those images locally before they reach the model.

Search presentation, model text, and visual input are separate channels. The interface keeps the
linked result metadata it needs to render the gallery, while the model receives compact metadata
and, only when requested, one typed visual attachment from that search. Raw image bytes are never
serialized into tool-result text. Immediately before inference, SideKick applies one image budget,
set by the provider, across user attachments, image searches, and browser screenshots, retaining
the newest relevant tool visuals without rewriting the durable conversation history.

`web_fetch` requests a page directly and returns it as Markdown: the page's details (description, author, publish and update dates, and structured data such as versions, ratings, and prices), its main article as found by Mozilla Readability, and the text around the article that the article does not repeat, such as a sidebar's figures. Navigation menus and footers are left out. A page longer than one read keeps its opening and the parts that best match the information the agent asked for, marks what was left out, and saves the whole page so the agent can read on with `tool_output`. JSON, plain-text, CSV, and Markdown responses, such as a public API's data, are returned as the data itself, with JSON pretty-printed and long bodies truncated; data longer than one read keeps its start. A page is decoded by the charset its response header or its own `<meta>` tag names, such as windows-1252 or Shift_JIS, and as UTF-8 when neither does. A page that cannot be read is reported as a failed call, including one larger than 10 MB. If the initial HTML has no readable body, the site requires JavaScript, or the direct request does not finish within 18 seconds, SideKick performs one isolated render in a hidden Electron window, limited to 25 seconds, and reads the rendered document the same way.

### Addresses on your network

`web_fetch` follows the [browser's rules for your local network](BROWSER.md#isolation-and-safety), and one answer covers both:

- It never reads an address on your own computer, such as `http://localhost:3000`; the agent opens those in the browser, where you can watch.
- A plain-HTTP address on your local network, such as a router at `http://192.168.1.1`, is read only after you allow it in the browser's dialog. Allowing it in either place allows it in both, and removing it in **Settings › Agent › Local network** removes it from both.
- An HTTPS address written as a local address or local name, such as `https://nas.local`, opens as it does in the browser, its certificate vouching for the device that answers.
- Nothing on the internet leads into your network. Each redirect is checked before it is followed, and a public page that redirects to a local address is refused. So is a public name that resolves to a local or loopback address, including one that changes its answer between requests: SideKick checks the addresses each connection actually uses.

A rendered read applies the same rules to every request the page makes, and its result is discarded if any response came from an address its request could not reach. Image search downloads images only from the internet. SideKick makes these requests directly rather than through a proxy, which would connect to addresses SideKick never sees.

## Runtime and privacy boundaries

All orchestration, parsing, ranking, deduplication, caching, page extraction, and image processing run inside SideKick. Internet search still necessarily contacts the selected public search sites and result pages; there is no intermediate SideKick service. Queries are therefore subject to those sites' availability and policies.

There is deliberately no endpoint setting. Source changes are maintained as application code and
covered by deterministic parser tests plus an opt-in live smoke test:

```bash
npm run test:search-smoke
```

The source interface and result-fusion core contain no Electron UI state. Electron-specific page
rendering and image resizing remain isolated inside the desktop implementation.
