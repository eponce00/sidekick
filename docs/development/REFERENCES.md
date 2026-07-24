# Reference repositories

SideKick studies mature agent and desktop implementations to compare interaction patterns,
security boundaries, provider protocols, and release practices. Reference repositories are
research inputs, not runtime dependencies or vendored source.

## Catalog

| Project      | Repository                                                                | Primary research areas                                     |
| ------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Codex        | [openai/codex](https://github.com/openai/codex)                           | agent loop, approvals, configuration, project instructions |
| OpenCode     | [anomalyco/opencode](https://github.com/anomalyco/opencode)               | sessions, tools, provider abstraction, desktop UX          |
| Cline        | [cline/cline](https://github.com/cline/cline)                             | Plan/Act UX, MCP, checkpoints, provider settings           |
| Pi           | [badlogic/pi-mono](https://github.com/badlogic/pi-mono)                   | compact agent loop, tool filtering, extensions             |
| Hermes Agent | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | skills, memory, tool orchestration                         |
| Claude Code  | [anthropics/claude-code](https://github.com/anthropics/claude-code)       | command UX, hooks, permissions, project configuration      |
| Grok Build   | [xai-org/grok-build](https://github.com/xai-org/grok-build)               | planning transitions and review interaction                |

The catalog must contain only public sources with licenses compatible with the intended use. A
useful idea does not by itself authorize copying its implementation.

## Local synchronization

Keep checkouts outside this repository. Set `SIDEKICK_REFERENCE_ROOT` to the directory that should
contain them and run:

```bash
SIDEKICK_REFERENCE_ROOT=/path/to/reference-checkouts ./scripts/sync-reference-repos.sh
```

The script clones missing repositories and fast-forwards existing clean checkouts. It should not
be used to make local reference trees part of SideKick's Git history or package contents.

## Research and attribution policy

When a reference materially influences a design:

1. Record the upstream repository and exact commit in the relevant change or pull request.
2. Identify whether the result is an independently implemented idea, an API compatibility need, or
   copied/adapted code.
3. For copied or adapted material, verify the exact upstream license and retain all required notices
   before committing it.
4. Add a concise reference to the canonical SideKick guide only when it helps future maintainers
   understand a non-obvious decision.
5. Revalidate claims against the current upstream commit before presenting them as current behavior.

Do not publish local checkout paths, raw browsing logs, conversation transcripts, proprietary
sources, private repository contents, or speculative claims about another product. Link to upstream
documentation instead of copying complete API references into SideKick.
