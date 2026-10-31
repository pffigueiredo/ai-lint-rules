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
- `oxlint/stack` — all of the above in one `.oxlintrc.json`

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

## Tailwind theme lock

`eslint-plugin-better-tailwindcss` runs as an Oxlint JS plugin. Point `settings.better-tailwindcss.entryPoint` at the CSS file that owns `@theme`, and set `rootFontSize` to 16 unless the app changes the root font size.

| Rule | Job |
| --- | --- |
| `enforce-canonical-classes` | Same rewrite as the Tailwind editor warning (`leading-[1.5]` → `leading-normal`, `gap-[10px]` → `gap-2.5`) |
| `no-unnecessary-whitespace` | Cleans the extra spaces the canonical fixer leaves behind |
| `no-restricted-classes` | Bans arbitrary type, tracking, leading, shadow, and radius. Also bans spacing on `.25` / `.75` steps so the scale stays on a 2px grid |

The restrict patterns in `oxlint/tailwind-theme/oxlintrc.example.json` assume named tokens in `@theme`. Change the messages to match the tokens you actually ship.
