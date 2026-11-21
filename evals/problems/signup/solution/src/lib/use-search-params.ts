import { useEffect, useState } from 'react'

function read(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

export function useSearchParams(): [URLSearchParams, (next: URLSearchParams) => void] {
  const [params, setParams] = useState(read)
  useEffect(() => {
    const onPop = () => setParams(read())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  function replace(next: URLSearchParams): void {
    const qs = next.toString()
    const url = qs === '' ? window.location.pathname : `${window.location.pathname}?${qs}`
    window.history.replaceState({}, '', url)
    setParams(new URLSearchParams(next))
  }
  return [params, replace]
}

export function writeParam(params: URLSearchParams, key: string, value: string | null): URLSearchParams {
  const next = new URLSearchParams(params)
  if (value === null || value === '') next.delete(key)
  else next.set(key, value)
  return next
}
