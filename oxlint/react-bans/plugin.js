import { eslintCompatPlugin } from '@oxlint/plugins'
import { noAsyncState } from './no-async-state.js'
import { noBannedReactReexport } from './no-banned-react-reexport.js'
import { noBooleanState } from './no-boolean-state.js'
import { noManualMemoization } from './no-manual-memoization.js'
import { noStateCopies } from './no-state-copies.js'
import { noUrlStateCopy } from './no-url-state-copy.js'
import { noUseEffect } from './no-use-effect.js'
import { noUseState } from './no-use-state.js'
import { urlStateInLib } from './url-state-in-lib.js'

const plugin = eslintCompatPlugin({
  meta: { name: 'ai' },
  rules: {
    'no-async-state': noAsyncState,
    'no-banned-react-reexport': noBannedReactReexport,
    'no-boolean-state': noBooleanState,
    'no-manual-memoization': noManualMemoization,
    'no-state-copies': noStateCopies,
    'no-url-state-copy': noUrlStateCopy,
    'no-use-effect': noUseEffect,
    'no-use-state': noUseState,
    'url-state-in-lib': urlStateInLib,
  },
})

export default plugin
