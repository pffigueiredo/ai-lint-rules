# AI lint rules

A public reference of lint rules that keep agents and humans on the same rails.

Copy the files. Point Oxlint at them. Rename the plugin if you want. This is not an npm package.

The React bans started as the local Oxlint plugins in [KATTCORP/isbabyoutyet](https://github.com/KATTCORP/isbabyoutyet). The Tailwind lock is the config that kept a design theme from drifting back into arbitrary classes.

## Layout

- `oxlint/react-bans` — five Oxlint JS-plugin rules, with tests
- `oxlint/tailwind-theme` — `eslint-plugin-better-tailwindcss` config that canonicalizes classes and bans one-off tokens

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

```json
{
  "jsPlugins": ["./oxlint/react-bans/plugin.js"],
  "rules": {
    "ai/no-use-state": "error",
    "ai/no-use-effect": "error",
    "ai/no-manual-memoization": "error",
    "ai/no-banned-react-reexport": "error",
    "ai/no-overzealous-destructuring": "error"
  }
}
```

Needs `oxlint` and `@oxlint/plugins` at matching versions. The copies here were taken from `1.83.0`.

```sh
pnpm test
```

## Tailwind theme lock

`eslint-plugin-better-tailwindcss` runs as an Oxlint JS plugin. Point `settings.better-tailwindcss.entryPoint` at the CSS file that owns `@theme`, and set `rootFontSize` to 16 unless the app changes the root font size.

| Rule | Job |
| --- | --- |
| `enforce-canonical-classes` | Same rewrite as the Tailwind editor warning (`leading-[1.5]` → `leading-normal`, `gap-[10px]` → `gap-2.5`) |
| `no-unnecessary-whitespace` | Cleans the extra spaces the canonical fixer leaves behind |
| `no-restricted-classes` | Bans arbitrary type, tracking, leading, shadow, and radius. Also bans spacing on `.25` / `.75` steps so the scale stays on a 2px grid |

The restrict patterns in `oxlint/tailwind-theme/oxlintrc.example.json` assume named tokens in `@theme`. Change the messages to match the tokens you actually ship.

```json
{
  "jsPlugins": ["eslint-plugin-better-tailwindcss"],
  "settings": {
    "better-tailwindcss": { "entryPoint": "src/styles/app.css", "rootFontSize": 16 }
  }
}
```
