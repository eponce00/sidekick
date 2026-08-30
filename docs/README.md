# SideKick documentation

This directory is the canonical guide to the current SideKick product and repository. Start with
the user guide when configuring or operating the app, the architecture guide when changing trusted
behavior, and the development guide when testing or publishing it.

## User guide

- [Providers](user-guide/PROVIDERS.md) — configure local and hosted model connections.
- [Projects](user-guide/PROJECTS.md) — understand folder-backed chats and project instructions.
- [Tools](user-guide/TOOLS.md) — see which capabilities agents can receive and how they are bounded.
- [Permissions](user-guide/PERMISSIONS.md) — choose a policy and review authorization events.
- [Plan mode](user-guide/PLAN_MODE.md) — approve a revisioned plan before implementation.
- [Research](user-guide/RESEARCH.md) — run evidence-backed web research through the normal agent runtime.
- [Collaboration](user-guide/COLLABORATION.md) — coordinate two independent project agents in one group.
- [Search](user-guide/SEARCH.md) — understand web search, image search, and page retrieval.
- [Visual browser](user-guide/BROWSER.md) — inspect, interact with, and verify pages in the native browser.
- [Workspace History](user-guide/WORKSPACE_HISTORY.md) — restore SideKick-authored file changes.

## Architecture

- [System overview](architecture/OVERVIEW.md) — process boundaries, runtime ownership, and data flow.
- [Prompt and context](architecture/PROMPT_AND_CONTEXT.md) — trusted instructions and compaction.
- [Workspace verification](architecture/VERIFICATION.md) — revision-bound evidence and completion guards.
- [Persistent goals](architecture/PERSISTENT_GOALS.md) — durable multi-run objectives.
- [Desktop integration](architecture/DESKTOP_INTEGRATION.md) — operating-system behavior and release targets.

## Development and operations

- [Testing](development/TESTING.md) — deterministic suites, provider smoke tests, and live evaluations.
- [UI guidelines](development/UI.md) — visual and interaction conventions.
- [Releases](development/RELEASES.md) — permanent zero-cost distribution, packaging, provenance, and release checks.
- [Reference repositories](development/REFERENCES.md) — upstream research and attribution policy.
- [Contributing](../CONTRIBUTING.md) — development setup, change requirements, and pull requests.
- [Privacy](../PRIVACY.md) — local data, external service boundaries, retention, and deletion.
- [Security policy](../SECURITY.md) — private vulnerability reporting and supported versions.
- [License](../LICENSE) — GPL-3.0-or-later terms for use, modification, and redistribution.
- [Changelog](../CHANGELOG.md) — user-visible changes by version.

## Roadmap

- [Roadmap](roadmap/ROADMAP.md) — incomplete work and release readiness.
- [Android](roadmap/ANDROID.md) — deferred mobile direction and prerequisites.
- [iPhone and iPad](roadmap/IOS.md) — installable-web-app direction under the zero-cost constraint.

Roadmap documents describe intent, not current behavior. A planned feature belongs there until its
implementation, tests, and user documentation land together.

## Documentation policy

- Each fact has one canonical home. Link to it instead of maintaining parallel specifications.
- Describe current behavior in present tense. Keep unfinished work out of current product guides.
- Keep credentials, private prompts, personal data, account details, machine-specific paths, and
  private endpoints out of the repository.
- Link to authoritative upstream documentation instead of copying vendor references into the repo.
- Use repository-relative links and meaningful image alternative text.
- Update this index when adding, moving, or removing a guide.
- Run `npm run docs:check` for documentation-only changes and `npm run check` before merging code.

The implementation and tests are authoritative when a guide is wrong. Treat that disagreement as a
documentation defect and update the nearest canonical guide in the same change.
