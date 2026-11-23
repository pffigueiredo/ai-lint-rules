import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function requestPath(input: RequestInfo | URL): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(href, 'http://localhost').pathname
}

export function requestMethod(init?: RequestInit): string {
  return (init?.method ?? 'GET').toUpperCase()
}

// Specs say "show" and "hide"; a node under `[hidden]` or `aria-hidden` is hidden even though queries still find it.
export function shown(el: Element | null): boolean {
  return el !== null && el.closest('[hidden], [aria-hidden="true"]') === null
}

export function setPath(path: string): void {
  window.history.replaceState({}, '', path)
}

export function renderApp(ui: ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return render(ui, { wrapper: Wrapper })
}
