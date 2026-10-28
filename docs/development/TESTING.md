# Testing and hardening

SideKick combines deterministic unit and integration tests with opt-in live provider evaluations.
The core suites remain reproducible without network access, provider credentials, signing
identities, or a graphical desktop. Supported macOS, Windows, and Linux runners additionally
execute an isolated real-Electron journey and a packaged launch smoke test.

## Standard checks

Install dependencies with `npm ci`, then use:

```bash
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:release
npm run test:e2e
npm run docs:check
npm run build
```

`npm run check` runs the merge gate: type checking, lint, documentation validation, coverage-gated
tests, release tooling tests, and a production build.

`npm run test:e2e` builds and launches the real Electron main, preload, and renderer processes with
a temporary application-data directory. It covers a clean start, context isolation, chat creation,
settings and connector discovery, the support surface, local persistence across a restart, and
conversation deletion. It never configures a provider or contacts a live service. CI runs the same
runtime journey after creating the unpacked application, then separately smoke-tests the packaged
executable.

## Agent behavior

Unit tests show that each part works; they do not show how much or when. A long chat summarized at
half its window and a worker's report cut to 2,000 characters both passed them. Two tools check
sizes and timing instead.

`npm run test:behavior` drives the built app (after `npm run build`) against a scripted
OpenAI-compatible model on loopback (`scripts/scripted-model.cjs`). The model records every request,
and each scenario states the requests it expects, so an extra compaction or retry fails it. The
model reports its prompt at four characters a token, as real tokenizers read English. The
scenarios check that a chat compacts only past the share of the window Settings names, by the
model's count rather than SideKick's higher estimate, that the next run starts from the saved
summary with the recent work kept word for word, that a summary survives the run stopped right
after it and an edit of the request, that every request leaves room for the reply it asks for,
that the context card marks where compaction fires, that a long worker report reaches its manager
whole even when streamed in many small pieces, that a report too long to carry keeps its start and
end and stays readable with `tool_output`, that a reply writing the same tool call over and over is
stopped while it streams, runs none of its calls and is told why on the next request, that the
model reads a command's output as plain lines, that a reply whose connection drops partway is asked
again once and keeps only the whole reply, that a reply limit the provider refuses is asked again
once at the cap it names, and that a gateway with nothing behind it fails the reply with a heading
and message saying so. CI runs them in each platform's packaging job.

`npm run audit:runs -- --profile installed` (or `--profile dev`, or a database path) reads a
profile's run journals read-only and reports what looks wrong: compactions before 60% of the window,
runs that began by compacting after a run that had sent less than that, how much a compaction kept,
the share of fallback summaries and why each was used, how SideKick's
estimate of a request compared with the provider's count, runs that compact or retry after
failures again and again, requests that did not fit the window, working runs that went quiet for 10
minutes or more (a `wait` within the time it asked for is expected), worker reports that did not
carry the whole reply, replies cut off while they wrote tool calls, counted per reply with their
cause (cuts that followed another cut, a limit shrunk to the room left, tokens used against the
limit), and replies that ran away: more than 64 tool calls, or one call more than three times. It
prints counts and run ids,
never message content, and exits 1 when something is flagged. Thresholds are flags; see `--help`.

### Context budget

Every turn sends the system prompt and the tool schemas before any history, and a local model with
a small window pays for each byte. `src/shared/agentContextBudget.test.ts` composes them for a full
conversation turn (project folder, web search, browser, code intelligence, a chat that can start
other chats, Windows, a local Qwen model) and for a sub-agent, and requires the byte counts to equal
`src/shared/agentContextBudget.json`: the system prompt, the tool count, the tools' OpenAI function
JSON, and each tool's share. A change to prompt or tool text therefore updates that file, with
`npx vitest run src/shared/agentContextBudget -u`, and the diff shows what it costs.

On a pull request, CI compares the file with the base branch's copy
(`scripts/check-agent-context-budget.cjs`) and fails when any number grew, including a new tool.
When the growth is worth it, add the `agent-context-increase` label and re-run the job.

### Harness fault scenarios

`src/main/evals/harnessFaults.test.ts` replays harness bugs found in real runs. Each scenario runs
the real kernel and tools (`AgentScenarioHarness`) against the scripted model, in an environment
with the fault that caused the bug, and checks what SideKick told the model and the user. Each
fails on the commit before its fix. They run in the ordinary suite:

- A reply that compacts mid-run keeps the user's latest request word for word right after the
  summary, even when the summary names an earlier question as the objective (fixed in 0.22.0).
- `web_search` where every engine answers HTTP 429 is a failed call whose text names the engines
  and says they are not the model provider, and a second search inside the cooldown asks no engine
  (0.22.1).
- A background command whose script starts a program with `Start-Process` (Windows) or `nohup … &`
  (macOS, Linux) stays running until the program ends and ends with the `[SideKick]` note that the
  shell exited first; stopping it after its shell exited ends the program (0.22.1).
- A model that repeats the same failing call is warned from the second call and stopped with
  `loop_detected` by the fifth.

A new harness bug gets a scenario here when a scripted model and a faulted environment can
reproduce it; one that needs the built app's windows, settings or storage belongs in
`npm run test:behavior`.

## Continuous integration

CI runs its work in parallel jobs: one Linux job for the platform-independent checks and coverage,
the suite on macOS and on two Windows machines (it runs on one worker there), and a packaging job
per platform for the runtime journey and smoke tests. The `Validate (…)` checks that branch
protection requires pass only when every one of those jobs passed. Installed dependencies are cached
by the locked dependencies and the Node version; the key leaves out SideKick's own version, so a
release pull request keeps the cache. The Windows runners skip Defender's real-time scanning. A
failed `npm ci`, in CI or a release build, gets one more attempt, so a transient registry error does
not fail the job.

The deterministic suite covers shared policy and contracts, provider stream assembly, durable run
and interaction recovery, transactional workspace mutations, path and symlink containment,
permission enforcement, prompt boundaries, context compaction, plan and goal state, chats that start other chats,
update validation, and renderer behavior. Coverage thresholds are explicit in `package.json` and
must not be lowered merely to make a change pass.

## Focused provider smoke tests

Provider smoke tests are opt-in because they depend on a service outside the repository. Never place
a real key or private endpoint in a committed command, fixture, log, screenshot, or report.

For a local OpenAI-compatible endpoint, set `SIDEKICK_PROVIDER_SMOKE_URL`,
`SIDEKICK_PROVIDER_SMOKE_MODEL`, and, only when required, `SIDEKICK_PROVIDER_SMOKE_API_KEY`, then
run:

```bash
npm run test:provider-smoke
```

For LiteLLM, set `SIDEKICK_LITELLM_SMOKE_URL` and, only when required,
`SIDEKICK_LITELLM_SMOKE_API_KEY`, then run:

```bash
npm run test:litellm-smoke
```

These suites exercise discovery, completion, streaming, cancellation, and protocol normalization.
They skip cleanly when their configuration is absent.

## Live agent evaluations

The live evaluation harness sends synthetic projects through the real main-process agent runtime.
It verifies edits, command use, recovery, verification evidence, plan transitions, and completion
contracts instead of grading assistant prose alone.

Every scenario must run in a uniquely named temporary root and remove that complete root in a
`finally` block. Prefer `withIsolatedEvalRoot` for new scenarios so generated workspaces, command
output, browser artifacts, and runtime databases are removed after passes, failures, and thrown
assertions. Never point a live evaluation at a developer's working project; copy only the required
synthetic fixture into the isolated root.

Run the small loop during development:

```bash
npm run test:agent-eval:quick
```

On a desktop where SideKick already has a selected provider, the configured variants reuse that
selection and decrypt its protected credential only in memory:

```bash
npm run test:agent-eval:configured:quick
npm run test:agent-eval:configured:verification
npm run test:agent-eval:configured:visual
npm run test:agent-eval:configured:comprehensive
npm run test:agent-eval:configured
```

These commands do not write the provider key to an environment file, report, or command line.

Use `npm run test:agent-eval:verification` for the revision-bound completion scenario and
`npm run test:agent-eval` for the full configured matrix. The harness reads provider, model,
endpoint, and credentials from the environment variables in the
[evaluation environment template](../../.env.agent-eval.example). Use an isolated test account and
synthetic fixture data.

`npm run test:system-eval` exercises the broader system scenarios. OpenRouter model comparisons use
`npm run test:openrouter-eval`; configure their matrix through the variables accepted by
`scripts/run-openrouter-model-eval.cjs`. Compare saved result sets with:

```bash
npm run benchmark:agent-evals -- before.json after.json
```

Generated evaluation reports are local artifacts. Review them for private prompts, provider
metadata, tokens, local paths, and account details before sharing them; do not commit raw reports by
default.

Complex visual-artifact scenarios use two result layers. Deterministic requirements—valid SVG/DOM
structure, accessibility names, responsive layout contracts, preserved elements across follow-up
turns, real project checks, and ordered read/edit/verify events—are release-gating. Screenshot
changes, rendered bounds at desktop and mobile viewports, console/network cleanliness, and optional
reference-image similarity are supporting evidence. Subjective aesthetic scoring is never allowed
to turn an otherwise valid harness run into a harness defect by itself. The full live suite includes
a two-turn inline-SVG creation and revision scenario; the native-browser smoke separately proves
real rendering, screenshots, pointer interaction, viewport changes, and browser-session cleanup, and
drives a page's WebMCP tools through the agent kernel in each permission mode.

`npm run test:browser-controls` measures the browser tools on synthetic pages and reports numbers
rather than passing or failing, so the same run compares two builds: how long actions wait to
settle on pages that load slowly, show a spinner, or never stop changing, and whether the result
had arrived; how many custom pickers and date fields `browser_select` and `browser_fill_form`
fill directly; whether an ambiguous or missing option is refused; and, when
`SIDEKICK_AGENT_EVAL_API_KEY`, `_URL` and `_MODEL` are set, whether a real model completes the
booking form, in how many tool calls. `SIDEKICK_BROWSER_CONTROLS_N` and
`SIDEKICK_BROWSER_CONTROLS_AGENT_N` set the trials.

`npm run test:browser-sites` gives a real model eleven flows on public sites, each in its own
Electron process with a time limit: Wikipedia's search suggestions and language picker, the
react-select, MUI and Select2 demos, a flatpickr date, timeanddate.com's date calculator, a
weather.gov location search, GitHub's branch picker, and searches on Google Flights and
Booking.com. Each is checked against the page it ends on or the answer it gives; nothing is
submitted, bought or signed into. Sites change, so this is an evaluation to run before changing
browser tools, not a test that gates a release. Name scenarios to run only those.

`npm run test:artifact-inspector-smoke` renders React, HTML, and SVG artifacts, including one that
fetches live data and one that throws, through the real artifact inspection window, and writes each
capture to `artifact-smoke/` for review. By default it needs the renderer dev server from
`npm run dev`, because outside a packaged build the artifact protocol serves the inspection page
from it; after `npm run build`, pass `-- --production` to serve it from the built renderer instead.

The configured comprehensive lane combines those boundaries in one real Electron-backed journey.
It requires todo state, project reads, raster image inspection, new-file creation, localized
existing-file edits, deletion, commands, verification evidence, desktop and compact browser
observations, real clicks, screenshots, console/network inspection, browser resize and close, plus
a follow-up turn over the first turn's transcript. Plan contracts remain in their dedicated eval so
the comprehensive integration lane measures tool interoperability without paying for a second copy
of the Plan-mode state machine. Its fixture and every browser/runtime artifact live under one
temporary root that the parent process removes even after a failed or timed out child run.

### Replay of bad turns

`npm run test:agent-eval:replay` replays the turns real runs got wrong. Each case in
`src/main/evals/replay/` is one NDJSON file: the first line names the case, the pattern it comes
from, and what the next turn must or must not do (`forbidTools`, `forbidContent`,
`forbidArguments`, and `oneOf` a tool call or a phrase), and every later line is a message of the
conversation trimmed to that turn. The runner adds the system prompt and the full conversation
tool catalog composed from the checkout, asks the configured model for the next turn, and grades
it by code (`src/main/evals/replayCases.ts`). A message with a `fixture` is built by SideKick's own
code, such as the result of a search every engine refused, so a change to that text is replayed
too. The cases cover answering an older question after compaction, retrying a refused search,
treating SideKick's own notes as the user, and misreading a background command as finished.

Each case runs `SIDEKICK_REPLAY_TRIALS` times (default 3), because a model does not answer the same
way each time; `SIDEKICK_REPLAY_CASES` runs only the named cases. The report records the revision
it measured, with `+changes` for uncommitted edits. To score a prompt or tool-text change, run the
same cases on both versions and compare the reports; the comparison lists each case whose result
differs:

```bash
SIDEKICK_AGENT_EVAL_REPORT=before.json npm run test:agent-eval:replay
SIDEKICK_AGENT_EVAL_REPORT=after.json npm run test:agent-eval:replay
npm run benchmark:agent-evals -- before.json after.json
```

It calls a model, so it never runs in CI. Write a new case by hand from the pattern a bad run
shows, never by copying a conversation, prompt, path or credential from a run journal.

### Real-world scenarios

`npm run test:real-world-eval -- <model> [<model> …]` runs project-sized tasks on free OpenRouter
models (`src/main/evals/realWorld.live.test.ts`): the production kernel, tools, terminal and system
prompt on a small synthetic project, graded by what ends up on disk and in the reply. They cover a
failing test, a long background job, a launcher that starts another program, a server's whole
lifecycle, a command waiting at a prompt, a long log, git, a rename across files, live web
research, a two-turn revision, a large file, CRLF and accented text, and a 24k window that has to
compact. After each run the model is asked, with tools off, what in the tooling got in its way;
treat its answer as a lead to check in the transcript, not a finding. `SIDEKICK_REALWORLD_ONLY`
runs only the named scenarios, and `SIDEKICK_REALWORLD_REPORT` and
`SIDEKICK_REALWORLD_TRANSCRIPTS` save the results and each run's messages. It reads the OpenRouter
key like the other evaluations and calls models, so it never runs in CI.

## Search and packaged-app tests

`npm run test:search-smoke` performs an opt-in live search check. Keep ordinary search behavior
covered by mocked deterministic tests so CI does not depend on public search pages.

Packaging validation is platform-specific:

```bash
npm run build:unpack
npm run test:e2e:runtime
npm run validate:package -- <unpacked-app-path>
npm run smoke:packaged:macos -- <app-path>
```

Windows uses `npm run smoke:packaged:windows`. Linux uses
`xvfb-run --auto-servernum npm run smoke:packaged:linux` and validates the final AppImage with
`npm run validate:linux-appimage -- <appimage-path>`. The community release workflow additionally
proves an exact artifact set and hashes, GitHub/Sigstore provenance, an ad-hoc-only macOS signature,
a Windows installer that is unsigned or, once configured, carries a valid SignPath Foundation
signature, the Linux desktop/icon identity, and application
launch on all three operating systems. See [Releases](RELEASES.md) for the exact artifact and
physical-machine release contract.

## Regression requirements

Every defect fix should add the smallest deterministic test that fails for the original behavior.
Security-sensitive changes need both an allowed case and a denied or adversarial case. Changes to
shared schemas, prompts, tools, permissions, persistence, or IPC should exercise the boundary that
consumes the value, not only the helper that creates it.

Keep tests isolated: use temporary directories, synthetic content, fake credentials, deterministic
clocks or IDs where relevant, and local HTTP servers instead of live internet dependencies. A
passing live provider run supplements these checks; it never replaces them.
