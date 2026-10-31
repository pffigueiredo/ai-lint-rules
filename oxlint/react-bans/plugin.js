import { eslintCompatPlugin } from '@oxlint/plugins'
import { noBannedReactReexport } from './no-banned-react-reexport.js'
import { noManualMemoization } from './no-manual-memoization.js'
import { noOverzealousDestructuring } from './no-overzealous-destructuring.js'
import { noUseEffect } from './no-use-effect.js'
import { noUseState } from './no-use-state.js'

const plugin = eslintCompatPlugin({
  meta: { name: 'ai' },
  rules: {
    'no-banned-react-reexport': noBannedReactReexport,
    'no-manual-memoization': noManualMemoization,
    'no-overzealous-destructuring': noOverzealousDestructuring,
    'no-use-effect': noUseEffect,
    'no-use-state': noUseState,
  },
})

export default plugin
