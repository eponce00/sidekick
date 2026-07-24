# SideKick Search

SideKick Search is the app's built-in, keyless search capability. It does not require a container, a separately running search server, an account, or a paid search API.

## How it works

For text queries, the Electron main process sends ordinary browser-style requests directly to three public search surfaces in parallel:

- DuckDuckGo HTML
- Brave Search HTML
- Bing HTML

Each source has a small parser adapter. SideKick canonicalizes destination URLs, removes common tracking parameters, merges duplicates, and applies reciprocal-rank fusion. Cross-source agreement and query-term overlap increase a result's score, while domain diversity prevents one site from filling the first page. Results retain their source attribution.

This is a federation, not a fallback chain: a slow or changed source does not stop the other sources from returning useful results. Every query records bounded per-source diagnostics, and successful fused results are cached in memory for five minutes.

## Images and page reading

Image discovery uses DuckDuckGo's browser-facing image flow directly. SideKick establishes the same short-lived query session used by the public site, normalizes the returned image metadata, and can download a small number of images into memory when a vision-capable model needs pixels. Electron decodes and resizes those images locally before they reach the model.

`web_fetch` requests a page directly and extracts its main text with Mozilla Readability. If the initial HTML has no readable body or the site requires JavaScript, SideKick performs one isolated render in a hidden Electron window and runs Readability on the rendered document.

## Runtime and privacy boundaries

All orchestration, parsing, ranking, deduplication, caching, page extraction, and image processing run inside SideKick. Internet search still necessarily contacts the selected public search sites and result pages; there is no intermediate SideKick service. Queries are therefore subject to those sites' availability and policies.

There is deliberately no endpoint setting. Source changes are maintained as application code and
covered by deterministic parser tests plus an opt-in live smoke test:

```bash
npm run test:search-smoke
```

The source interface and result-fusion core contain no Electron UI state. Electron-specific page
rendering and image resizing remain isolated inside the desktop implementation.
