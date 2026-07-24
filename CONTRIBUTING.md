# Contributing

Thanks for helping improve SideKick. Keep contributions focused, reviewable, and safe for a
local-first desktop application that can access user-selected files and services.

## Before opening an issue

- Search [existing issues](https://github.com/eponce00/sidekick/issues) for the same behavior.
- Use [private vulnerability reporting](SECURITY.md) for suspected security problems. Do not put
  credentials, private prompts, personal files, or exploit details in a public issue.
- For a bug, include the SideKick version, operating system and architecture, minimal reproduction,
  and expected and actual behavior. The metadata-only diagnostic export in **Settings → General →
  Support** can help, but review it before sharing.

## Development setup

SideKick supports Node.js 24 LTS and npm 11 on macOS, Windows, and Linux. Use the exact runtime
recorded in [`.node-version`](.node-version); dependency installation rejects unsupported major
versions.

```bash
git clone https://github.com/eponce00/sidekick.git
cd sidekick
npm ci
npm run dev
```

Read the [development documentation](docs/README.md), especially the
[testing guide](docs/development/TESTING.md), [UI guidelines](docs/development/UI.md), and
[release contract](docs/development/RELEASES.md), before changing those areas.

## Change requirements

- Keep secrets, local databases, logs, screenshots with personal data, editor state, agent memory,
  signing material, and machine-specific paths out of Git.
- Preserve renderer sandboxing, context isolation, main-process credential ownership, workspace
  containment, and explicit permission boundaries.
- Add deterministic tests for behavior changes. Live provider tests must remain opt-in and must not
  make ordinary CI depend on credentials or external services.
- Update user-facing documentation and `CHANGELOG.md` when behavior, privacy, security, setup, or
  release operations change.
- Avoid compatibility layers and duplicate architecture. Migrate callers to the final contract and
  remove obsolete paths in the same change.

Run the merge gate before opening a pull request:

```bash
npm run check
npm run test:e2e
npm audit --audit-level=moderate
```

Platform-specific packaging changes should also run the relevant package validation and smoke test
described in the [testing guide](docs/development/TESTING.md).

## Pull requests

Open a focused pull request against `main`. Explain the user-visible result, important trust or data
flow changes, and the validation performed. `main` requires macOS arm64, Windows x64, and Linux x64
checks, resolved conversations, and a squash merge. Branches are removed automatically after merge.

By contributing, you confirm that you have the right to submit the work and agree to license your
contribution under [GPL-3.0-or-later](LICENSE), the same license as the project.
