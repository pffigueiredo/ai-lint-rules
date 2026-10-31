export const BANNED_STATE_HOOKS = Object.freeze(
  new Set(['useState', 'useReducer', 'useActionState', 'useOptimistic', 'useSyncExternalStore']),
)

export const BANNED_EFFECT_HOOKS = Object.freeze(new Set(['useEffect', 'useLayoutEffect']))

export const BANNED_MEMO_HOOKS = Object.freeze(new Set(['useMemo', 'useCallback']))

export const BANNED_FEATURE_HOOKS = Object.freeze(
  new Set([...BANNED_STATE_HOOKS, ...BANNED_EFFECT_HOOKS, ...BANNED_MEMO_HOOKS]),
)
