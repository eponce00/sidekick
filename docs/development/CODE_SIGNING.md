# Code signing policy

Free code signing for SideKick's Windows installer is provided by
[SignPath.io](https://about.signpath.io/), with a certificate by
[SignPath Foundation](https://signpath.org/).

**Status:** SideKick has applied to SignPath Foundation. Until signing is active, the Windows
installer is unsigned, and each release's notes say which applies. The
[release guide](RELEASES.md) covers the macOS and Linux packages.

## What is signed

Only the Windows installer, `SideKick-<version>-windows-x64-setup.exe`, built by this repository's
[release workflow](../../.github/workflows/release.yml) from a version tag on `main`. Nothing built
on a personal machine, and no binary from another project, is submitted for signing. Upstream
components the installer contains, such as the Electron runtime and Node native modules, keep
their own publishers' signatures or none.

## Team roles

| Role      | Members                                      | Responsibility                                                      |
| --------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Committer | [Ernesto Ponce](https://github.com/eponce00) | Changes the source directly                                         |
| Reviewer  | [Ernesto Ponce](https://github.com/eponce00) | Reviews every pull request from someone who is not a committer      |
| Approver  | [Ernesto Ponce](https://github.com/eponce00) | Approves each signing request in SignPath, after its release passes |

Every team member uses multi-factor authentication for GitHub and SignPath.

## How a release is signed

1. A version tag starts the [release workflow](../../.github/workflows/release.yml). It builds the
   installer on a GitHub-hosted runner and runs the full test, packaging, and smoke gates.
2. Once those gates have passed on every platform, the workflow submits the unsigned installer to
   SignPath through its GitHub Action. SignPath checks that the artifact came from this
   repository's workflow.
3. An approver approves the request. The workflow verifies that the signed installer carries a
   valid SignPath Foundation signature, then publishes it with the other packages, their
   `SHA256SUMS.txt`, and a provenance attestation.

## What SideKick does on your computer

SideKick is a desktop agent: on your instruction it runs commands, changes files in projects you
open, and drives its own browser. Each action follows the approval mode you choose, and the
[permission policy](../user-guide/PERMISSIONS.md) describes what each mode allows. SideKick does not
scan for or exploit vulnerabilities, and does not work around operating-system security controls.
It updates itself only from verified releases of this repository, after you choose **Restart and
update**. The uninstaller removes the application; the [privacy policy](../../PRIVACY.md) explains
how to remove its data.

## Privacy

SideKick sends nothing to a server run by the project. The [privacy policy](../../PRIVACY.md) lists
every service it contacts and how to turn off the ones you did not choose, and the installer shows a
summary before installing.
