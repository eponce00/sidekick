# SideKick contributor instructions

These instructions are for anyone changing SideKick, human or AI agent. `CLAUDE.md` and
`.github/copilot-instructions.md` point here. Keep personal notes in `AGENTS.local.md` or
`CLAUDE.local.md`, which are not committed.

SideKick is a local-first Electron desktop agent for macOS arm64, Windows x64, and Linux x64. Read
the [documentation index](docs/README.md), then the nearest canonical guide for the area being
changed. Incomplete work belongs in the [roadmap](docs/roadmap/ROADMAP.md), not in current product
documentation.

## Architecture rules

- Treat the renderer as untrusted. Provider credentials, model streams, commands, file mutations,
  MCP calls, permissions, checkpoint restore, navigation, and updates are owned or authorized by the
  trusted main process.
- Put serializable cross-process contracts in `src/shared`. Expose the narrowest typed preload API;
  do not import Electron or Node runtime modules into shared or renderer code. A new preload API
  also needs its entry in the development mock, `src/renderer/src/dev/browserApiMock.ts`.
- Route agent execution through the canonical main-process runtime (`AgentRunKernel`). Do not add
  provider loops, tool dispatch, search bridges, or mutation paths in React components.
- Resolve configured provider instances in the main process. Never return decrypted credentials to
  renderer state or add branded provider IPC when the registry/provider runtime can own the work.
- Route workspace writes through the transactional mutation service and canonical path resolver.
  Preserve read receipts, conflict checks, verification, rollback, and permission enforcement.
- Keep platform behavior explicit. macOS uses native traffic lights; Windows uses SideKick caption
  controls. Community artifacts and release-check behavior must match the permanent zero-cost
  [release guide](docs/development/RELEASES.md).

## Commands

| Purpose                                        | Command                                   |
| ---------------------------------------------- | ----------------------------------------- |
| Types                                          | `npm run typecheck`                       |
| Lint                                           | `npm run lint`, or `npx eslint <files>`   |
| Focused tests                                  | `npx vitest run <paths>`                  |
| Whole suite (runs under Electron's Node)       | `npm test`                                |
| Documentation                                  | `npm run docs:check`, `npm run test:docs` |
| Everything required before merging a release   | `npm run check`                           |
| Development app                                | `npm run dev`                             |
| Renderer only, with mock data, on port 5173    | `npx electron-vite dev --rendererOnly`    |

Format only the files you changed: `npx prettier --write <files>`. Running Prettier over a whole
directory rewrites unrelated files.

The Node version is pinned in `.node-version` and must match the Node embedded in Electron; one
release test fails under any other version.

## Verifying a change

- Add deterministic regression coverage for defects and adversarial coverage for
  security-sensitive boundaries. Tests are Vitest files beside the code they cover.
- Check user-visible changes in the running app, not only in tests. The renderer-only server shows
  most UI with mock data at `http://localhost:5173/?ui-preview=1`. For the full app, start it with
  `npm run dev -- --remoteDebuggingPort 9333` and drive or inspect the page over the Chrome
  DevTools Protocol.
- Say plainly what was and was not verified, and how.

## Pitfalls

- A git worktree has no `node_modules`. Link a complete install from the main checkout (a
  directory junction on Windows) instead of reinstalling. An install inside a worktree skips the
  Electron download and native rebuild unless `npm run postinstall` runs afterwards.
- Stop a development instance by its path. Killing every `electron` process also kills other
  Electron apps and `npm test`, which runs under Electron.
- Every development instance shares the `sidekick-dev` profile, so two running at once share one
  database. Run one at a time.
- In PowerShell, pass multi-line commit messages and pull request bodies from a file
  (`git commit -F`, `gh pr create --body-file`). Inline strings turn escapes into literal text.

## Change discipline

- Prefer one final architecture over compatibility shims or parallel implementations. Remove an
  obsolete path when its replacement is complete and migrations are not part of the product
  contract.
- Preserve user data and unrelated work.
- Match the surrounding code: naming, idioms, and comment density. Comments say why, briefly.
- CSS uses the design tokens (`--surface-*`, `--text-*`, `--accent`, `--error`, …), never
  hard-coded colors, and every UI works in light and dark themes.
- Commit titles say what changed for the user in the imperative; the body says why.
- Use authoritative upstream documentation for protocol details. Record material reference-repo
  influence according to [Reference repositories](docs/development/REFERENCES.md), and keep the
  license notice on any adapted code.

## Documentation rules

- Current user behavior belongs in `docs/user-guide`; runtime design belongs in
  `docs/architecture`; contributor and release procedures belong in `docs/development`; unshipped
  work belongs only in `docs/roadmap`.
- Maintain one canonical source for each fact and link to it instead of copying content.
- Do not commit raw conversations, append-only decision logs, copied vendor API manuals, generated
  evaluation reports, credentials, private prompts, personal data, account settings,
  machine-specific paths, or private endpoints.
- Update `docs/README.md` when a guide moves, appears, or is removed.

Security reports follow [SECURITY.md](SECURITY.md). Never move a suspected vulnerability into a
public issue or repository document before coordinated disclosure.
