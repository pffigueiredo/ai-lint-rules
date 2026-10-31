import { eslintCompatPlugin } from '@oxlint/plugins'
import { maxOneBooleanState } from './max-one-boolean-state.js'
import { noAsyncState } from './no-async-state.js'
import { noBannedReactReexport } from './no-banned-react-reexport.js'
import { noManualMemoization } from './no-manual-memoization.js'
import { noOverzealousDestructuring } from './no-overzealous-destructuring.js'
import { noStateCopies } from './no-state-copies.js'
import { noUseEffect } from './no-use-effect.js'
import { noUseState } from './no-use-state.js'

const plugin = eslintCompatPlugin({
  meta: { name: 'ai' },
  rules: {
    'max-one-boolean-state': maxOneBooleanState,
    'no-async-state': noAsyncState,
    'no-banned-react-reexport': noBannedReactReexport,
    'no-manual-memoization': noManualMemoization,
    'no-overzealous-destructuring': noOverzealousDestructuring,
    'no-state-copies': noStateCopies,
    'no-use-effect': noUseEffect,
    'no-use-state': noUseState,
  },
})

export default plugin
