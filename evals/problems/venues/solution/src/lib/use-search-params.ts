import { useSyncExternalStore } from 'react'

const SEARCH_CHANGE = 'searchchange'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(SEARCH_CHANGE, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(SEARCH_CHANGE, onChange)
  }
}

function getSnapshot(): string {
  return window.location.search
}

function getServerSnapshot(): string {
  return ''
}

export function useSearchParams(): [URLSearchParams, (next: URLSearchParams) => void] {
  const search = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  function replace(next: URLSearchParams): void {
    const qs = next.toString()
    const url = qs === '' ? window.location.pathname : `${window.location.pathname}?${qs}`
    window.history.replaceState({}, '', url)
    window.dispatchEvent(new Event(SEARCH_CHANGE))
  }
  return [new URLSearchParams(search), replace]
}
