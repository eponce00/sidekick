# Community updater implementation — 2026-09-07

Implemented on request: background package download and user-triggered app-only restart, without
paid signing. No release or installer was published or executed during this implementation.
The running development app is unchanged; updating development builds is intentionally disabled.

## Changed surfaces

- `src/main/services/appUpdateInstaller.ts`: fixed GitHub download origin, bounded streaming,
  exact SHA-256 manifest match, revalidation of cached files, NSIS launch, Mac ZIP staging and
  bundle validation, retained Mac backup, replacement helper, installer log and failure recovery.
- `src/main/services/appUpdateService.ts`: download/progress/ready/install states, one operation
  at a time, abort during shutdown, visible errors, injectable test adapters.
- `src/main/ipc/appUpdates.ts`: install handler restricted to the app's main frame.
- `src/main/index.ts`: existing session shutdown and database close before installation.
- `src/shared/appUpdates.ts`, `src/preload/index.ts`, renderer development API mock: typed API.
- `src/renderer/src/components/AppUpdateControls.tsx`: progress, restart action and manual fallback.
- `electron-builder.config.cjs`: explicit ad-hoc Mac identity, matching the published 0.7.0 release.
- README and release guide: new trust model, migration, platform limitations and recovery.
- Installer, service, IPC and UI tests alongside their implementations.

## Evidence

- `npm run typecheck`: passed node and renderer checks.
- ESLint on all touched TypeScript/TSX surfaces: passed.
- `node scripts/run-vitest.cjs run src/main/services/appUpdateInstaller.test.ts
  src/main/services/appUpdateService.test.ts src/main/ipc/appUpdates.test.ts
  src/renderer/src/components/AppUpdateControls.test.tsx`: 155 passed, 2 skipped across 19 files
  (the runner also includes its prerequisite suites). NSIS execution is mocked, not a real upgrade.
- `npm run test:release`: 43 passed; existing four-package + SHA256SUMS artifact contract unchanged.
- `npm run docs:check`: passed before this evidence document was added.
- `git diff --check`: passed; unrelated Python line-ending warnings only.
- Actual Mac helper string parsed successfully with Git Bash `-n` on Windows. This proves shell
  syntax only. POSIX-shell test runs on Mac/Linux; skipped on Windows.
- Read-only network probe of published v0.7.0 SHA256SUMS: four matching asset records and expected
  `release-assets.githubusercontent.com` final redirect host. No executable downloaded by this probe.

## Still requires release qualification

One manual installation is required on existing 0.7.0 laptops. They cannot gain an updater remotely
because their current code only opens a release page. Publish an updater-enabled build, then a
subsequent patch to prove an installed upgrade on Windows and Mac, including live permission
prompts, profile/credential retention, agent shutdown and relaunch. No claim of those tests passing
is made here. Mac writable-directory and Gatekeeper behavior must be exercised on actual macOS.

The Mac backup is filesystem recovery, not a database migration rollback guarantee. A new app
that starts but fails later does not automatically roll back. SHA-256 is not publisher
authentication; trust still includes the canonical GitHub release account. Linux intentionally
reveals the verified AppImage for manual replacement. See RELEASES.md for full behavior.
