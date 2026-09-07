# Release and distribution process

SideKick is permanently free and open-source software under
[GPL-3.0-or-later](../../LICENSE). The upstream project will not depend on subscriptions,
advertising, paid signing certificates, paid developer programs, paid store accounts, or another
revenue source. A release path that later requires one of those payments is not an acceptable
SideKick architecture.

This constraint has unavoidable platform consequences. SideKick documents those consequences
instead of calling an unsigned package seamless or weakening its security boundary to imitate a
trusted installer.

## Platform policy

| Platform        | Zero-cost release path                         | User experience                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64     | Ad-hoc signed DMG and ZIP from GitHub Releases | Gatekeeper warns because Apple notarization requires the paid Apple Developer Program. The user must explicitly approve the app on first launch.                                                                              |
| Windows x64     | Unsigned NSIS installer from GitHub Releases   | SmartScreen may warn. A Microsoft Store MSIX is the preferred future path because individual Store registration and Store signing are currently free.                                                                         |
| Linux x64       | AppImage from GitHub Releases                  | No paid signing program or root installation is required. Users make the downloaded file executable and run it directly.                                                                                                      |
| Android         | Future F-Droid build and/or project-signed APK | F-Droid is preferred. Direct installation can require an advanced sideload flow, and Android's developer-verification rules may add regional friction. SideKick will not pay for Play distribution or full paid verification. |
| iPhone and iPad | Future installable web app (PWA)               | This is the only sustainable zero-cost public route. Native App Store and TestFlight distribution require the paid Apple Developer Program.                                                                                   |

The Windows Store route may require a maintainer to complete Microsoft's free identity verification
and reserve the product identity, but it must not require payment. If Microsoft makes that route
paid, the GitHub community installer remains the supported fallback.

[SignPath Foundation](https://signpath.org/) may be evaluated as an optional free open-source
Authenticode service. It is not part of the core release contract because acceptance and continued
service are controlled by a third party; SideKick must remain releasable when it is unavailable.

The macOS warning cannot be removed by a technical workaround without either paying Apple or asking
users to weaken system-wide security. SideKick does neither. Contributors may build from source,
and users of the GitHub package follow Apple's per-app **Open Anyway** flow.

## Security model

The app checks the public GitHub Releases API after startup and every six hours. The community
updater downloads newer stable packages automatically, streams them to a private staging directory,
and verifies the exact asset against that release's `SHA256SUMS.txt`. It permits only the canonical
GitHub release path and GitHub's release-assets HTTPS host. It never accepts an installer URL or
file path from the renderer. Installation requires **Restart and update** and a native confirmation;
normal closing does not silently install. The computer is never restarted.

This is an explicit change from the notification-only policy in 0.7.0. Checksums protect against
corrupt/mismatched downloads, not a compromised publisher or GitHub account. The updater does not
automatically verify Sigstore provenance, and ad-hoc signing does not authenticate a publisher.
The release workflow's provenance remains independently verifiable below. No OS security setting
is changed; there is no quarantine removal, elevation helper or Gatekeeper bypass.

Windows launches the existing NSIS installer with `--updated --force-run` after graceful shutdown;
its normal OS/installer prompts remain. macOS arm64 extracts the verified ZIP beside the installed
app, checks bundle ID/version and strict code-signature integrity, then uses a fixed, argument-based
helper to wait for exit and replace the app. It retains `SideKick.previous.app` in the adjacent
`.sidekick-update-*` directory and rolls back a failed move or immediately failed `open` command.
That is not a post-launch health guarantee: Gatekeeper can still block a launch after `open` returns.
The previous bundle remains available for recovery. Installer output stays under the user-data
`updates/pending-*/installer.log`; asynchronous Mac helper failures show an OS alert.

The Mac app must run outside a DMG/translocation, in a writable installation directory (for example
`~/Applications`). An unwritable `/Applications` installation uses the manual release fallback;
SideKick never changes directory permissions. Linux receives a verified AppImage and **Show
downloaded update**, without moving an arbitrary user-selected installation. Unsupported
architectures get a visible error and **View release**. Development builds cannot install updates.
Interrupted downloads are removed; completed downloads are rehashed before reuse and installation.
Old verified downloads and Mac backups are retained, not silently deleted. No profile data is moved.

Every tagged release instead has four independent trust signals:

1. the source tag resolves to the exact public commit built by GitHub Actions;
2. the release workflow validates the exact artifact names and rejects extras;
3. `SHA256SUMS.txt` records the exact SHA-256 digest of every installer;
4. GitHub Actions publishes a Sigstore-backed artifact provenance attestation for those checksums.

The public publisher uses only the short-lived, repository-scoped `GITHUB_TOKEN`. No personal
access token, signing secret, update credential, or private release server is packaged into the
application.

Verify a downloaded artifact from this repository with:

```bash
gh attestation verify SideKick-<version>-macos-arm64.dmg \
  --repo eponce00/sidekick
shasum -a 256 -c SHA256SUMS.txt
```

On Windows, use `certutil -hashfile <installer.exe> SHA256` and compare the result with
`SHA256SUMS.txt`. On Linux, use `sha256sum -c SHA256SUMS.txt`, then make the AppImage executable
with `chmod +x SideKick-<version>-linux-x64.AppImage`. The attestation proves which public workflow
produced the bytes; it does not make an unsigned executable trusted by Apple Gatekeeper or Windows
SmartScreen.

## Artifact contract

A valid community release contains exactly:

```text
SideKick-<version>-macos-arm64.dmg
SideKick-<version>-macos-arm64.zip
SideKick-<version>-linux-x64.AppImage
SideKick-<version>-windows-x64-setup.exe
SHA256SUMS.txt
```

The macOS application uses an ad-hoc code signature so its nested Electron bundle has a complete
code-signing structure, but it has no Apple Developer ID and no notarization ticket. The Windows
installer has no Authenticode signature. The workflow verifies both facts so an accidental local
identity or an undocumented paid dependency cannot change the release contract.

Application branding has one vector master at `build/icon.svg`. Its reviewed ICNS, ICO, and runtime
PNG derivatives are checked in and hash-validated so clean release runners do not depend on an icon
conversion download and cannot silently fall back to Electron artwork.

Electron-builder may create blockmaps in a platform build folder. They are deliberately excluded
from the public release, and the final merged-set validator rejects them because the community
updater uses full packages and SHA-256 manifests. Portable Windows executables remain outside the current release
contract.

The Linux package uses the modern static AppImage runtime instead of the legacy FUSE2-dependent
runtime. Its build sets one reverse-DNS executable, desktop filename, launcher icon, and
`StartupWMClass`; CI extracts the final AppImage to verify those identities, confirms the Electron
sandbox is not disabled by the launcher, audits its packaged resources, and launches the exact
release file under a virtual display.

Run the validator tests locally with:

```bash
npm run test:release
```

Validate an already-built platform directory with:

```bash
npm run validate:release -- --version 0.6.0 --platform macos dist
npm run validate:release -- --version 0.6.0 --platform windows dist
npm run validate:release -- --version 0.6.0 --platform linux dist
```

## What the tagged workflow proves

A manual workflow run builds and tests packages without publishing them. A stable tag matching
`package.json`, such as `v0.6.0`, runs the same gates and may publish.

All three platform jobs run typechecks, lint, documentation validation, the test suites, release
validator tests, a packaged build, an isolated real-Electron critical journey, a packaged-content
audit, and a launch smoke test. Windows verifies that its NSIS installer is intentionally unsigned.
macOS verifies strict bundle integrity, an ad-hoc signature, and the absence of an Apple certificate
authority. Linux extracts and validates its AppImage metadata and icon identity, then launches the
final AppImage under Xvfb.

The desktop journeys explicitly launch the built platform executable through
`SIDEKICK_E2E_EXECUTABLE`, not development Electron. They use disposable profiles
to check first startup, same-window native browsing, settings persistence, and
durable interrupted-run recovery. The Linux journey uses the unpacked executable;
the separate AppImage smoke checks the final launcher. macOS release startup must
pass strict code-signature validation even though its signature is ad-hoc.

These automated gates do not prove installation or an upgrade from a prior released
version. In particular, the synthetic crash journal is not an old-version database
fixture. Real macOS Gatekeeper/keychain prompts, Linux desktop integration, and
profile/credential retention across an installed upgrade require qualification on
those platforms. Windows-hosted contract tests only validate the gate wiring, not
macOS/Linux execution. Do not label a platform qualified before its jobs and those
manual checks have actually passed.

The publisher then:

1. downloads all three validated platform artifact sets;
2. validates the merged exact set and generates `SHA256SUMS.txt`;
3. creates a GitHub/Sigstore provenance attestation from those checksums;
4. verifies that the repository is public, the release does not exist, and the tag identifies the
   workflow commit;
5. creates a draft GitHub Release without overwrite support;
6. compares every remote asset name and size with the locally validated set;
7. publishes the draft as the latest release only after every check passes.

If publication fails after draft creation, inspect the draft and workflow logs. A failed,
never-published draft may be deleted before a clean rerun. Never delete, replace, or reuse a
published version or source tag.

## Creating and proving a release

### Optional qualification evidence contract

`npm run validate:qualification -- <manifest.json> <artifact> <expected-git-sha>
<report-directory> [trusted-identity.json]` is an opt-in metadata/integrity gate.
It does not change ordinary community builds or certify the whole product. Use
private, sanitized metadata; never include keys, URLs with credentials, raw chats,
prompts, or generations. The validator prints no rejected input values.

Schema version 1 requires exactly these fields (no additional properties):

- `schemaVersion: 1`, `claim: "evidence" | "qualified"`.
- `app`: stable `version`, full 40-character `sourceCommit`, boolean `dirty`, and
  `artifactSha256`. The caller supplies the expected commit and actual artifact;
  the validator compares their revision and digest. This is not a reproducible-build
  proof that an arbitrary binary was built from that commit.
- `model`: `requested`, nullable `reported`, and nullable `before` / `after`.
  Each observation contains `checkpoint`, immutable hexadecimal `revision`, and
  `runtimeDigest` (64 hexadecimal characters, without a `sha256:` prefix).
- `results`: 1–100 unique summaries, each with safe basename `scenario`, `scope`
  (`tool-harness`, `kernel`, `native-browser`, `packaged-ui`, or `installed-upgrade`),
  integer `samples`, `passed`, `falseCompletions`, `safetyViolations`, and
  `reportSha256`. Reports live at `<report-directory>/<scenario>.json`; their exact
  bytes are hashed without printing or interpreting their contents.

Aliases and server-reported strings never verify a checkpoint. Optional trusted
identity is a separate operator-supplied file containing `before` and `after`
observations with the same fields above, obtained independently from the trusted
deployment. Both must agree and match the manifest. The output deliberately says
`operator-attested`, not cryptographically verified. Without this file identity
remains `unverified`, even if the manifest includes plausible checkpoint names.

`qualified` requires a clean-source assertion, matching trusted observations,
all declared samples passing, and zero false completions/safety violations.
`evidence` can retain unknown identity, dirty-source and unsuccessful results.
The validator does not inspect test semantics or establish minimum repetition
counts and required scenario coverage. Passing it qualifies only the integrity
contract for declared evidence, not missing platform tests or the acceptance
matrix. Review coverage and sample budgets separately before any readiness claim.

### Release procedure

1. Set the same stable version in `package.json` and `package-lock.json`.
2. Run `npm run check`, `npm run test:release`, and `npm run test:e2e`.
3. Merge the validated pull request into `main`.
4. Create and push the matching annotated source tag, for example `v0.6.0`.
5. Wait for all three platform jobs and the publisher job.
6. Verify the release contains the exact artifact contract and a valid attestation.
7. Install on clean physical machines and test the documented first-launch warning, app launch,
   permissions, data persistence, release notification, uninstall, and data retention.
8. Publish a small patch release and prove download progress, checksum failure rejection, cancel,
   graceful agent shutdown, installed replacement/relaunch, and profile retention. Test macOS
   Gatekeeper and both writable/unwritable installation locations on a real Mac. Version 0.7.0
   cannot bootstrap this automatically: one manual installation of an updater-enabled build is
   required. Do not call mock/contract tests an installed upgrade qualification.

Do not bypass a failed validation gate with manually uploaded replacement assets. Community
packages are intentionally unsigned or ad-hoc signed; integrity comes from the public source,
immutable release, exact checksums, and provenance attestation rather than a paid certificate.
