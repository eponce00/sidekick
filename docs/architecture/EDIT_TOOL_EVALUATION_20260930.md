# File-editing reliability evaluation

Date: 2026-09-30. Follows the [2026-09-05 patch-tool diagnosis](PATCH_TOOL_EVALUATION_20260905.md).

## Why

A local Qwen-class model rejected 101 of 275 `apply_patch` calls (37%) in real SideKick use. The
largest causes were a missing `*** Begin Patch` line, a `patch_bytes` argument copied from replayed
history, context that differed from the file only in typography or whitespace, absolute paths, and
repeated sections for one file. Two of these were SideKick defects: tool sessions never received
the model's editing dialect, so every model got `apply_patch`; and follow-up turns replayed edit
calls with byte counts in place of their text, which models imitated.

## Method

`src/main/evals/editReliability.live.test.ts` runs the production kernel, tools and system prompt
against a locally served Qwen-class model (server-default temperature and thinking). Eleven tasks
edit copies of real project files: a 238-line Markdown report with 317 curly quotes and 57 em
dashes plus its 413-line HTML page, a 3,400-line CRLF HTML/JavaScript page, a 1,600-line
TypeScript module, a 770-line CRLF Python module, and a Markdown file with one CRLF line among LF
lines. Tasks include table cells, the same sentence in Markdown and HTML, a new file plus a link,
an eight-site rename, a line repeated four times, an indentation-sensitive insertion, and a second
turn rebuilt from durable history. A run passes only when every file matches the expected bytes.
Each arm ran five times per task (55 runs).

## Results

| Arm                                            | Passed | Edits rejected | Requests per task | Prompt tokens per task |
| ---------------------------------------------- | -----: | -------------: | ----------------: | ---------------------: |
| Before: `apply_patch` only                     |    78% |            52% |               9.6 |                194,600 |
| Before: `edit`/`write`                         |    93% |            14% |               8.1 |                146,400 |
| After: `apply_patch`                           |    96% |            42% |               9.0 |                191,400 |
| After: `edit`/`write` (what Qwen now receives) |    95% |             8% |               7.6 |                139,200 |

Before versus after for this model: pass rate p = 0.024 and rejected-edit rate p < 0.0001
(two-sided Fisher exact). The three byte mismatches left in the last arm placed the requested
change correctly but wrapped the long line as a formatter would. The mixed-line-ending task failed
5/5 before because a patch rewrote every LF line as CRLF; it passed 5/5 after in both dialects. No
rejected call changed a file in any arm. Replaying the 18 baseline patch rejections through the new
matcher accepted 10, each producing exactly the expected file; the other 8 were malformed (lines
from two files in one hunk, partial-line context, a misused end-of-file anchor) and are still
rejected, now with the closest current lines or the real location in the error.

The two-turn task did not reproduce the `patch_bytes` imitation, which appeared in longer real
conversations; that fix is covered by regression tests rather than this run.

## Reproduction

The evaluation is opt-in. Point `SIDEKICK_EDIT_EVAL_FIXTURES` at a directory holding
`scenarios.json` (name, project, prompts, expected file contents) and `fixtures/<project>/`, then set
`SIDEKICK_EDIT_EVAL_RUN=1`, `SIDEKICK_AGENT_EVAL_URL`, `SIDEKICK_AGENT_EVAL_MODEL`,
`SIDEKICK_AGENT_EVAL_API_KEY`, `SIDEKICK_EDIT_EVAL_DIALECT` (`apply-patch` or `structured-edit`),
`SIDEKICK_EDIT_EVAL_N` and `SIDEKICK_EDIT_EVAL_REPORT`, and run
`npm test -- src/main/evals/editReliability.live.test.ts`. Fixtures and reports stay outside the
repository.
