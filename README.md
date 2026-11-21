# AI lint rules

A public reference of lint rules that keep agents and humans on the same rails.

Copy the files. Point Oxlint at them. Rename the plugin if you want. This is not an npm package.

The React bans started as the local Oxlint plugins in [KATTCORP/isbabyoutyet](https://github.com/KATTCORP/isbabyoutyet). The rest is the stack that locked a small React Compiler app: typed boundaries, no floating promises, no derived state in effects, and a token-locked Tailwind theme.

## Layout

- `oxlint/react-bans` — eight Oxlint JS-plugin rules, with tests: five hook bans and three state rules
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
| `ai/no-overzealous-destructuring` | Destructuring a field used fewer than three times |

Shareable UI state goes in the URL. Derived state comes from queries or mutations. Effects and subscriptions live behind audited `src/lib/use-*.ts` hooks. The example config turns the state and effect rules off for that glob.

## State rules

For wherever `useState` is allowed: a project without `ai/no-use-state`, or the `src/lib/use-*` hooks that are exempt from it. They ban the three shapes unnecessary state usually takes. A lint rule can't judge what state means, only how it's written, so each rule targets one shape that is almost always the wrong version.

| Rule | Blocks | Fix |
| --- | --- | --- |
| `ai/no-async-state` | A state setter called in an `async` function, in `.then` / `.catch` / `.finally`, or in a query's `onSuccess` / `onError` / `onSettled` | Read `status`, `data` and `error` from `useQuery` / `useMutation`. `status` is already `'idle' \| 'pending' \| 'success' \| 'error'`. |
| `ai/no-boolean-state` | Any boolean in `useState`: `false`, `!x`, `Boolean(x)`, `x > 0`, `<boolean>`, and boolean fields of an object (`useState({ editing: false })`) | Let the browser own open/closed (`<details>`, `popover`, `<dialog>`), the form own checkboxes (read `FormData` on submit), and TanStack Query own async status. Name anything else as a union: `useState<'view' \| 'editing'>('view')`. |
| `ai/no-state-copies` | `useState(props.venue)`, and `setSelected(v)` where `v` is an item from `.map` / `.find` / `.forEach` | Read the prop directly, or name it `initial…` / `default…` if it's a starting draft. Store the item's key and look it up during render. |

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
| `no-console` | `console.*` in app code. Leave it on in `tools/**`. |
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

`evals/` asks whether this repo's rules change what an agent writes. One model implements a problem across checkpoints, once in a plain workspace (`plain`) and once with this repo's overlay (`lint`).

CLI problems (`ledger`, `tasks`) start from `evals/template`. The lint overlay is `oxlint/typescript` plus `tsconfig/strict.json`. Hidden checks run `src/cli.ts` against JSON cases.

React problems (`venues`, `signup`) start from `evals/template-react` (Vite, React 19, React Compiler, TanStack Query in both arms). The lint overlay is `oxlint/stack` minus Tailwind: the `ai/*` bans, `react/set-state-in-effect`, `react-you-might-not-need-an-effect/*`, architecture `no-restricted-imports`, and the TypeScript rules, plus `tsconfig/strict.json`. Hidden checks are vitest files that render the default export of `src/App.tsx` and stub `fetch`.

Hidden checks grade correctness. Outcome metrics (solved rates, complexity, size, cost) can move either way. Compliance metrics (lint hits, `tsc` errors, suppressions, whether `pnpm check` ran) only show that the lint arm followed the rules. The per-rule table includes `ai/*`, `react/*`, `react-you-might-not-need-an-effect/*`, and `no-restricted-imports`.

```sh
node evals/run.ts --problem ledger --arm plain --arm lint --reps 1 --model cursor-grok-4.6-high
node evals/grade.ts evals/runs/<timestamp>
```

Pass `--problem venues` or `--problem signup` for a React problem, `--problem tasks` for the other CLI problem, `--checkpoints K` to stop early, and `--out evals/runs/<dir>` to resume. Bundles land in `evals/runs/<timestamp>/`. `--timeout-min` (default 20) kills a session that runs too long. `--stall-min` (default 6) kills a session that prints no stdout for that many minutes and records `stalled`. The runner starts `cursor-agent` in its own process group and kills the group when the session ends, times out, or stalls, so leftover Vite or browser processes do not hold ports.

`summary.md` opens with a head-to-head table, one row per outcome metric, with plain, lint, delta (lint minus plain), and `overlap`. Overlap is yes when the two min-max ranges overlap, so that delta is noise. The same table is repeated per checkpoint, because a gap that only appears later is the result that matters. Failed, timed-out, or stalled agent calls are listed and still counted in the rates. Then compliance, then lint hits per rule.

Solved means every check of that checkpoint passed, including earlier checkpoints as regression. Iso-solved means the new checks passed even if regression failed.

```sh
node evals/grade.ts --self-check
```

That checks that each reference solution passes every hidden check and `pnpm check` under the lint arm. An empty `src/cli.ts` or an `App` that returns null fails every check. `pnpm typecheck` includes `evals/`.

After `grade.ts`, score slop with an LLM judge. Grade must have written `results.jsonl` first, because flag rates are per 100 statements.

```sh
node evals/judge.ts evals/runs/<timestamp>
```

The default judge model is `gpt-5.6-sol-high`. It must not be grok, because the candidate is grok. Pass `--model` to change it and `--concurrency` (default 4) for parallel snapshots. The judge sees only `src/**` and the specs. It never sees the arm, the candidate model, or configs. Rerun the same command to resume. Snapshots already in `judge.jsonl` are skipped.

`evals/rubric.jsonl` is adapted from [SlopCodeBench](https://github.com/SprocketLab/slop-code-bench) (MIT). Language-neutral criteria stay. Python examples are TypeScript. Criteria that cannot occur in a small TS CLI or React app are dropped. Local criteria cover slop these rules cannot see, and React patterns the overlay already bans. Each criterion has `source` (`scbench` or `local`) and `rule`: the overlay rule ids that already ban that slop, or `null`. `slop.md` reports flags per 100 statements twice. The second row drops criteria whose `rule` is set, because the lint arm wins those by construction.

`slop.md` uses the same head-to-head table as `summary.md`. Read overlap the same way. It also lists new flags per checkpoint, counts by category, and pairwise preference. Pairwise shows both final `src/**` trees as Project A and Project B, in both orders. A win counts only when both orders agree. Disagreement is a tie. The qualitative section quotes flagged snippets so you can see what the judge meant.

Review each overlay rule as a senior reviewer would:

```sh
node evals/judge.ts --review evals/runs/<timestamp>
```

That reuses the judge model (default `gpt-5.6-sol-high`, never grok), blinding, resume, and `--concurrency`. Pass `--checkpoint N` to review that checkpoint instead of the final one. `--fresh` archives `review.jsonl` and `review.md`.

On the plain arm, the reviewer sees every yardstick oxlint error (the same config `grade.ts` uses, minus the metrics plugin and `eslint/complexity`), about 20 lines of context, the whole file, the rule, and the specs. Verdicts are `bug`, `fragile`, `style`, or `noise`. A `bug` must name an input a person can run.

On the lint arm, the reviewer sees the overlay rules and their messages from the repo configs and `oxlint/react-bans`, not the arm name. They mark workarounds `better`, `same`, `worse`, or `bug`.

`review.md` has one table per rule with plain-hit counts, `% bug` / `% fragile` / `% style` / `% noise`, lint-arm workaround counts, `% better` / `% same` / `% worse` / `% bug`, a net verdict, and two or three examples per side. The net verdict is computed:

- **earns its place:** at least one plain-arm `bug` or `fragile`, they are at least 15% of plain hits, and at most 25% of lint-arm workarounds are `worse` or `bug`. No workarounds counts as 0% harm.
- **costs more than it catches:** lint-arm `worse`+`bug` outnumber plain-arm `bug`+`fragile`, or every plain hit is `style` or `noise` and there are no workarounds.
- **neutral:** anything else.

`review.jsonl` holds every verdict. Rerun the same command to resume. Snapshots and hits already in the file are skipped.

```sh
node evals/judge.ts --self-check
```

That runs the judge twice on planted slop in `evals/judge-fixture/` and prints recall, clean-file flags, and run-to-run agreement. It also checks the review parsers, overlay-rule catalog, and net-verdict rule.

