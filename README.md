# AI lint rules

A public reference of lint rules that keep agents and humans on the same rails.

Copy the files. Point Oxlint at them. Rename the plugin if you want. This is not an npm package.

The React bans started as the local Oxlint plugins in [KATTCORP/isbabyoutyet](https://github.com/KATTCORP/isbabyoutyet). The rest is the stack that locked a small React Compiler app: typed boundaries, no floating promises, no derived state in effects, and a token-locked Tailwind theme.

## Layout

- `oxlint/react-bans` — eight Oxlint JS-plugin rules, with tests: four hook bans and four state rules
- `oxlint/typescript` — `any`, `@ts-*`, `as` casts, `!` assertions, `console`, floating promises
- `tsconfig/strict.json` — the strict compiler flags that pair with those rules
- `oxlint/react-effects` — Compiler `set-state-in-effect` plus You Might Not Need An Effect
- `oxlint/tailwind-theme` — `eslint-plugin-better-tailwindcss` config that canonicalizes classes and bans one-off tokens
- `oxlint/architecture` — import bans that keep layers pointing one way and server data in `src/lib`
- `konsistent/konsistent.json` — [konsistent](https://www.npmjs.com/package/konsistent) convention that every page route sets its meta
- `oxlint/stack` — all the Oxlint configs above in one `.oxlintrc.json`
- `oracles` — runnable property and oracle tests with [fast-check](https://fast-check.dev), and how to write them
- `evals` hold CLI and React problems that measure whether the TypeScript and React rules change what an agent writes

Needs `oxlint` and `@oxlint/plugins` at matching versions. The copies here were taken from `1.83.0`. Floating promises also need `oxlint-tsgolint`.

```sh
pnpm add -D oxlint@1.83.0 @oxlint/plugins@1.83.0 oxlint-tsgolint
pnpm add -D eslint-plugin-better-tailwindcss eslint-plugin-react-you-might-not-need-an-effect
pnpm test
```

Start from `oxlint/stack/oxlintrc.example.json`, then drop the pieces you do not want.

## React bans

Oxlint loads JavaScript plugins through `jsPlugins`. Drop `oxlint/react-bans` into a project and wire it like `oxlint/react-bans/oxlintrc.example.json`.

| Rule | Blocks |
| --- | --- |
| `ai/no-use-state` | `useState`, `useReducer`, `useActionState`, `useOptimistic`, `useSyncExternalStore` |
| `ai/no-use-effect` | `useEffect`, `useLayoutEffect` |
| `ai/no-manual-memoization` | `useMemo`, `useCallback` (React Compiler owns this) |
| `ai/no-banned-react-reexport` | Re-exporting the banned hooks through a local barrel |

Shareable UI state goes in the URL. Derived state comes from queries or mutations. Effects and subscriptions live behind audited `src/lib/use-*.ts` hooks. The example config turns the state and effect rules off for that glob.

## State rules

For wherever `useState` is allowed: a project without `ai/no-use-state`, or the `src/lib/use-*` hooks that are exempt from it. They ban the four shapes unnecessary state usually takes. A lint rule can't judge what state means, only how it's written, so each rule targets one shape that is almost always the wrong version.

| Rule | Blocks | Fix |
| --- | --- | --- |
| `ai/no-async-state` | A state setter called in an `async` function, in `.then` / `.catch` / `.finally`, or in a query's `onSuccess` / `onError` / `onSettled` | Read `status`, `data` and `error` from `useQuery` / `useMutation`. `status` is already `'idle' \| 'pending' \| 'success' \| 'error'`. |
| `ai/no-boolean-state` | Any boolean in `useState`: `false`, `!x`, `Boolean(x)`, `x > 0`, `<boolean>`, and boolean fields of an object (`useState({ editing: false })`) | Let the browser own open/closed (`<details>`, `popover`, `<dialog>`), the form own checkboxes (read `FormData` on submit), and TanStack Query own async status. Name anything else as a union: `useState<'view' \| 'editing'>('view')`. |
| `ai/no-state-copies` | `useState(props.venue)`, and `setSelected(v)` where `v` is an item from `.map` / `.find` / `.forEach` | Read the prop directly, or name it `initial…` / `default…` if it's a starting draft. Store the item's key and look it up during render. |
| `ai/no-url-state-copy` | `useState` / `useReducer` whose initializer (or a same-file function passed or called as that initializer, one level deep) reads `location`, `window.location`, `document.location`, `URLSearchParams`, `useSearchParams`, or `useSearch` | Read the value from the URL during render, or from a `src/lib/use-*` hook that subscribes to it. Copying it into state goes stale on Back. |

Whether two booleans depend on each other isn't visible in syntax or in types, so no rule can detect it without guessing. `no-boolean-state` doesn't try. It removes boolean flags from component state, so contradictory flags can't exist. It doesn't catch two related unions (`'view' | 'editing'` next to `'idle' | 'confirming'`); that's left to review. Only `ai/no-use-state` rules out every combination, by allowing no local state.

A controlled text form passes all three rules: `useState({ email: '', name: '' })` is a draft the component owns. Checkbox fields are booleans, so a form with checkboxes is uncontrolled (read with `FormData`) or goes through a form library. `no-boolean-state` doesn't follow type references either, so `useState<Flags>(initialFlags)` passes when both are declared elsewhere.

`no-state-copies` treats a list item as an object only when the callback reads a property off it (`v.name`), so `days.map((d) => setDay(d))` passes. It also misses a copy made through an intermediate variable (`const v = venues.find(...)`, then `setSelected(v)`).

These overlap with existing rules, deliberately:

- [`shelf/prefer-swr-mutation`](https://www.pkgstats.com/pkg:@shelf/eslint-config) flags loading flags around remote calls, for SWR. `no-async-state` flags any setter after a promise, for TanStack Query.
- [react-doctor](https://github.com/millionco/react-doctor)'s `prefer-useReducer` warns at five `useState` calls. `no-boolean-state` bans boolean state outright, because counting can't tell related flags from independent ones.
- react-doctor's `no-derived-useState` flags props in `useState` too, but also flags `initialValue` drafts and suggests syncing the copy in an effect. `no-state-copies` exempts `initial*` / `default*` and adds the list-item case.

## TypeScript and console

Built-in Oxlint rules. `no-floating-promises` needs `options.typeAware: true` and the `oxlint-tsgolint` package.

| Rule | Blocks |
| --- | --- |
| `no-console` | `console.*` in app code. Turn it off for `tools/**`, `scripts/**`, and `bin/**`. A CLI package should turn it off for its whole `src`. |
| `typescript/no-explicit-any` | `any` |
| `typescript/ban-ts-comment` | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` |
| `typescript/consistent-type-assertions` `{ assertionStyle: "never" }` | `as Type`. Use a type predicate, `zod`, or `satisfies` at the boundary. `as const` is still allowed. |
| `typescript/no-non-null-assertion` | `x!`. With `as` banned, `!` is the last cheap way to silence a type error. No exceptions, tests and scripts included. |
| `typescript/no-floating-promises` | A Promise that is not `await`ed, `return`ed, `.catch`ed, or `void`ed. Intentional fire-and-forget (TanStack `navigate()` in a click handler) is `void navigate(...)`. |

Type-aware mode also turns on the rest of tsgolint correctness. This stack leaves two of those off because they were noise on a React Compiler app of object methods and `FormData` values:

- `typescript/unbound-method` — `onClick={model.zoomIn}` is a plain object method, not `this`
- `typescript/no-base-to-string` — `String(formData.get(name))`

Do not copy a giant “every tsgolint rule off” list. Opt in `no-floating-promises`. Leave the rest of the pack at default unless a rule is actually noisy.

Listing `plugins` replaces Oxlint’s defaults. Keep `"typescript"`, `"unicorn"`, and `"oxc"` next to `"react"`.

## Strict tsconfig

`tsconfig/strict.json` is `strict` plus every compiler flag that rejects a shortcut. Copy its `compilerOptions` into your tsconfig, or `extends` it.

| Flag | Rejects |
| --- | --- |
| `noUncheckedIndexedAccess` | Reading `arr[i]` or `record[key]` as if it always exists. The result is `T \| undefined`. |
| `exactOptionalPropertyTypes` | Passing `undefined` to an optional `prop?: T`. Write `prop?: T \| undefined` when you mean it. |
| `noPropertyAccessFromIndexSignature` | `record.key` on an index signature. Write `record['key']`, or declare the key. |
| `noImplicitOverride` | Overriding a class method without `override` |
| `noImplicitReturns` | A function where some paths return a value and others fall off the end |
| `noFallthroughCasesInSwitch` | A non-empty `case` that falls into the next one |
| `noUnusedLocals`, `noUnusedParameters` | Dead variables and parameters |
| `allowUnreachableCode: false`, `allowUnusedLabels: false` | Unreachable code and unused labels, as errors instead of warnings |

`noUncheckedIndexedAccess` only works together with `typescript/no-non-null-assertion`. Without the ban, an agent satisfies the flag by writing `arr[0]!`, and the codebase ends up with the same assumption plus a `!`. Replace each `!` with something the compiler can check:

- **Count-then-read:** `(counts[key] ??= { n: 0 }).n++` instead of initialising and then reading `counts[key]!`.
- **Parallel arrays:** a `Record<Day, string>` keyed by the value instead of `NAMES[i]!`.
- **Unknown data:** narrow with `in` (`'name' in data && typeof data.name === 'string'`) instead of reading fields off `Record<string, unknown>`.
- **Real invariants:** `if (!x) throw new Error('…')` with a message that says what was expected. In tests, the same throw with the fixture you expected.

`noPropertyAccessFromIndexSignature` also rejects `import.meta.env.API_URL` until you declare the variable. Declaring it removes the `any` as well:

```ts
// src/env.d.ts
interface ImportMetaEnv {
  readonly API_URL: string
}
```

## React effects

`react/set-state-in-effect` is a built-in Compiler rule (`plugins: ["react"]`). `no-derived-state` is [eslint-plugin-react-you-might-not-need-an-effect](https://github.com/nickjvandyke/eslint-plugin-react-you-might-not-need-an-effect), loaded as a JS plugin.

| Rule | Blocks |
| --- | --- |
| `react/set-state-in-effect` | `setState` synchronously inside `useEffect` |
| `react-you-might-not-need-an-effect/no-derived-state` | Copying props or other state into state through an effect. Compute it during render. |

Together with `ai/no-use-effect`, feature UI cannot grow an effect at all. These two still audit the `src/lib/use-*` allowlist.

## Architecture

Three file-level patterns for a TanStack Start app. Each one is checked by a tool, not just written down.

**1. Dependencies point one way: `routes` → `components` → `lib` / `stores` → `data` / `db`.** Nothing lower down imports anything higher up, so `lib/` and `data/` stay testable without React or the router. `oxlint/architecture` bans upward imports per folder with `no-restricted-imports`.

**2. Server data lives in `src/lib`.** Only `lib/` touches the backend client or TanStack Query. Components and routes call named hooks such as `useSave()` or `useSetPassword(email)`, so query keys, cache invalidation and error handling stay in one place. The config bans two things in `src/components` and `src/routes`:

- **The query hooks by name**, not the whole package. `router.tsx` creates the `QueryClient` and `__root.tsx` renders `QueryClientProvider`, and both stay allowed.
- **The backend client package.** The example uses `@neondatabase/**`; swap in yours. Use `**`: in Oxlint, `@neondatabase/neon-js/*` does not match the subpath `@neondatabase/neon-js/auth/react/adapters`, but `@neondatabase/**` matches the package and every subpath.

Also stop exporting the client and its error helper from the `lib/` module that owns them. TypeScript then blocks the import as well as the lint rule.

**3. Route files stay thin.** A route file validates params and search, loads data, sets `head`, and renders one component, with no markup and no data calls. Pattern 2 already bans data calls in routes. `konsistent/konsistent.json` adds the convention that every page route exports `Route` and calls `pageMeta`, the helper that builds the page's title and description. Rename `pageMeta` to your helper, and replace the two exclusions with your layout routes and any page that inherits the root title. Add it with `pnpm add -D konsistent` and run it after Oxlint: `"lint": "oxlint . && konsistent"`. It exits 1 on a violation.

"No markup in route files" has no reliable rule, so it stays review.

## Oracle tests

A lint rule checks how code is written. An oracle test checks what it does, across hundreds of inputs you didn't pick. The idea comes from [TanStack DB 1.0 RC1: Going All In on Oracles](https://tanstack.com/blog/tanstack-db-1.0-rc1-going-all-in-on-oracles). TanStack also publishes the skills it uses to write and review them: [oracle-authoring](https://www.skills.sh/tanstack/db/oracle-authoring) and [oracle-review](https://www.skills.sh/tanstack/db/oracle-review).

Each test has three parts:

1. **A generator.** fast-check invents inputs, such as 30 random pins around Madrid at zoom 12.
2. **The real code** runs on each input.
3. **A checker you write** decides whether the output is acceptable. It is either a **rule** that every correct answer shares ("no two shown names overlap"), or an **oracle**: a deliberately simple, slow version that computes the expected answer, which the real code must match.

When a check fails, fast-check shrinks the input to the smallest one that still fails, such as two pins at the same spot, and prints it.

The examples in `oracles/` come from a map app:

- **`clusters.test.ts` (oracle).** The real code clusters places with Supercluster. The oracle is the input list itself: every place is on the map exactly once, as a pin or counted inside a cluster. Above `MAX_CLUSTER_ZOOM` all of them are pins, and the open place gets one pin whether or not it is in the list.
- **`labels.test.ts` (rules).** When two names collide, either one may show, so there's no single answer for an oracle to compute. The test checks what every correct answer shares: shown names don't overlap, the open pin keeps its name, and a name is hidden only when it would overlap a shown one.

How to write one:

1. **State the rule in one sentence** a user would recognise.
2. **Compute it independently.** Don't import helpers or constants from the code under test. A bug in a shared helper, or a changed constant, passes on both sides. `labels.test.ts` keeps its own map projection and its own 96×16 label box for this reason.
3. **If you can list every input, loop over all of them** instead of generating. In the app these came from, the filters had 96 combinations and the map 17 zoom levels, so one loop covered everything. Use the generator for inputs you can't list, such as positions and names.
4. **Break the code on purpose** and check that the test fails for the reason you expect. A test that can't fail checks nothing. In that app, the oracle tests caught 4 of 4 planted bugs; the existing example tests caught 1.

They fit logic with a rule you can state: "never overlap", "exactly once", "same answer as the simple version". They don't help with how a screen looks, and a plain example test is still the quickest way to document one specific case.

`pnpm test` runs the oracle tests with the lint-rule tests. `pnpm typecheck` checks the examples against `tsconfig/strict.json`. In your project, `pnpm add -D fast-check`.

## Tailwind theme lock

`eslint-plugin-better-tailwindcss` runs as an Oxlint JS plugin. Point `settings.better-tailwindcss.entryPoint` at the CSS file that owns `@theme`, and set `rootFontSize` to 16 unless the app changes the root font size.

| Rule | Job |
| --- | --- |
| `enforce-canonical-classes` | Same rewrite as the Tailwind editor warning (`leading-[1.5]` → `leading-normal`, `gap-[10px]` → `gap-2.5`) |
| `no-unnecessary-whitespace` | Cleans the extra spaces the canonical fixer leaves behind |
| `no-restricted-classes` | Bans arbitrary type, tracking, leading, shadow, and radius. Also bans spacing on `.25` / `.75` steps so the scale stays on a 2px grid |

The restrict patterns in `oxlint/tailwind-theme/oxlintrc.example.json` assume named tokens in `@theme`. Change the messages to match the tokens you actually ship.

## Evals

`evals/` asks whether this repo's rules change what an agent writes. One model implements a problem across checkpoints in one or more arms. `plain` is the template with no overlay. `lint` plants this repo's overlay. `lint-cc` is exactly that overlay plus `eslint/complexity` max 20 and `oxlint-plugin-complexity` cognitive complexity max 15. `lint-v2` is the overlay plus type-aware `no-unsafe-*` and `no-misused-promises`, a planted `src/reset.d.ts` that imports `@total-typescript/ts-reset`, CLI drops of `no-console` and `no-non-null-assertion`, and React drops of `no-async-state`, `no-boolean-state`, and `no-use-state`, replaced by `ai/no-url-state-copy`. Those deltas live on the arms table in `evals/lib.ts`. The agent sees them as extra or fewer rules in `.oxlintrc.json`. The arm name never appears in a workspace path or planted file. Function caps do not cover module-level code. The grader's `(module)` pseudo-function measures whether an agent moved logic to module scope to dodge the cap.

CLI problems (`ledger`, `tasks`) start from `evals/template`. The lint overlay is `oxlint/typescript` plus `tsconfig/strict.json`. Hidden checks run `src/cli.ts` against JSON cases.

React problems (`venues`, `signup`) start from `evals/template-react` (Vite, React 19, React Compiler, TanStack Query in both arms). The lint overlay is `oxlint/stack` minus Tailwind: the `ai/*` bans, `react/set-state-in-effect`, `react-you-might-not-need-an-effect/*`, architecture `no-restricted-imports`, and the TypeScript rules, plus `tsconfig/strict.json`. Hidden checks are vitest files that render the default export of `src/App.tsx` and stub `fetch`.

Hidden checks grade correctness. Outcome metrics (solved rates, complexity, size, cost) can move either way. Compliance metrics (lint hits, `tsc` errors, suppressions, whether `pnpm check` ran) only show that the lint arm followed the rules. The per-rule table includes `ai/*`, `react/*`, `react-you-might-not-need-an-effect/*`, and `no-restricted-imports`.

```sh
node evals/run.ts --problem ledger --arm plain --arm lint --reps 1 --model cursor-grok-4.6-high
node evals/grade.ts evals/runs/<timestamp>
node evals/grade.ts evals/runs/<timestamp> --baseline lint
```

Pass `--problem venues` or `--problem signup` for a React problem, `--problem tasks` for the other CLI problem, `--checkpoints K` to stop early, and `--out evals/runs/<dir>` to resume. Bundles land in `evals/runs/<timestamp>/`. `--timeout-min` (default 20) kills a session that runs too long. `--stall-min` (default 6) kills a session that prints no stdout for that many minutes and records `stalled`. The runner starts `cursor-agent` in its own process group and kills the group when the session ends, times out, or stalls, so leftover Vite or browser processes do not hold ports.

`summary.md` opens with a head-to-head table, one row per outcome metric. The baseline arm is `--baseline` (default `plain` if that arm is in the run, otherwise the first arm in the manifest). Each other arm gets its own table against that baseline, with delta (other minus baseline) and `overlap`. Overlap is yes when the two min-max ranges overlap, so that delta is noise. Two-arm plain vs lint output matches the old headings. The same table is repeated per checkpoint, because a gap that only appears later is the result that matters. Unused files, unused exports, and unused dependencies from knip are in that outcome table. Neither arm's rules target those. Failed, timed-out, or stalled agent calls are listed and still counted in the rates. Then compliance, then lint hits per rule. When `lint-cc` is in the run, a Complexity caps section lists per-workspace `ccMax`, `(module)` complexity, and statements.

Solved means every check of that checkpoint passed, including earlier checkpoints as regression. Iso-solved means the new checks passed even if regression failed.

```sh
node evals/grade.ts --self-check
```

That checks that each reference solution passes every hidden check and `pnpm check` under the lint arm. An empty `src/cli.ts` or an `App` that returns null fails every check. `pnpm typecheck` includes `evals/`.

Hidden JSON cases do not try long command sequences. `node evals/verify.ts --self-check` drives the tasks CLI with fast-check sequences and checks spec-stated state-machine properties. `node evals/verify.ts <runDir>` scores `tasks-*` snapshots at a checkpoint against the same baseline rule and writes `properties.jsonl` plus `properties.md`. See `.cursor/skills/verify-tasks-state-machine/SKILL.md`.

After `grade.ts`, score slop with an LLM judge. Grade must have written `results.jsonl` first, because flag rates are per 100 statements.

```sh
node evals/judge.ts evals/runs/<timestamp>
node evals/judge.ts evals/runs/<timestamp> --baseline lint
```

The default judge model is `gpt-5.6-sol-high`. It must not be grok, because the candidate is grok. Pass `--model` to change it and `--concurrency` (default 4) for parallel snapshots. The judge sees only `src/**` and the specs. It never sees the arm, the candidate model, or configs. Rerun the same command to resume. Snapshots already in `judge.jsonl` are skipped.

`evals/rubric.jsonl` is adapted from [SlopCodeBench](https://github.com/SprocketLab/slop-code-bench) (MIT). Language-neutral criteria stay. Python examples are TypeScript. Criteria that cannot occur in a small TS CLI or React app are dropped. Local criteria cover slop these rules cannot see, and React patterns the overlay already bans. Each criterion has `source` (`scbench` or `local`) and `rule`: the overlay rule ids that already ban that slop, or `null`. `slop.md` reports flags per 100 statements twice. The second row drops criteria whose `rule` is set, because the lint arm wins those by construction.

`slop.md` uses the same head-to-head table as `summary.md`, baseline vs each other arm. Read overlap the same way. It also lists new flags per checkpoint, counts by category, and pairwise preference. Pairwise shows both final `src/**` trees as Project A and Project B, in both orders, for the baseline vs each other arm. A win counts only when both orders agree. Disagreement is a tie. The qualitative section quotes flagged snippets so you can see what the judge meant.

Review each overlay rule as a senior reviewer would:

```sh
node evals/judge.ts --review evals/runs/<timestamp>
```

That reuses the judge model (default `gpt-5.6-sol-high`, never grok), blinding, resume, and `--concurrency`. Pass `--checkpoint N` to review that checkpoint instead of the final one. `--fresh` archives `review.jsonl` and `review.md`.

The yardstick is the union of every arm's rules. A rule's benefit side reviews its hits in arms that do not enforce it. Its cost side reviews workarounds in arms that do. On a plain-vs-lint run that is the old split: every yardstick hit on plain, workarounds on lint. Dropped lint-v2 rules are reviewed as hits in lint-v2 code. Added lint-v2 rules are reviewed as workarounds in lint-v2 code and as hits in lint code.

The reviewer sees about 20 lines of context, the whole file, the rule, and the specs. Benefit verdicts are `bug`, `fragile`, `style`, or `noise`. A `bug` must name an input a person can run. Cost verdicts are `better`, `same`, `worse`, or `bug`. Prompts list overlay rules and their messages from the repo configs and `oxlint/react-bans`, not the arm name.

On `lint-cc`, only the complexity rules count as the rule being satisfied. The reviewer judges splits, extracted helpers, and tables against one bigger function.

`review.md` has one table per rule with hit counts, `% bug` / `% fragile` / `% style` / `% noise`, workaround counts, `% better` / `% same` / `% worse` / `% bug`, a net verdict, and two or three examples per side. A plain-vs-lint run keeps the old "plain hits" / "Lint-arm" labels. The net verdict is computed:

- earns its place. At least one plain-arm `bug` or `fragile`, they are at least 15% of plain hits, and at most 25% of lint-arm workarounds are `worse` or `bug`. No workarounds counts as 0% harm.
- costs more than it catches. Lint-arm `worse`+`bug` outnumber plain-arm `bug`+`fragile`, or every plain hit is `style` or `noise` and there are no workarounds.
- neutral. Anything else.

`review.jsonl` holds every verdict. Rerun the same command to resume. Snapshots and hits already in the file are skipped.

Score candidate checks that neither arm enforced, on the same frozen snapshots, without new agent runs:

```sh
node evals/sweep.ts evals/runs/<timestamp>
node evals/sweep.ts evals/runs/<timestamp> --baseline lint
```

That writes `sweep.jsonl` (one row per workspace, checkpoint, and check), reviews up to 10 product hits per check per arm with the same benefit prompt as `--review` (default `gpt-5.6-sol-high`, never grok), replays CLI `bug` inputs, and writes `sweep.md`. Pass `--no-review` to skip the LLM. `node evals/sweep.ts --self-check` plants one known hit per check.

```sh
node evals/judge.ts --self-check
```

That runs the judge twice on planted slop in `evals/judge-fixture/` and prints recall, clean-file flags, and run-to-run agreement. It also checks the review parsers, overlay-rule catalog, and net-verdict rule.

