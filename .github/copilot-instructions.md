# SideKick repository instructions

SideKick is a local-first Electron desktop agent for macOS arm64 and Windows x64. Read the
[documentation index](../docs/README.md), then the nearest canonical guide for the area being
changed. Incomplete work belongs in the [roadmap](../docs/roadmap/ROADMAP.md), not in current product
documentation.

## Architecture rules

- Treat the renderer as untrusted. Provider credentials, model streams, commands, file mutations,
  MCP calls, permissions, checkpoint restore, navigation, and updates are owned or authorized by the
  trusted main process.
- Put serializable cross-process contracts in `src/shared`. Expose the narrowest typed preload API;
  do not import Electron or Node runtime modules into shared or renderer code.
- Route agent execution through the canonical main-process runtime. Do not add provider loops, tool
  dispatch, search bridges, or mutation paths in React components.
- Resolve configured provider instances in the main process. Never return decrypted credentials to
  renderer state or add branded provider IPC when the registry/provider runtime can own the work.
- Route workspace writes through the transactional mutation service and canonical path resolver.
  Preserve read receipts, conflict checks, verification, rollback, and permission enforcement.
- Keep platform behavior explicit. macOS uses native traffic lights; Windows uses SideKick caption
  controls. Community artifacts and release-check behavior must match the permanent zero-cost
  release guide.

## Change discipline

- Prefer one final architecture over compatibility shims or parallel implementations. Remove an
  obsolete path when its replacement is complete and migrations are not part of the product
  contract.
- Preserve user data and unrelated work. Add deterministic regression coverage for defects and
  adversarial coverage for security-sensitive boundaries.
- Use authoritative upstream documentation for protocol details. Record material reference-repo
  influence according to [Reference repositories](../docs/development/REFERENCES.md).
- Run focused tests while developing and `npm run check` before merging.

## Documentation rules

- Current user behavior belongs in `docs/user-guide`; runtime design belongs in
  `docs/architecture`; contributor and release procedures belong in `docs/development`; unshipped
  work belongs only in `docs/roadmap`.
- Maintain one canonical source for each fact and link to it instead of copying content.
- Do not commit raw conversations, append-only decision logs, copied vendor API manuals, generated
  evaluation reports, credentials, private prompts, personal data, account settings,
  machine-specific paths, or private endpoints.
- Update `docs/README.md` when a guide moves, appears, or is removed. Run `npm run docs:check` for
  documentation changes.

Security reports follow [SECURITY.md](../SECURITY.md). Never move a suspected vulnerability into a
public issue or repository document before coordinated disclosure.
