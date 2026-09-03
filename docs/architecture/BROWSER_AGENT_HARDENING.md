# Browser agent hardening

**Date:** 2026-09-02
**Status:** implemented on `codex/browser-agent-hardening`; deterministic, real-Electron, and repository-wide verification passes, but an after-change model-level latency benchmark has not yet been run.

This report records a sanitized forensic review of one failed long-form browser run and the resulting hardening work. It contains aggregate timings and tool-envelope sizes only—no chat text, form values, credentials, local database records, or user identifiers.

## Failure timeline and root causes

| Stage | Observed behavior | Root cause |
| --- | --- | --- |
| Session start | Navigation was attempted before an explicit browser session existed, costing a recovery turn. | `open` and first navigation had unnecessarily separate contracts. |
| Form entry | Standard fields were handled one model turn at a time. Each action returned another large page observation. | There was no batched form action, and routine action receipts repeated a full semantic snapshot and image metadata. |
| Native selects | A broad label matched several accessibility nodes; the recovery message suggested `nth`, although the public schema did not expose it. A long option list also displaced later controls from the model-visible head of the snapshot. | The public target schema lagged the backend, targeting was not action-aware, and snapshot truncation favored document order rather than interactive value. |
| Visual fallback | A high-DPI screenshot was larger than the CSS viewport. The model produced a point outside the accepted CSS coordinate space. | Image pixels and input coordinates did not share a bound, explicit coordinate system. |
| Recovery | Slightly different clicks and scrolls produced no useful state change, but the loop continued until the agent concluded that the form was not practically automatable. | Effect reporting and loop protection were too weak, while each extra reasoning turn became increasingly expensive. A separate sanitized reproduction confirmed that the native select accepted the supported select operation. |

The primary failure was therefore not browser execution speed. It was the combination of a mismatched tool contract, noisy state, excessive model round trips, and weak post-action verification.

## Before-change evidence

These figures describe the single incident used for diagnosis, not a general benchmark.

| Metric | Before |
| --- | ---: |
| End-to-end wall time | 31 min 42 s |
| Model turns | 35 |
| Prompt tokens, first to last turn | 8,880 → 106,600 |
| Summed time to first token | 1,844 s |
| Median / final-turn TTFT | 58.4 s / 90.7 s |
| Browser actions | 14 |
| Summed browser action time | 18.2 s, about 1% of wall time |
| Browser tool results | 34 |
| Browser result text retained in the model transcript | 259,386 characters, roughly 65k tokens at a non-tokenizer estimate of four characters per token |
| Typical successful browser action receipt | about 17.3k characters |
| Example viewport image / CSS viewport | 3840×2016 / 1280×672 at device-pixel ratio 3 |
| Cached-input accounting | unavailable; this must not be interpreted as a zero-token cache hit |

## Adopted design principles

- **Make state transitions explicit and batch safe operations.** OpenAI's [Computer use loop](https://developers.openai.com/api/docs/guides/tools-computer-use#option-1-run-the-built-in-computer-use-loop) executes the returned action array in order and captures updated state after the batch. SideKick should likewise avoid a model round trip for every independent form field.
- **Bind visual actions to the exact image coordinate space.** OpenAI's [screenshot guidance](https://developers.openai.com/api/docs/guides/tools-computer-use#4-capture-and-return-the-updated-screenshot) requires coordinate remapping when an image is resized. SideKick now identifies the source screenshot and scales its pixels back to the current CSS viewport instead of assuming device pixels equal input pixels.
- **Prefer semantic references; use vision where semantics are insufficient.** [Playwright MCP](https://github.com/microsoft/playwright-mcp) is built around structured accessibility snapshots and exact element references, while retaining an optional vision capability. Semantic targets are cheaper and more deterministic for ordinary controls; screenshots remain essential for canvas, imagery, layout, and visual verification.
- **Resolve uniquely and act only when the element is actionable.** Playwright's [actionability model](https://playwright.dev/docs/actionability) checks uniqueness, visibility, stability, event reception, enabled state, and editability as appropriate. SideKick has adopted uniqueness, role-aware targeting, basic visibility, and form-state verification; the complete actionability model remains roadmap work.
- **Filter browser state before presenting it to the model, then verify the effect.** Browser Use's official [browser-control guidance](https://github.com/browser-use/browser-use/blob/main/skills/browser-use/SKILL.md) recommends filtering the accessibility tree before printing it, using screenshots for layout or imagery, and checking targeted state after interaction. It also favors reusing the current task tab rather than reopening equivalent pages.
- **Treat browser control as a security boundary.** OpenAI recommends an isolated environment, explicit domain/action boundaries, untrusted-page handling, and human involvement for hard-to-reverse actions in its [computer-use safety guidance](https://developers.openai.com/api/docs/guides/tools-computer-use#keep-a-human-in-the-loop) and [point-of-risk confirmation guidance](https://developers.openai.com/api/docs/guides/tools-computer-use#confirm-at-the-point-of-risk).

## Implemented changes

The branch currently implements the following:

1. **Smaller model-facing state.** Routine actions now return a compact observation with actionable semantic lines prioritized across the captured tree, bounded diagnostics, and screenshot identity/hash metadata. Images are attached automatically for navigation, resize, coordinate actions, and no-effect recovery, or explicitly on request—not for every ordinary field action. Old verbose browser receipts larger than the legacy threshold are compacted when provider history is reconstructed, without rewriting the durable ledger. See the [browser handlers](../../src/main/services/agentBrowserToolHandlers.ts) and [history reconstruction](../../src/main/services/conversationRunPreparer.ts).
2. **A complete target contract.** Click, type, and select expose accessible `role`, `name`, `exact`, and zero-based `nth`. Action-specific role filtering removes headings and wrappers but preserves ambiguity between multiple genuinely actionable controls. First-use URL navigation now opens the conversation browser automatically. See the [tool catalog](../../src/shared/agentToolCatalog.ts), [handler mapping](../../src/main/services/agentBrowserToolHandlers.ts), and [native target resolution](../../src/main/services/nativeBrowserSessionService.ts).
3. **Bound, scaled visual fallback.** Viewport captures are normalized toward CSS dimensions. Coordinate click and hover require the `screenshot_id` of the image used to select the point, reject stale screenshots, validate against that image, and scale to the live viewport. A screenshot token is bound only when URL, document epoch, viewport, scroll offset, and DOM-mutation revision remain stable across capture. Electron's exact transient `UnknownVizError` capture failure receives two short, cancellation-aware retries; other surface errors fail immediately. See the [native screenshot and coordinate implementation](../../src/main/services/nativeBrowserSessionService.ts).
4. **Stronger native select behavior.** Option matching now uses deterministic exact precedence followed by normalized case/whitespace matching and a unique partial fallback. Errors return bounded candidate text, and the selected values are read again after page handlers and quiescence. See the [native select implementation](../../src/main/services/nativeBrowserSessionService.ts).
5. **Verified form batching.** `browser_fill_form` fills up to 25 standard textboxes, native selects, checkboxes, and radio buttons in order. It disallows coordinates, inspects actual control state after every field, stops on failure or page change, marks later fields skipped, and emits one final semantic observation without a screenshot. Input text, option values, and checked choices are redacted from durable tool arguments and returned observations. See the [tool schema](../../src/shared/agentToolCatalog.ts), [runtime redaction](../../src/main/services/agentToolRuntime.ts), and [native form transaction](../../src/main/services/nativeBrowserSessionService.ts).
6. **Verified text-entry ownership.** Text entry uses a real pointer focus, then proves the original connected textbox still owns focus and the URL/document epoch are unchanged. When replacing content it repeats that check after both Select All and Backspace renderer boundaries, before inserting the new value. This prevents page key handlers, redirects, or autofocus from moving sensitive input into another page or field. See the [native text-entry implementation](../../src/main/services/nativeBrowserSessionService.ts).
7. **Truthful timing and updated model guidance.** The central registry now owns canonical tool start/completion time instead of preserving near-zero handler-construction timing. The browser prompt directs models toward semantic references, form batching, native select actions, selective vision, and current screenshot IDs. See [canonical tool results](../../src/shared/agentRuntime.ts) and the [browser prompt](../../src/shared/prompts/PromptComposer.ts).

These changes are designed to reduce redundant input and recovery turns. No latency or task-success improvement is claimed until the before workflow is rerun under the same model and server conditions.

## Verification status and remaining qualification

Current checks on 2026-09-02:

- Focused browser hardening suites passed **45/45 tests**, including stale-coordinate, same-URL-navigation, select replacement/reversion, transient capture, and click/clear focus-theft privacy cases.
- The full Vitest suite passed **165 files and 767 tests**; 6 files and 22 tests remained intentionally skipped.
- `npm run test:native-browser-smoke` passed **20/20 consecutive runs** against real Electron/Chromium. It checked navigation policy, CSS-sized viewport capture, semantic click/type, four verified and redacted form-control types, ephemeral partition isolation, full-page and element screenshots, console/network capture, popup handling, and clean close.
- `npm run lint`, `npm run typecheck`, `npm run docs:check`, and `git diff --check` passed.
- `npm run build:win` produced the NSIS installer; packaged-runtime and Windows release-artifact validation passed, followed by a launched packaged-app smoke test with the expected four Electron processes.
- A non-breaking transitive dependency refresh reduced `npm audit` from four findings to **0 vulnerabilities**. The full 767-test suite, lint, typechecking, and a real-Electron native-browser smoke were repeated successfully afterward.

These checks validate implementation contracts, not model-level performance. Release qualification should additionally:

1. Replay the same sanitized long-form task at least 20 times with fixed model/server settings, separating cold and warm runs.
2. Record task success, first-try versus recovery success, model turns, prompt tokens, TTFT, tool-result bytes, screenshot attachments, browser action time, no-effect actions, and total latency. Report cached-input telemetry as unavailable unless the provider supplies it.
3. Add native fixtures for a legacy postback form, very large selects, below-fold controls, nested/virtualized scrollers, overlays/animations, delayed SPA state, custom comboboxes, shadow DOM, and same- plus cross-origin frames.
4. Keep the Windows build, packaged-runtime validation, release-artifact validation, and packaged-app smoke gates mandatory for every release candidate.

## Remaining limitations and roadmap

Priority follow-ups are:

- **Complete actionability.** Generic click/type still lack Playwright-grade stability, center hit-testing/event-reception, enabled/editable checks, and bounded retry around transient re-rendering.
- **Observation scaling.** Semantic prioritization operates only after the native accessibility traversal has captured at most 800 nodes. An extreme early subtree can still hide later controls. Closed-select options should be collapsed, and scoped/on-demand semantic queries should precede a larger-tree fallback.
- **Avoid hidden capture cost.** Routine actions omit most images from model input, but the native service still captures/stores a viewport PNG and a full semantic snapshot internally after each action. State IDs and changed-node deltas should make that work conditional.
- **Scrolling.** Page scrolling currently uses DOM scrolling and element scrolling assumes the target itself is scrollable. Nested panes, virtualized lists, and wheel-driven widgets need scrollable-ancestor discovery plus measured real-wheel fallback.
- **Complex controls and frames.** `browser_fill_form` intentionally excludes autocomplete and custom widgets. Frame-scoped references, OOPIFs, shadow-root controls, upload/download, dialogs, drag/drop, and canvas workflows need dedicated contracts and fixtures.
- **Recovery and safety.** Loop detection still centers on exact action fingerprints and screenshot change. It should use semantic state/effect fingerprints, add a same-session human takeover path, strengthen destination/private-network controls, and replace inspection-only JavaScript regex filtering with a stronger side-effect boundary.
- **Production evidence.** The exact post-change agent benchmark, cache accounting, long-session soak, and resource/storage profile remain unmeasured.
