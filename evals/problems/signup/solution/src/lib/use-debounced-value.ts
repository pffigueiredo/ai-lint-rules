import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(initialValue: T, delay: number): T {
  const [debounced, setDebounced] = useState(initialValue)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(initialValue), delay)
    return () => window.clearTimeout(id)
  }, [initialValue, delay])
  return debounced
}
