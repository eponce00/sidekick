# Local-model patch-tool evaluation

Date: 2026-09-05. Diagnosis only; no production parser, prompt, server, or installed-app changes.

## Setup and scope

- Live profile `27b`: Qwen3.6-27B AutoRound INT4, vLLM 0.26.0, TP2 on two RTX 3090s.
- Authenticated public LiteLLM endpoint `https://llm.midecasa.com/v1`, model `local-loaded-model`.
- Native MTP3, 262,144 context, prefix cache enabled. No model switch or server restart.
- Temperature 0.6, 2,048 output-token allowance per request, at most ten tool rounds.
  No reasoning override; the loaded profile defaults thinking off.
- Current production streaming parser, tool schemas, `AgentToolRegistry`, `AgentToolRuntime`,
  read receipts and workspace mutation service. Only `read` and `apply_patch` were exposed.
- Fresh synthetic temporary project per trial. Every final file was compared byte-for-byte,
  including unchanged files, Unicode and CRLF. Every rejected call was checked for non-mutation.
- This isolates editing tools, not the complete AgentRunKernel, UI, completion guards, parallel
  scheduling or long-context behavior. Five trials per scenario are diagnostic, not a general
  coding benchmark. Tools were selected automatically, not forced.

## Results

Success means the exact requested on-disk result and a terminated model turn within the round limit.

| Scenario                                    | Current feedback | Extra syntax example in error feedback |
| ------------------------------------------- | ---------------: | -------------------------------------: |
| Unicode path/content and CRLF               |              3/5 |                             Not tested |
| Edit only the second repeated code block    |              5/5 |                             Not tested |
| Atomic move/update, delete and add          |              0/5 |                                    3/5 |
| Preserve an external edit after reading     |              5/5 |                             Not tested |
| Recover from an injected ambiguous hunk     |              5/5 |                             Not tested |
| Recover from an injected unified-diff patch |              0/5 |                                    5/5 |

Baseline: **18/30**. The difficult subset improved from **0/10 to 8/10** with test-only grammar
guidance. This was sequential, stochastic sampling, not a randomized or statistically powered A/B.
The intervention did not change the patch parser or weaken exact matching/read receipts.

The baseline made 179 model requests and 190 tool calls, including injected controls. Mean
request latency was 1,703.5 ms; mean tool execution time was 3.4 ms. Thus retries/model turns,
not patch application CPU time, dominated this small-file workload. These are not decode tok/s
or full-app TTFT measurements. Grammar recovery averaged 17.09 seconds before and 2.51 seconds
with guidance; the former exhausted its retries, while all guided grammar trials succeeded.

All 123 baseline rejected calls left files unchanged. The guidance run also had no rejected-call
mutations. The existing mutation/runtime safety suite passed 26 tests, including rollback,
stale receipts, symlink boundaries and line-ending preservation.

## Findings

1. **Model/contract mismatch:** Qwen repeatedly emits unified-diff hunk headers such as
   `@@ -1 +1 @@`. SideKick expects a bare `@@` or an optional source marker without closing `@@`.
   Its generic errors cause the model to guess alternative invalid headers.
2. **Move syntax feedback:** the model puts `*** Move to` after the hunk instead of immediately
   after `*** Update File`. Subsequent attempts add unwanted spaces after `-`/`+`, making exact
   source matching fail. Report the misplaced header directly instead of only “invalid hunk.”
3. **Missing-file classification:** attempting to inspect the future README before adding it
   produces `internal`/ENOENT. A missing file should be an intelligible `not_found` result with
   guidance to use Add File when creation was requested, not a generic internal failure.
4. **No-edit responses:** the two unsuccessful Unicode/CRLF trials returned without editing;
   their original bytes remained intact. These results do not demonstrate CRLF corruption.
5. **Parser correctness:** `parseCanonicalPatch` discards `*** End of File`; the updater does not
   enforce the end-of-file constraint. An in-memory probe targeting `target` in `target\nother\n`
   with that marker produced `changed\nother\n` rather than rejecting the non-final match.
6. **Old evaluation drift:** `agentHarness.live.test.ts` still selects legacy dialects and expects
   `edit` and model-owned `accessLevel` arguments, whereas the current model-facing tool set is
   canonical `apply_patch`. That suite must be migrated before its editing scores are trusted.

Recommended implementation: syntax-specific error codes and concise working examples, explicit
move-header/whitespace diagnostics, useful missing-file errors, and proper EOF enforcement with
regression tests. Keep atomic commit, path boundaries, strict ambiguity rejection and stale-read
checks. Do not substitute speculative fuzzy matching for fixing the contract.

## Reproduction

The opt-in test is `src/main/evals/patchTools.live.test.ts`; it skips ordinary CI runs unless enabled.
It never loads real conversations or gives the model a real project to edit.

```powershell
$env:SIDEKICK_AGENT_EVAL_API_KEY = [Environment]::GetEnvironmentVariable('LOCAL_LLM_API_KEY', 'User')
$env:SIDEKICK_AGENT_EVAL_URL = 'https://llm.midecasa.com/v1'
$env:SIDEKICK_PATCH_EVAL_RUN = '1'
$env:SIDEKICK_PATCH_EVAL_N = '5'
$env:SIDEKICK_PATCH_EVAL_REPORT = 'reports/patch-eval-baseline.json'
npm run test -- src/main/evals/patchTools.live.test.ts

$env:SIDEKICK_PATCH_EVAL_GUIDANCE = '1'
$env:SIDEKICK_PATCH_EVAL_REPORT = 'reports/patch-eval-guidance.json'
npm run test -- src/main/evals/patchTools.live.test.ts -t 'grammar-recovery|multi-file'
```

The diagnostic guidance only appends a generic valid patch example to rejected patch results.
It does not supply expected answers. Opt-in tests exit nonzero when a model trial fails; that is
an evaluation result, not evidence of a server crash.

Raw synthetic reports remain local and ignored:
`reports/patch-eval-20260905-registry.json` and `reports/patch-eval-20260905-guidance.json`.
An earlier pilot (`reports/patch-eval-20260905.json`) bypassed the registry's exception handling
and is excluded from the reported scores. The corrected runner also merges streamed tool-call
updates by index and accepts safe rereading that avoids a stale-read error entirely.

Final backend health passed; running/waiting requests were zero and GPUs were 53/43 C at 0%
utilization. No recent Xid was returned by the kernel-log check. Temporary test projects were
removed; the server, installed SideKick and existing user files were left unchanged.
