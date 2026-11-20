---
name: upstream-merge
description: >
  Fork-maintainer workflow for syncing https://github.com/nicobailon/pi-mcp-adapter
  into njuptlzf/mcp-adapter. Two-step git flow: merge `upstream/main` into the
  fork's `main` first (decision tree applies here), then propagate fork's
  `main` into the working branch — skipped if already on `main`. Reads
  `skills/upstream-merge/references/special-cases.md` for hand-curated special
  cases AND runs `scripts/upstream-divergence.ts` for live cross-check against
  `git diff upstream/main --name-status`; falls back to the 12-category per-file
  default-resolution matrix (inlined in §4.2) for files not in the registry.
  Applies ours/theirs/manual decisions per a 4-section decision tree. Triggers
  the 5-step follow-up issue flow when Pi-coupling is re-introduced. Use when
  user says "merge upstream", "sync fork", "upstream conflict",
  "resolve upstream merge", or "/upstream-merge".
---

# Upstream Merge (fork-maintainer)

Drives the `njuptlzf/mcp-adapter` fork through a deterministic merge of
upstream `nicobailon/pi-mcp-adapter` changes. The flow has two layers:

- **§1 Two-step git branch flow** — the order of merges across branches.
  Read this first to know where the decision tree runs.
- **§2–§5 Per-file decision tree** — invoked within Step 1 of the branch
  flow. Look up the file, apply the decision, verify.

## 1. Two-step git merge flow

The fork has two long-lived branches that the upstream merge must handle
separately:

| Branch | Role | Notes |
|---|---|---|
| `main` (fork's main) | **Upstream change buffer** | The decision tree in §4 runs here. Long-lived but rarely committed to directly. |
| `<working-branch>` (e.g., `v1.0`) | Active fork development | Long-diverged from `main` (e.g., 227 commits ahead in this fork). |

**The merge is a deterministic two-step process:**

0. **Create a feature branch from `main`** — `git checkout main && git checkout -b
   upstream-merge/<upstream-version>`. **Never commit directly to `main`**
   (enforced by `.githooks/pre-push` and the `no-direct-main-push` advisory CI —
   see AGENTS.md "Branch Policy (HARD RULE)"). All Step 1 work happens on
   this branch. The branch name MUST follow `upstream-merge/<upstream-version>`
   (e.g., `upstream-merge/v2.10.0`) so the §5.5 PR template can auto-extract
   the version.
1. **Fetch upstream** — `git fetch upstream` (GnuTLS workaround per the §2
   note if needed).
2. **Run pre-flight** — `npm run upstream:check` (§3) to see live divergence.
3. **Step 1: `upstream/main` → `<feature-branch>`** — `git merge upstream/main`.
   Resolve conflicts using the decision tree (§4). The merge commit lands on
   the **feature branch, NOT on `main`**.
4. **§5.5 PR flow** — push the feature branch → open PR → wait for CI → merge
   → delete branch (per the §5.5 sub-flow at the end of this skill).
5. **Step 2: `<feature-branch>` → `<working-branch>`** (post-PR-merge) — `git
   checkout <working-branch> && git merge main`. Generally a fast-forward or
   small diff because the working branch is already ahead of `main` with
   fork-specific work. The merge is now from main (the merged PR) to the
   working branch.
6. **Short-circuit** — if `<working-branch> == main` and the §5.5 PR has
   already merged to main, skip step 5. The flow ends at step 4.

**Anti-pattern (do not):** Running `git merge upstream/main` directly on
`<working-branch>`. This creates a large blast radius of conflicts between
the long-diverged working branch and upstream — the working branch has
hundreds of commits the upstream never saw. The two-step flow exists to
confine the conflict surface to the smaller `main` branch.

**Anti-pattern (do not):** Committing the merge directly to `main` (even if
`pre-push` hook is somehow disabled). This bypasses the §5.5 PR flow, which
means no `pr-divergence-check` CI, no review checkpoint, no squash-merge
cleanup. The hook exists for a reason; respect it.

## 2. When to invoke

The decision tree (§4) is invoked within Step 1 of the two-step flow, at
any of three points:

- **(a) Pre-flight**, after `git fetch upstream` and before `git merge
  upstream/main`. Run `npm run upstream:check` (§3) to surface live
  divergence, then walk the per-file decision tree before any conflict
  appears.
- **(b) In-flight**, after `git pull upstream main` produces a merge
  conflict. Look up each conflicting file's `Default Resolution` in the
  manifest, and apply the decision (run the §4.1 grep for `assess` rows
  first).
- **(c) Targeted cherry-pick**, before `git cherry-pick <upstream-sha>`.
  Same flow as (b), scoped to the files touched by the cherry-picked
  commit.

After Step 1's merge commit lands and passes the §5 Checklist, run Step 2
(`git merge main` on the working branch) to propagate upstream changes.
If on `main` already, the flow ends at Step 1.

> **GnuTLS workaround:** If `git fetch upstream` fails with GnuTLS / SSL
> errors in this environment, use `GIT_SSL_NO_VERIFY=1 git -c
> http.sslVerify=false fetch upstream --tags` (verbatim from
> `08-LEARNINGS.md` L-4).
>
> **Proxy workaround (Windows sandboxes, 2026-11-20):** If fetch fails with
> `CONNECT tunnel failed, response 502` even though `https_proxy` is set in the
> environment, Git Bash does not always honour the env vars. Set the proxy
> explicitly: `git config --global http.proxy http://127.0.0.1:60105` (and
> `https.proxy` the same; use the actual local proxy port). Direct connections
> fail in these sandboxes — do not bother unsetting the proxy. The
> `upstream:check` script shells out to `git fetch` internally, so this must be
> configured before running the pre-flight check or it exits 2.

## 3. Read the special-cases registry and run the divergence check

Two inputs are required before any merge decision: (1) read `references/special-cases.md` for the 15-17 hand-curated cases (Phase 8 manifest footnotes + expansion), and (2) run `npm run upstream:check` to see live divergence against `upstream/main`. The script replaces the Phase 8 "manifest freshness" check: instead of comparing manifest row counts to `git diff` output, it classifies each diverged file as `registered` / `diverged-but-not-registered` / `stale` against the registry.

> **Run the pre-flight check BEFORE `git merge`, not after (2026-11-20):** once the merge is in progress, `package.json` may carry conflict markers, and EVERY Node tool launched in the repo (`npx tsx`, `npm run upstream:check`, `tsc`, `vitest`) fails at startup with `ERR_INVALID_PACKAGE_CONFIG` (surfaced by `npx` as the misleading "Could not determine Node.js install directory"). If you hit that error, it almost always means an unresolved `package.json` conflict — resolve/stage it first (§3.5), then re-run. The §3 pre-flight should be done on a clean tree; the §5(e) re-run happens only after all conflicts are cleared.

**How to look up a file in the registry:**

```bash
# By file path (quote the path with backticks to match the table cell)
grep -F '`init.ts`' skills/upstream-merge/references/special-cases.md

# By status (returns all rows in that bucket)
grep -E '^\| `.*` \| (fork-only|decoupled-wrapper|deleted-in-fork|sibling-config|framing-divergence)' skills/upstream-merge/references/special-cases.md
```

**Run the divergence check** (script replaces the Phase 8 `git diff ... | wc -l` + `grep -cE '^\| `'` sanity check):

```bash
# Default: ANSI color when stdout is a tty
npm run upstream:check

# Grep-friendly output (no escape sequences, suitable for piping / CI logs)
npx tsx scripts/upstream-divergence.ts --no-color
```

**Interpreting the script output:**

- **Exit 0** — no stale entries. The `diverged-but-not-registered` count is a warning (per D-34: treated as `assess` by the 12-category matrix in §4.2); proceed with the merge.
- **Exit 1** — stale entries present (registry lists a file that is no longer in `git diff upstream/main --name-status`). STOP and clean stale registry entries before merging.
- **Exit 2** — fatal: `git fetch upstream` failed AND the GnuTLS workaround also failed, OR the registry parse produced 0 entries. Investigate before proceeding (the GnuTLS workaround per L-4 is `GIT_SSL_NO_VERIFY=1 git -c http.sslVerify=false fetch upstream --tags`; the script retries with it automatically).

Files NOT in the registry are resolved by the 12-category per-file default-resolution matrix inlined in §4.2 below — no need to add them to the registry.

### 3.5 Conflict resolution: delegate to `resolve-conflicts` skill (v3.2)

When `git merge upstream/main` produces conflicts, **do not resolve them manually with custom rules**. Instead, delegate to the `resolve-conflicts` skill:

```
Skill /resolve-conflicts
```

The `resolve-conflicts` skill provides a professional, plan-first conflict resolution framework with:
- 7 conflict type patterns (imports, tests, generated files, config, code logic, structs, deleted-modified)
- Structured resolution plan + user approval before executing
- Decision tracking (remember user choices, apply to similar conflicts)
- Validation scripts (`validate-conflicts.sh`, `handle-deleted-modified.sh`)
- One-line explanation for every conflict resolved

**upstream-merge's role**: After resolve-conflicts resolves the conflicts, run §4.1 Pi-coupling grep (advisory) + §5 Checklist to validate the merge result from a fork-specific perspective.

> **Removed in v3.2** (2026-07-01): The previous §3.5 "Conflict hunk independence check" (awk-based 4-category classification + "保留两侧" conditions) and §4.4 "Same-function 5-step protocol" were custom conflict resolution rules that duplicated `resolve-conflicts` skill's functionality. They have been removed in favor of the professional skill.

## 4. Decision tree

Walk these steps in order, branching on the manifest row for each changed file.

**Step 1 — Identify Category.** Read the `Category` column (adapter / interface / source / skill / test / docs / config / planning / agents_meta / other). This alone answers ~70% of cases (see "Fast-path summary" below).

**Step 2 — Branch on `Default Resolution`:**

| Default Resolution | Action |
|--------------------|--------|
| `ours` | `git checkout --ours <path>`; mark "ours" in the merge commit body; jump to §5 Checklist |
| `theirs` | `git checkout --theirs <path>`; run `npx tsc --noEmit`; jump to §5 Checklist |
| `assess` | **遇到冲突时委托给 `resolve-conflicts` skill** (§3.5). After conflicts are resolved, run §4.1 Pi-coupling grep (advisory only — record hit count in commit body, not blocking). |
| `manual` | Open the editor; for each hunk, prefer upstream if generic, prefer ours if Pi-coupled; see §4.3 rule of thumb |

**Fast-path summary by Category** (covers `ours` / `theirs` rows without grep):

- `adapters/<agent>/*`, `adapters/entry.ts`, `skills/*`, `.planning/*`, `AGENTS.md`, `CLAUDE.md`, `.claude/*` → **always `ours`** (fork-only or agent-specific).
- `interfaces/*` (agent-api.ts, agent-paths.ts, sampling.ts, etc.) → **`manual`** (line-by-line; upstream remains Pi-specific per D-01..D-03).
- `package.json`, `vitest.config.ts`, `tsconfig.json`, `.gitignore`, `.npmignore` → **`manual`** (line-by-line, prefer fork's structural choices).
- `__tests__/*`, `tests/*`, `examples/*`, `types.ts`, `utils.ts`, `errors.ts`, `logger.ts` → **`assess`** (run §4.1 grep).
- Core MCP source (`init.ts`, `mcp-*.ts`, `lifecycle.ts`, `proxy-modes.ts`, `direct-tools.ts`, `commands.ts`, `state.ts`, `oauth-handler.ts`, `elicitation-handler.ts`, `sampling-handler.ts`, `tool-result-renderer.ts`) → **`assess`** (run §4.1 grep).
- `types/pi-*.d.ts` → **`ours`** (fork-side type declarations for Pi per D-21; declarations ≠ coupling).
- `README.md`, `MAPPING.md`, `CHANGELOG.md`, `OAUTH.md` → **`assess` via intent alignment** (preserve "Universal MCP Adapter" framing per D-18/D-19/D-20).

**Step 3 — Special cases:**

- File is `new` (Status column) + Category ∈ {adapter, interface, skill, planning} → `--ours` (we own the directory; upstream shouldn't add files here).
- File is `deleted` in upstream + still referenced locally → keep ours, add `// deprecated: removed in upstream; kept for fork back-compat` JSDoc (the `panel-keys.ts` precedent from Plan 08-01).

### 4.1 Pi-coupling marker grep (corrected template)

Run the **5 sub-commands** below against the changed files. Each covers a distinct marker class. The `\b` word boundaries and the `types/pi-*.d.ts` exclusion are the corrections from RESEARCH Dimension 3 — without them, every `agentapi.X` call in this fork produces a systematic false positive (CONTEXT's original 8 `pi.X` patterns are DELETED for exactly this reason; see `references/pi-coupling-markers.md` §"DELETED markers").

```bash
# === 1. Type / class markers (HIGH precision) ===
git diff upstream/main --name-only -- '*.ts' | xargs grep -nE \
    '\bExtensionAPI\b|\bExtensionContext\b|\bExtensionUIContext\b|\
\bAgentToolResult\b|\bAgentToolUpdateCallback\b' \
    2>/dev/null

# === 2. Package markers (HIGH precision, exclude .d.ts declarations) ===
git diff upstream/main --name-only -- '*.ts' '*.json' | xargs grep -nE \
    '@earendil-works/pi-(coding-agent|ai|tui)' \
    2>/dev/null | grep -vE 'types/pi-(ai|coding-agent|tui)\.d\.ts:'

# === 3. Env var marker (HIGH precision) ===
git diff upstream/main --name-only -- '*.ts' | xargs grep -nE \
    'PI_CODING_AGENT_DIR' 2>/dev/null

# === 4. UI surface (MEDIUM precision — generic ctx.ui but Pi-style API) ===
git diff upstream/main --name-only -- '*.ts' | xargs grep -nE \
    '\bctx\.ui\.(notify|form|custom|theme)' 2>/dev/null

# === 5. ToolInfo (must filter by import path) ===
# Flag only ToolInfo from @earendil-works/pi-coding-agent or pi-ai;
# the generic one in interfaces/agent-api.ts is fork-owned.
git diff upstream/main --name-only -- '*.ts' | xargs grep -nE \
    'from .*pi-coding-agent.*ToolInfo|from .*pi-ai.*ToolInfo' 2>/dev/null
```

**Decision rule:** Sub-commands 1-3, 5 → 0 hits means Pi-coupling-free (accept `--theirs`). Sub-command 4 (`ctx.ui.X`) is a MEDIUM marker; hits in `commands.ts` are expected and are **not** a follow-up trigger — `ctx.ui` is this fork's generic `UISystem` interface (D-04 / Phase 3). See `references/pi-coupling-markers.md` for the full per-marker inventory and rationale.

> **Note:** The 8 `pi.<method>` call patterns from the original CONTEXT-03-B draft (8 entries enumerated in `references/pi-coupling-markers.md` §"DELETED markers") are **DELETED** — they produce systematic false positives on `agentapi.X` generic adapter calls. They are catalogued only in `references/pi-coupling-markers.md` §"DELETED markers" so future maintainers can see why they are absent. Do NOT reintroduce them in the §4.1 template without re-verifying against the latest codebase.

### 4.2 Per-file default resolution (12-category matrix) and 5-step follow-up flow

#### 4.2a Per-category default resolution

The 12-category per-file default-resolution matrix (sourced from D-23; inlined here per **D-35** so the fast-path and the slow-path special-cases registry are visible in one place). Every diverged file not in `references/special-cases.md` defaults to the action in this table; the special-cases registry overrides only when a file genuinely cannot be resolved by category rules.

| Category | Default | Rationale | Source |
|---|---|---|---|
| `adapters/<agent>/*` | `ours` | Fork-only; upstream doesn't add adapters | D-21 |
| `adapters/entry.ts` | `ours` | Frozen signature per D-07 | D-07 |
| `skills/*` | `ours` | Fork-only skill additions | D-21 |
| `interfaces/*` | `manual` | Fork-generic; upstream remains Pi-specific | D-01..D-03 |
| `package.json` / `vitest.config.ts` / `tsconfig.json` | `manual` | Line-by-line; prefer fork structural choices | D-21 |
| `.gitignore` / `.npmignore` | `manual` | Line-by-line; prefer fork structural choices | D-21 |
| `__tests__/*` / `tests/*` | `assess` | Run §4.1 grep; mostly legal but watch for new test fixtures | D-24 |
| Core MCP source (`init.ts`, `mcp-*.ts`, ...) | `assess` | Always run §4.1 grep; check D-04 wrapper boundaries | D-24, D-04 |
| `bin/*` | `ours` | Fork-only bin entries; upstream has no `bin/` directory | D-21 |
| `types.ts` / `utils.ts` / `errors.ts` / `logger.ts` | `assess` | Universal utility files; Pi-coupling unlikely but check | D-24 |
| `README.md` / `MAPPING.md` / `CHANGELOG.md` / `OAUTH.md` | `assess` (intent) | Preserve "Universal MCP Adapter" framing | D-18..D-20 |
| `AGENTS.md` / `CLAUDE.md` / `.claude/*` | `ours` | Fork-specific | D-21 |
| `.planning/*` | `ours` | Planning artifacts are fork-specific | D-21 |
| `types/pi-*.d.ts` | `ours` | Fork-side type declarations for Pi (declarations ≠ coupling) | D-21 |

This matrix covers ~70% of files; the remaining ~10% are the special cases in `references/special-cases.md`. The §4.1 grep runs on `assess` rows before any `--theirs` decision.

#### 4.2b Pi-coupling soft follow-up (advisory, non-blocking) (v3.1)

When the §4.1 grep returns ≥1 hit in core source, the merge is **not blocked**. Best-effort follow-up:

1. **Conflicts resolved by `resolve-conflicts` skill** (§3.5) — accept the resolution result.
2. **Optionally open a follow-up issue** (best-effort, only if `gh` CLI authenticated). Skip if `gh` not authenticated.

> **Removed from v1** (2026-07-01, Phase 13): steps "Stage a follow-up commit that refactors the Pi-coupling out", "Open a follow-up issue" (now optional), and "Reference the issue number in the merge commit body" are removed from the mandatory path. Rationale: fork is downstream, not adversarial. The adapter layer (`adapters/pi-adapter.ts`) provides runtime isolation; Pi-coupling in core is log-only. See `docs/upstream-merge-retrospective.md` §2.1.3 for the full rationale.

### 4.3 `manual` review rule of thumb

For `manual` rows, accept upstream hunks unless they touch a function signature that generic code depends on — the canonical example is `createMcpAdapter(agentapi, ctx, config, cache)` in `adapters/entry.ts`; that signature is frozen per D-07 and any upstream change to it is rejected (`git checkout --ours`).

### 4.4 Conflict resolution: delegate to `resolve-conflicts` skill (v3.2)

When conflicts occur during `git merge upstream/main`, **delegate to the `resolve-conflicts` skill** instead of using custom resolution rules:

```
Skill /resolve-conflicts
```

The `resolve-conflicts` skill handles all conflict types professionally:
- **Imports**: Merge all unique imports, group by module
- **Tests**: Keep all tests unless identical, merge fixtures
- **Generated files**: Regenerate from source
- **Config**: Merge all keys, choose appropriate values
- **Code logic**: Analyze intent, merge if orthogonal, choose one if conflicting
- **Structs**: Include all fields from both branches
- **Deleted-modified**: Backup, analyze, apply to new location

> **Removed in v3.2**: The previous §4.4 "Same-function 5-step protocol" (extract ours/theirs → classify merge mode → document decision) was a custom conflict resolution rule. It has been removed in favor of `resolve-conflicts` skill's Step 4 "Execute Resolution Plan" which provides the same functionality with a more comprehensive framework (7 patterns, decision tracking, user approval flow).

## 5. Checklist

Run all 8 checks before declaring the upstream-merge flow complete. Each is a single command the agent can execute and inspect. Steps (a)–(g) gate the Step 1 merge commit on `main`; step (h) gates the Step 2 propagation into the working branch. A merge is not done until every item is recorded with PASS / N/A / FAIL.

- **(a) All conflicts resolved** — `git diff --name-only --diff-filter=U | wc -l` returns 0. If > 0, there are still unresolved hunks; re-walk the decision tree.
- **(b) Pi-coupling markers advisory log (no longer blocking)** — re-run the 5 sub-commands from §4.1 against the post-merge working tree; record the total hit count in the merge commit body. The only acceptable hits are inside `adapters/`, `types/`, or `__tests__/` (legal coupling zones); any hit outside these zones is acceptable (advisory) but should be tracked for the next Pi-coupling reduction cycle. Per v3.1 Phase 13 policy change (2026-07-01), this check no longer blocks the merge — see §4.2b and `docs/upstream-merge-retrospective.md` §2.1.3.
- **(c) TypeScript compiles** — `npx tsc --noEmit` exits 0.
- **(d) Tests are green** — `npm test` (which runs `test:prebuild` then the full vitest suite) exits 0. The quick alternative is `npx vitest run __tests__/adapter-contract.test.ts` for the parametric adapter contract. **In sandboxes**, the full suite has network/symlink-dependent flakes (`Test timed out in 5000ms`, `EPERM: symlink`, MCP version-negotiation failures) unrelated to the merge. For a high-signal check, run a focused subset of the files you actually changed/resolved (e.g. `npx vitest run --reporter=dot <changed test files>`), confirm those pass, and record the full-suite environmental failures separately in the commit body rather than treating them as merge regressions.
- **(e) Divergence check passes — `npm run upstream:check` exits 0** (no stale registry entries; `diverged-but-not-registered` warnings are acceptable, see §4.2a category defaults). The cross-check script replaces the Phase 8 manifest-gap ≤ 10 check; per D-34, exit 1 means stale entries require registry cleanup before the merge commit.
- **(f) Version consistency — `package.json.version` == CLI-reported version** — build then check: `npm run build:mcp-server && node mcp-server.mjs --version | head -1` must equal `node -p "require('./package.json').version"`. This catches the silent drift where `bin/mcp-server.ts` hardcoded `SERVER_VERSION` stayed at `5.2.0-0.0.6` while `package.json` was bumped to `7.0.0-0.0.1` in the v7.0.0 merge (the registry classifies `bin/*` as `ours`, and no prior checklist step compared them). Fix by injecting the version from `package.json` at build time (esbuild `define`) with a dev fallback that reads `package.json` — never a second hardcoded literal. If this drifted, record the fix in the merge commit body.
- **(g) Commit message prefix is `upstream-merge:`** — e.g., `upstream-merge: sync v2.10.0 (N files, M conflicts resolved)`. The body should list `ours` / `theirs` / `assess` row counts and any `Refs #N` follow-up issue links.
- **(h) Step 2 propagation complete (skipped if working branch is `main`)** — `git checkout <working-branch> && git merge main` succeeds as a fast-forward or a clean small merge. The working branch now contains the upstream changes from Step 1; if conflicts appear, they are fork-vs-fork, not upstream-vs-fork, and the resolution strategy is the fork's own (consult the relevant Phase plan, not the §4 decision tree). After Step 2, re-run (c) and (d) on the working branch to confirm the propagated state still builds and tests pass.

When steps (a)–(g) PASS, the merge is locally complete on the feature branch. **Do NOT push directly to `main`** — proceed to the §5.5 PR sub-flow below. When step (h) also PASS (post-PR-merge), the upstream-merge flow is fully complete on both `main` and the working branch.

## 5.5 PR sub-flow (mandatory — bridges local merge to merged `main`)

Per the project-wide rule "**绝对不允许直接提交到main分支**" (enforced by `.githooks/pre-push` and `.github/workflows/no-direct-main-push.yml`, see AGENTS.md "Branch Policy (HARD RULE)"), every upstream-merge MUST go through a PR. This sub-flow replaces the previous single-line "push the merge branch and open a PR" instruction with a deterministic 5-step procedure.

**Naming contract**: the feature branch MUST be `upstream-merge/<upstream-version>` (e.g., `upstream-merge/v2.10.0`). This is what the PR template and the `pr-divergence-check` CI match against. If you deviated from this naming in §1 step 0, rename with `git branch -M upstream-merge/<correct-version>` before continuing.

### 5.5.1 Push the feature branch

```bash
git push -u origin upstream-merge/<version>
```

`pre-push` will NOT intercept (it only blocks `refs/heads/main`/`refs/heads/master`). If the hook fires anyway, you pushed the wrong ref — abort and re-check `git rev-parse --abbrev-ref HEAD`.

### 5.5.2 Open the PR

Use the body template at `references/pi-coupling-markers.md §"PR template"`. Auto-generate from §5 checklist values:

```bash
gh pr create \
  --base main \
  --head upstream-merge/<version> \
  --title "upstream-merge: sync <version> (<N> commits, <M> files diverged)" \
  --body "$(cat <<'EOF'
## Upstream merge <short-sha>

- Base ref: upstream/main @ <upstream-sha>
- Files merged: <N> (ours: <a> / theirs: <b> / assess: <c> / manual: <d>)
- Conflicts resolved: <M>
- Pi-coupling re-introductions: <K>
- Follow-up issues: #<N>, #<N>
- Manifest staleness: |raw - manifest| = <Δ> (acceptable ≤ 10)
- Checklist: 7/7 gating PASS (Step 2 propagation (h) after merge)

Refs: <list of follow-up issues>
EOF
)"
```

If `gh` CLI is not authenticated, log in first: `gh auth login` (or use a Personal Access Token via `GH_TOKEN`). If `gh` is unavailable (some sandboxed environments), push the branch and create the PR manually via the GitHub web UI, citing the body template above.

### 5.5.3 Wait for CI

```bash
gh pr checks --watch
```

Required CI workflows (per `.github/workflows/`):

- `pr-divergence-check.yml` — runs `npm run upstream:check` on the PR. **MUST be green.**
- `no-direct-main-push.yml` — advisory; should not fire on a PR (the merge happens via `gh pr merge`, not `git push`).

If `pr-divergence-check` fails: it means the registry gained new stale entries between PR open and the check. Update `references/special-cases.md`, **amend the merge commit** on the feature branch (`git commit --amend --no-edit`), force-push (`git push --force-with-lease`), and re-run.

If the check is still in progress after 5 minutes, do not panic — the script does its own `git fetch upstream` which can be slow. Re-run `gh pr checks` periodically.

### 5.5.4 Merge the PR

```bash
gh pr merge --squash --delete-branch
```

- `--squash`: collapses the merge commit + any follow-up commits into a single commit on `main`. The squash commit message is auto-populated from the PR title; the body becomes the merge commit body (preserves the §5 checklist summary).
- `--delete-branch`: removes both remote (`origin/upstream-merge/<version>`) and local feature branch (cleanup step).

If the PR is a fast-forward (no merge commit on the feature branch — rare for upstream-merge but possible for tiny patches), use `--merge` or `--rebase` instead of `--squash`.

If `gh pr merge` is blocked by branch protection (e.g., "Reviews required"), request a review first (`gh pr review --approve` if you have permission, or use the GitHub web UI).

### 5.5.5 Verify and clean up

```bash
# Confirm main now has the merge
git fetch origin && git log --oneline origin/main -5
# Confirm local branch is gone (--delete-branch handles this)
git branch | grep upstream-merge  # should be empty
# Confirm working tree is clean
git status
```

If anything looks wrong (missing commits, wrong files, CI failure surfaced post-merge), `git revert` the PR merge commit on `main` and investigate. **Do NOT push a fix commit directly to `main`** — branch, fix, and PR (per AGENTS.md Branch Policy).

---

## 6. Fork architecture principles (NEW, v3.1)

> **Purpose**: Prevent future merge conflicts at the source, not just resolve them better.
> Source: User insight 2026-07-01 ("fork 引入的代码，如果是独立的，应该独立成文件") + retrospective §3.2.1 L1/L2/L3 decision matrix.

### 6.1 Core principle

**When introducing fork-only code, ALWAYS prefer "独立文件" over "修改 upstream 文件".**

The conflict resolution cost grows with granularity:

| 粒度 | 冲突表现 | 解决成本 |
|------|---------|---------|
| 文件级 | 整个文件 conflict | 🟢 1 行 |
| 段落级 | 文件内某段 conflict | 🟡 需 §4.4 5 步 |
| 函数级 | 同一函数内 conflict | 🟠 需 §4.4 5 步 |
| 行级大块 | 同一函数 343 行同时被改 | 🔴 灾难 |

**Target: 把所有 fork 引入的独立代码推到"文件级"粒度。**

### 6.2 L1/L2/L3 decision matrix (for current fork state)

> Full matrix in `docs/upstream-merge-retrospective.md` §3.2.1.

| Layer | Category | Action |
|-------|----------|--------|
| **L1** | REPLACEMENTS（9 个 Phase 3 抽象改造）| **接受冲突**——撤回 = 撤销 universal 目标 |
| **L2** | ADDITIONS（8 个 fork 加 universal 段）| 大部分已优化（Phase 12 删除 per-agent）；剩余不值得抽 |
| **L3** | TESTS（~10 个 fork universal 测试）| 按 Plan 14-04 拆 init-elicitation |

### 6.3 Future-proofing rules (apply to all new fork code)

When adding new fork-only functionality:

1. **New agent adapter** → create `adapters/<new-agent>.ts`, NOT modify `adapters/entry.ts`
2. **New test scenario** → create `__tests__/<new-scenario>.test.ts`, NOT extend existing `__tests__/init-*.test.ts`
3. **New abstract type** → extend `interfaces/agent-api.ts`, NOT import Pi types directly in core
4. **New universal helper** → create `adapters/<helper>.ts` or `utils/<helper>.ts`, NOT add as inline closure in `entry.ts`
5. **New fork-only documentation** → create `docs/<new-topic>.md`, NOT extend `docs/upstream-merge-retrospective.md` in place (use references + cross-links)

**Anti-pattern**: Adding a new `registerCommand` or `registerTool` call inline in `adapters/entry.ts` `createMcpAdapter` body. This creates future merge conflict at the function level (243-line function body).

**Correct pattern**: Create a new file like `adapters/commands/<new-command>.ts` exporting a `setup<NewCommand>(agentapi, getState, getInitPromise)` function, then call that function from `createMcpAdapter`.

### 6.4 Pre-commit guardrail (CI in Phase 15)

Phase 15 P2-3 will add a CI check that runs:

```bash
# Count: new files vs modified files in this PR
new_files=$(git diff --name-only --diff-filter=A origin/main...HEAD | wc -l)
modified_files=$(git diff --name-only --diff-filter=M origin/main...HEAD | wc -l)

# Warn if too many modifications relative to new files
# (suggests inline additions rather than new file extractions)
ratio=$(echo "scale=2; $modified_files / ($new_files + 1)" | bc)
if (( $(echo "$ratio > 2.0" | bc -l) )); then
  echo "⚠ High modify-to-new ratio: $ratio. Consider extracting independent code to new files."
fi
```

**Target ratio**: ≤ 2.0 modifications per new file. If exceeded, PR review should consider whether fork code could be extracted to a new file.

### 6.5 Cross-references

- `docs/upstream-merge-retrospective.md` §3.2.1 — full L1/L2/L3 matrix with empirical data (249 fork-only commits, 278 diverged files)
- `docs/upstream-merge-retrospective.md` §2.4 — multi-perspective reflection on conflict granularity
- SKILL.md §1 — Two-step git merge flow (the merge strategy that this principle supports)

### 6.6 Code structure optimization: how to reduce future conflicts (v3.2)

Based on the 2026-07-01 first merge attempt (11 conflicts, 249 fork-only commits, 278 diverged files), the following code structure changes would reduce future conflict frequency:

**1. Fork-only code in independent files (not modify upstream files)**

When adding new fork-only functionality, create new files — do NOT add code to upstream files that upstream will also modify:

- ✅ New agent adapter → `adapters/<new-agent>.ts` (not modify `adapters/entry.ts`)
- ✅ New test scenario → `__tests__/<new-scenario>.test.ts` (not extend `__tests__/init-*.test.ts`)
- ✅ New abstract type → extend `interfaces/agent-api.ts` (not import Pi types in core)
- ✅ New universal helper → `adapters/<helper>.ts` or `utils/<helper>.ts` (not inline in `entry.ts`)
- ✅ New fork-only doc → `docs/<new-topic>.md` (not extend `docs/upstream-merge-retrospective.md` in place)

**2. Avoid large functions that both sides will modify** (REVISED 2026-07-02: heuristic, not absolute)

The 2026-07-01 attempt showed `adapters/entry.ts` `createMcpAdapter` (324 lines) as the hardest conflict — both fork and upstream modify the same function body. Break large functions into smaller, independently-modifiable units:

- ❌ One 324-line function → ✅ 4 small functions (~80 lines each) + thin orchestrator
- ❌ Inline session lifecycle in `createMcpAdapter` → ✅ Extract to `setupSessionHandlers()`
- ❌ Inline command registration → ✅ Extract to `registerCommands()`

> **Heuristic, not absolute rule** (REVISED 2026-07-02): "Large function" is not well-defined — 30 lines of pure logic is large, but 300+ lines of YAML/JSON/case-statement config may be reasonable. Use `npm run check:large-functions` (default 300 lines) as a **heuristic indicator**, not an absolute threshold. A function being detected as "large" does NOT automatically mean it should be refactored — **refactor only if**:
>
> 1. The function is in a file that both fork and upstream actively modify (verify with `git log upstream/main..main -- <file>` + `git log main..upstream/main -- <file>`)
> 2. AND the function has been the source of past merge conflicts (check retrospective)
> 3. AND the function's body is "structurally simple" (not just long due to data tables/cases)
>
> If any of the above conditions is false, the line count is not a merge-conflict risk — leave it alone. **The root cause of merge conflicts is "both sides modify the same function", not "the function is long".**

**3. Keep import sections stable**

Import conflicts are the easiest to resolve but still cost time. Minimize import churn:

- Use `interfaces/agent-api.ts` abstractions instead of direct Pi type imports (fork-specific imports don't conflict with upstream Pi imports)
- Group imports consistently (std → external → internal → relative)
- When adding a new dependency, add it in a new file, not in an existing core file

**4. Separate fork-only config from upstream config**

- ✅ Fork config in `.planning/` (fork-only, never conflicts)
- ✅ Fork CI in `.github/workflows/` (fork-only, never conflicts)
- ❌ Fork config inline in `package.json` or `tsconfig.json` (shared with upstream, will conflict)

**5. Run `npm run upstream:check` before every PR**

The `--json` mode (CI-02) provides machine-readable divergence data. Use it to detect new divergence early.
