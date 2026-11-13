# Dependencies

SideKick runs other people's code: about a thousand npm packages, the Electron runtime, the actions
its workflows call, and a few downloaded binaries. This guide is how that code is kept current and
kept from becoming a way in. Most of it runs by itself. What is left for a person is a pull request
to merge each week and an issue to work through each month.

Report a vulnerability in SideKick itself through [SECURITY.md](../../SECURITY.md), not here.

## What is covered

| What                                  | Where it is declared                               | Who watches it                         |
| ------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| The app and its build tools           | `package.json`, `package-lock.json`                | Dependabot, CI                         |
| The README animation tooling          | `media/package.json`, `media/package-lock.json`    | Dependabot, CI                         |
| Python used by scripts and one CI job | `scripts/requirements-*.txt`                       | Dependabot, for security fixes only    |
| Workflow actions                      | `.github/workflows`, `.github/actions`             | Dependabot, a test                     |
| Electron and Node.js                  | `package.json`, `.node-version`                    | The monthly review                     |
| Downloaded binaries and models        | The script that fetches each, with its pinned hash | The monthly review. Nothing automatic. |

## The defenses

Each one stops a different kind of failure, so none of them is optional.

- **The lockfile is what gets installed.** CI and releases run `npm ci`, which installs exactly the
  versions and content hashes in `package-lock.json` and fails if `package.json` disagrees. A
  dependency never changes without a commit that shows it.
- **Install scripts run only when approved.** A package's install script runs with a contributor's
  or a runner's full access, and is how most hijacked packages do their damage. `allowScripts` in
  `package.json` names the exact versions allowed to run one. CI sets `strict-allow-scripts`, so a
  script that is not on the list fails the install instead of running.
- **A release waits a week before SideKick takes it.** Hijacked releases are usually found and
  removed within days. Dependabot's `cooldown` holds every version update for seven days, and a
  person updating by hand passes `--min-release-age=7`. Security fixes skip the wait.
- **Workflow actions are pinned to a commit.** A tag can be moved to different code after it was
  reviewed. A commit cannot. A test in `scripts/ci-dependencies.test.cjs` fails on any action named
  by tag, and the repository's Actions settings refuse to run one.
- **Packages are checked against the registry's signature.** `npm audit signatures` in CI fails
  when an installed package is not the one the registry signed.
- **Known vulnerabilities stop a merge.** On a pull request, the dependency review refuses a
  dependency that is added or updated to a version with a known vulnerability of moderate severity
  or higher. On every run, `npm audit` fails on a high or critical vulnerability in anything that
  ships in the app or in the media tooling.
- **GitHub watches the rest.** Dependabot alerts, Dependabot security updates, CodeQL code
  scanning, secret scanning with push protection, and private vulnerability reporting are all
  turned on for the repository. CodeQL runs GitHub's default setup on every pull request and each
  week; its alerts are handled like a Dependabot alert.

Dependabot does this work, rather than a separate service, because it is part of GitHub: there is
no other application to give write access to the repository, and nothing to pay for.

## What happens by itself

| When                     | What                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| An advisory is published | Dependabot raises an alert and, when a fixed version exists, opens a pull request with it.                                                  |
| Every Monday             | Dependabot opens up to three pull requests: what ships in the app, the build tools, and the actions.                                        |
| The first of the month   | Dependabot opens one pull request for the media tooling, and the Dependency review workflow opens an issue named Monthly dependency review. |
| Every pull request       | The checks under [The defenses](#the-defenses) run.                                                                                         |

The schedule and grouping are in [`.github/dependabot.yml`](../../.github/dependabot.yml). Minor
and patch versions are grouped, so a week is one pull request and not thirty. Major versions are
left out of the weekly updates on purpose: they need a decision, and the monthly issue lists them.

## What a person does

### Each week: merge the update pull requests

1. Wait for CI. The whole suite, the packaged builds and the end-to-end journey run on every one.
2. For the pull request that changes what ships in the app, read the release notes Dependabot
   includes for anything that changes behavior.
3. Squash-merge it when CI passes.

When CI fails:

- **The install fails on an install script.** A package that runs one changed version, so its
  entry in `allowScripts` no longer matches. Check out the branch, read what the new version's
  script does, then run `npm approve-scripts` and commit the change to `package.json`.
- **One update breaks something.** Comment `@dependabot ignore <package> minor version` on the pull
  request to take it out of the group, and open an issue for it. The rest can then merge.
- **The branch is stale.** Comment `@dependabot recreate`.
- **Electron's pull request fails the runtime test.** Each Electron release embeds its own Node.js,
  and `.node-version` has to name that exact version. The failing test prints it. Push a commit to
  the pull request's branch that changes `.node-version` to match.

### When an alert arrives: decide how fast

| The vulnerable code                                | What to do                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| Ships in the app, high or critical                 | Merge the fix and publish a release as soon as CI passes.            |
| Ships in the app, moderate or low                  | Merge the fix. It goes out with the next release.                    |
| Only builds or tests the app                       | Merge the fix with that week's updates.                              |
| Has no fixed version that SideKick can install yet | Leave the alert open. The monthly issue lists it until a fix exists. |

`npm audit --omit=dev` shows what ships in the app; plain `npm audit` adds the build tools.

When the fix is in a package that another package depends on, and that package has not taken it
yet, pin the fixed version under `overrides` in `package.json`. An override is a patch on someone
else's dependency list, so remove it once the package in between has caught up.

Dismiss an alert only when SideKick does not use the vulnerable code at all, and say so in the
dismissal.

### Each month: work through the review issue

The issue is written by `scripts/dependency-report.cjs`. Run `npm run deps:report` to see it at any
time.

1. **Known vulnerabilities.** For each one still listed, check whether a fix has appeared, and
   apply the table above.
2. **Major versions waiting.** Choose which to take, and upgrade each in its own pull request so a
   failure points at one package.
3. **Electron.** Electron fixes security issues only in its latest three major versions, and the
   report says how long the current one has left. Never release on a version that has run out.
   `.node-version` has to move with it, to the Node.js that the new Electron embeds.
4. **Overrides.** For each entry under `overrides`, check whether the package that needed it now
   depends on the fixed version by itself, and remove the entry if so.
5. **Downloaded binaries and models.** Nothing watches these. Check the release page named in each
   fetch script, starting with `scripts/fetch-computer-driver.cjs`, and update the version and
   hashes together.
6. Close the issue.

## Changing a dependency by hand

Before adding one, check that it is still maintained, that its licence can be combined with
GPL-3.0-or-later, and whether it runs an install script. A few lines of code are often cheaper
than a dependency that has to be watched from then on.

```bash
# Add or update, taking nothing published in the last week.
npm install <package> --min-release-age=7
npm update <package> --min-release-age=7

# Change only the lockfile, without touching node_modules.
npm install --package-lock-only --ignore-scripts --min-release-age=7

# Review and approve a package's install script.
npm approve-scripts
```

- A security fix that is less than a week old needs `--min-release-age=0`. Say so in the pull
  request.
- Pin an exact version for anything that runs an install script or is built natively, as
  `better-sqlite3` and `node-pty` are.
- The media tooling has its own lockfile. Run the same commands inside `media`.
- To update an action by hand, change the commit and the version comment after it together.

The week's wait is passed on the command line and not set in an `.npmrc` for two reasons. The
repository ignores `.npmrc`, because that file is also where registry credentials are kept. And a
repository-wide setting has been reported to stop Dependabot from opening pull requests for
security fixes that are only days old.

Do not:

- run `npm audit fix --force`, which takes breaking major versions without review;
- pass `--dangerously-allow-all-scripts` to get past a failed install;
- depend on a git URL or a tarball URL, which have no registry signature and no advisories;
- commit an `.npmrc`.

## References

- [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [Dependabot comment commands](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands)
- [npm approve-scripts](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/)
- [Electron's supported versions](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
