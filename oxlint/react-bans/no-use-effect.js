import { defineReactImportBan } from './ban-react-imports.js'
import { BANNED_EFFECT_HOOKS } from './banned-hooks.js'

export const noUseEffect = defineReactImportBan({
  description: 'Disallow React useEffect and useLayoutEffect',
  hooks: BANNED_EFFECT_HOOKS,
  message:
    'Do not use React `{{name}}`. Derive state during render, update it in user interactions, or use an audited `src/lib/use-*.ts` hook seam.',
})
