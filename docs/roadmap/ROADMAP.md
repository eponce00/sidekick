# Roadmap

SideKick `0.4.2` is in active development. The current codebase includes the local-first desktop
runtime, provider connections, agent tools, projects, permissions, plan mode, persistent goals,
research, two-agent project collaboration, private workspace History, packaging, and a guarded
public-release notification path. Release availability is tracked on the canonical
[GitHub Releases page](https://github.com/eponce00/sidekick/releases).

This file contains incomplete work only. Shipped behavior belongs in the user and architecture
guides, and completed items are recorded in the [changelog](../../CHANGELOG.md) and Git history.

## Release readiness

- Run the community package matrix on clean physical macOS arm64 and Windows x64 machines,
  including the honest first-launch warnings, permissions, persistence, release notification,
  uninstall, and data retention.
- Package the Windows app as MSIX and qualify the free Microsoft Store signing/update route after a
  maintainer completes Microsoft's free identity verification and reserves the product identity.
- Add a Linux x64 AppImage job with packaged-runtime validation, a headless launch smoke, artifact
  provenance, and clean Ubuntu installation/uninstallation qualification before including Linux in
  the public release contract.
- Publish the matching stable source tag only after `npm run check` and every release gate passes.

The exact release contract is in [Releases](../development/RELEASES.md).

## Near-term product work

- Live-qualify the official OAuth MCP catalog against production vendor accounts and expand it only
  when an official endpoint, narrow consent flow, revocation path, and auditable action boundary are
  verified end to end.
- Improve long-running command ergonomics with interactive terminal sessions that preserve the
  current command permission and project-containment boundaries.
- Add controlled extension points only after their provenance, permissions, updates, and failure
  isolation can be enforced as one architecture rather than ad hoc scripts.
- Refine curated project memory with explicit sources, review, deletion, and prompt-budget controls.
- Continue adversarial testing of provider dialect recovery, project symlinks, collaboration
  conflicts, prompt injection, release validation, and crash recovery.

## Later work

- Optional operating-system isolation for high-risk command workloads.
- Additional desktop targets only when they have a sustainable zero-cost release and update path.
- Android after the prerequisites in the [mobile roadmap](ANDROID.md) are satisfied.
- iPhone and iPad through the installable-web-app path in the [iOS roadmap](IOS.md).

SSH/SFTP management and a general-purpose secrets vault are intentionally out of scope until their
trust, auditing, and recovery models can meet the desktop runtime's existing guarantees.
