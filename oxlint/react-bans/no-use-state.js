import { defineReactImportBan } from './ban-react-imports.js'
import { BANNED_STATE_HOOKS } from './banned-hooks.js'

export const noUseState = defineReactImportBan({
  description: 'Disallow React local-state hooks in feature application code',
  hooks: BANNED_STATE_HOOKS,
  message:
    'Do not use React `{{name}}`. Put shareable UI state in the URL, derive it from queries/mutations, or use an uncontrolled component trigger; audited `src/lib/use-*.ts` hooks may own local state and external-store subscriptions.',
})
