# Android roadmap

Android support is deferred. There is no Android application, runtime, dependency graph, build, or
release target in the repository today. This document describes constraints for a future product;
it is not a promise that desktop capabilities work on a phone.

## Product direction

The intended mobile product is a standalone, local-first SideKick client, not an unrestricted remote
shell for a desktop. It should share serializable contracts and product concepts where they fit,
while using Android-native security, storage, lifecycle, background-work, and interaction models.

Likely portable capabilities include provider configuration, ordinary chat, durable conversations,
research, plans, goals, todos, projects backed by explicitly selected storage, MCP connections, and
permission/audit views. Desktop assumptions such as arbitrary shell execution, native Node modules,
unrestricted filesystem paths, desktop language servers, Electron IPC, code signing, and the current
updater cannot be carried over unchanged.

## Required architecture

- A platform-neutral shared contract layer with versioned serialization tests.
- An Android-native trusted runtime and encrypted credential store; no WebView bridge with ambient
  filesystem, token, or command authority.
- Storage Access Framework integration that grants access only to user-selected documents or trees
  and survives process recreation honestly.
- Lifecycle-safe streaming, cancellation, durable interactions, and bounded background work.
- A mobile-specific capability catalog and permission policy. Unsupported desktop tools must be
  absent, not emulated through hidden remote execution.
- A project-owned signing key, reproducible release build, rollback/migration policy, and a
  sustainable zero-cost F-Droid or direct-APK release channel defined before user data is created.

## Permanent zero-cost distribution constraint

SideKick will not pay for Google Play registration, Android developer verification, commercial
signing, or another distribution service. The preferred public channel is F-Droid because it is a
free-software repository with reproducible-build support and its own update client. A direct,
project-signed APK published with checksums and provenance remains the fallback.

Android's distribution rules are changing. Google's full-distribution verification has a one-time
fee, while the free limited-distribution account is capped at 20 authorized devices. Unregistered
apps can require users to enable an advanced installation flow, and regional enforcement begins in
2026 before broader rollout. An alternative store may be able to register apps on a developer's
behalf, but SideKick must prove the exact F-Droid path under the enforced rules before promising
frictionless installation.

References:

- [Android developer verification](https://developer.android.com/developer-verification/guides)
- [Android developer-verification FAQ](https://developer.android.com/developer-verification/guides/faq)
- [Limited distribution](https://developer.android.com/developer-verification/guides/limited-distribution)
- [F-Droid inclusion policy](https://f-droid.org/docs/Inclusion_Policy/)

## Entry criteria

Work should not start until the desktop release path is proven, shared contracts can be extracted
without weakening the Electron trust boundary, the mobile provider/network threat model is written,
and a minimal capability matrix is agreed. The first milestone should prove encrypted provider
configuration, one durable conversation, cancellation/recovery, and a strictly scoped document
picker on real hardware before broader feature parity is considered.

Mobile work must have its own automated tests, dependency audit, privacy review, project signing-key
custody, and physical-device release checklist. It should not add compatibility branches to the
desktop runtime merely to make a prototype compile.
