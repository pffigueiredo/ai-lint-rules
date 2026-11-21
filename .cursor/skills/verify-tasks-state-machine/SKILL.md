---
name: verify-tasks-state-machine
description: >-
  Runs fast-check command sequences against the tasks CLI (node src/cli.ts) and
  checks spec-stated state-machine properties. Use after changing
  evals/problems/tasks/solution, evals/problems/tasks/checkpoint_*.md,
  evals/problems/tasks/properties.ts, evals/verify.ts, or a tasks snapshot in an
  evals run dir.
---

# Verify the tasks CLI state machine

No production verifier runs on TypeScript here. The check drives the real CLI with generated command sequences (`fc.commands` + `fc.asyncModelRun` in `evals/problems/tasks/properties.ts`).

## When to use this

Run this after you edit the tasks reference CLI, the tasks spec checkpoints, the property suite, or a `tasks-*` eval snapshot. Skip it for ledger, React problems, and overlay rules that do not touch `evals/problems/tasks`.

## Command

From the repo root:

```sh
node evals/verify.ts --self-check
```

That copies `evals/problems/tasks/solution`, checks every property, then applies one planted bug per property and checks that each bug fails with a shrunk command sequence.

On an eval run directory:

```sh
node evals/verify.ts <runDir> [--checkpoint 5] [--runs N] [--seed S]
```

That clones each `tasks-*` bundle, checks the chosen checkpoint, and writes `properties.jsonl` plus `properties.md`. Rerun the same command to resume.

## Pass and fail

`--self-check` must print `self-check ok` and exit 0. A reference failure is either a bug in the CLI or a bug in the property. A planted bug that passes means the property cannot see that class of mistake.

A run-dir fail prints the CLI commands, the expected observables, and the actual ones. Treat that as a finding. Do not weaken the property to make the snapshot pass.

## Real bug vs property error

Replay the printed commands yourself in a fresh temp directory, using the same `src/cli.ts`:

```sh
mkdir /tmp/tasks-replay && cp -R src /tmp/tasks-replay/src
cd /tmp/tasks-replay
node src/cli.ts add a --today 2024-03-15
# then each following line from the counterexample
```

If that replay breaks the spec sentence named in the failure, the CLI is wrong. If a command in the sequence is not a legal invocation, or the expected value is not what the spec says, fix `evals/problems/tasks/properties.ts`. Do not edit `evals/problems/tasks/solution` unless the user asked.

If the replay passes but the suite still fails, suspect the harness's probes before the CLI. The spec only fixes `tasks.json`, and agents keep undo history in other files (`undo.json`, `tasks.undo.json`), so anything that saves and restores state around a probe must cover the whole cwd. A probe that restored only `tasks.json` once reported false `fail-is-noop` breaches on exactly the snapshots with an undo sidecar.

In zsh, replay with `node src/cli.ts ${=line}` when the command sits in a variable; plain `$line` passes the whole command as one argument.

## Spec changed on purpose

If `checkpoint_*.md` changes the promise:

1. Update the matching entry in `PROPERTIES` in `evals/problems/tasks/properties.ts`. Cite the new spec sentence.
2. Change the generator only if new commands exist.
3. Plant a bug that breaks the new sentence. Keep it as a string replacement in `PLANTED_BUGS`, applied to a temp copy, never to the real solution.
4. Run `node evals/verify.ts --self-check`.
5. Move the sync commit below only after that pass, and only if the verification still describes the code at the new commit.

After merges that skipped this skill, use `/maintain-formal-verification-skill`.

## Coverage

The sync commit is `401c512a430f62bc50cc7420a19ccab753061798`. Move this hash only after you confirm the verification still describes the files below.

Covered implementation:

- `evals/problems/tasks/solution/src/cli.ts`
- `evals/problems/tasks/solution/src/lib.ts`

Covered spec and properties:

| Property | Spec | Checkpoints |
| --- | --- | --- |
| `undo-restores` | `checkpoint_3.md`, `checkpoint_5.md` undo | 3-5 |
| `fail-is-noop` | failed `done` / `cycle` are not undone | 3-5 |
| `no-cycle` | `checkpoint_5.md` cycles | 5 |
| `ready-matches-json` | `checkpoint_5.md` `list --ready` | 5 |
| `done-blocked-or-recurring` | blocked `done`; recurring spawn | 4-5 |
| `unique-ids` | `checkpoint_1.md` unique ids | 1-5 |

Each property's one-sentence claim and spec citation live in `evals/problems/tasks/properties.ts`.

## Bounds

Fixed seed `20261121`, `8` sequences, at most `8` generated commands after a 1-or-3 `add` prefix, ids `1-4` and `99`, `--today 2024-03-15`. Override runs and seed on a run dir with `--runs` and `--seed`. A pass is a pass inside this bound, not for every longer trace.

## What this does not cover

- Ledger and React problems
- Invalid `tasks.json` on disk (exit 2 and 3) except as a unique-id failure when the CLI writes a duplicate
- Pretty-print of `list` without `--json`
- Concurrent processes sharing one `tasks.json`
- Agent snapshots other than the `tasks-*` bundles in the run dir you pass
