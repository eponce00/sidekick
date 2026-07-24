# Security policy

SideKick runs model-directed tools against local projects, so security reports are handled privately
and the renderer is not treated as a trusted authority.

## Supported versions

Before the first stable installer is published, only the current `main` branch receives security
fixes. After releases begin, the latest stable release and `main` will be supported. Older versions
may be asked to update before a fix is evaluated.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/eponce00/sidekick/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include the affected version or commit, operating system, impact, prerequisites, and the smallest
safe reproduction. Redact model-provider keys, tokens, prompts, personal files, local paths, and
account data. If an exploit touches a third-party service, do not access data or accounts you do not
own and do not perform availability testing.

You should receive an acknowledgement through the advisory within seven days. Validation,
remediation, disclosure timing, and credit will be coordinated in that private thread. Please allow
time for a signed release before public disclosure when users need an update.

## Security boundaries

- The Electron renderer is untrusted. Sensitive settings, provider credentials, file mutations,
  commands, MCP calls, navigation, and update decisions are validated in the main process.
- Project paths are canonicalized and checked against the active project. Workspace mutations are
  previewed, serialized, verified, and rolled back on failure.
- Credentials are stored through the operating system's protected storage and are never exposed to
  the renderer as plaintext.
- Model output, web content, project instructions, and MCP responses remain untrusted input. A
  permission prompt is an authorization boundary, not evidence that content is safe.
- Production updates are accepted only through the signed, versioned release path described in the
  [release guide](docs/development/RELEASES.md).

See the [architecture](docs/architecture/OVERVIEW.md) and
[permission policy](docs/user-guide/PERMISSIONS.md) for the complete trust and authorization model.
The [privacy disclosure](PRIVACY.md) documents local retention and external data flows.
