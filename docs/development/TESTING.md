# Testing and hardening

SideKick combines deterministic unit and integration tests with opt-in live provider evaluations.
The core suites remain reproducible without network access, provider credentials, signing
identities, or a graphical desktop. Supported macOS and Windows runners additionally execute an
isolated real-Electron journey and a packaged launch smoke test.

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

The deterministic suite covers shared policy and contracts, provider stream assembly, durable run
and interaction recovery, transactional workspace mutations, path and symlink containment,
permission enforcement, prompt boundaries, context compaction, plan and goal state, collaboration,
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

Run the small loop during development:

```bash
npm run test:agent-eval:quick
```

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

Windows uses `npm run smoke:packaged:windows`. The community release workflow additionally proves
an exact artifact set and hashes, GitHub/Sigstore provenance, an ad-hoc-only macOS signature, an
intentionally unsigned Windows installer, and application launch. See [Releases](RELEASES.md) for
the exact artifact and physical-machine release contract.

## Regression requirements

Every defect fix should add the smallest deterministic test that fails for the original behavior.
Security-sensitive changes need both an allowed case and a denied or adversarial case. Changes to
shared schemas, prompts, tools, permissions, persistence, or IPC should exercise the boundary that
consumes the value, not only the helper that creates it.

Keep tests isolated: use temporary directories, synthetic content, fake credentials, deterministic
clocks or IDs where relevant, and local HTTP servers instead of live internet dependencies. A
passing live provider run supplements these checks; it never replaces them.
