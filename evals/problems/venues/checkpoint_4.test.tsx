import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestMethod, requestPath, setPath } from './render-app.tsx'

const MOONLIGHT = { id: 'v1', name: 'Moonlight', city: 'Lisbon', open: true }
const HARBOR = { id: 'v2', name: 'Harbor', city: 'Porto', open: false }
const ATLAS = { id: 'v3', name: 'Atlas', city: 'Lisbon', open: true }
const ALL = [MOONLIGHT, HARBOR, ATLAS]

function searchOf(input: RequestInfo | URL): URLSearchParams {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(href, 'http://localhost').searchParams
}

function deferred(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function listCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => requestPath(input as RequestInfo | URL) === '/api/venues')
}

function stubPaged(
  handler: (q: string, page: number) => { body: unknown; status?: number } | Promise<Response>,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      const method = requestMethod(init)
      if (path === '/api/favorites' && method === 'GET') return jsonResponse({ ids: [] })
      if (path !== '/api/venues' || method !== 'GET') return jsonResponse({ error: 'missing' }, 404)
      const q = searchOf(input).get('q') ?? ''
      const pageRaw = searchOf(input).get('page')
      const page = pageRaw === null ? 1 : Number(pageRaw)
      const result = handler(q, page)
      if (result instanceof Promise) return result
      return jsonResponse(result.body, result.status ?? 200)
    }),
  )
}

beforeEach(() => {
  setPath('/')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setPath('/')
})

describe('core', () => {
  it('requests page 1 for the current Search value and lists those venues', async () => {
    stubPaged((q, page) => {
      if (page !== 1) return { body: { venues: [], nextPage: null } }
      if (q === '') return { body: { venues: ALL, nextPage: null } }
      if (q === 'lis') return { body: { venues: [MOONLIGHT, ATLAS], nextPage: null } }
      return { body: { venues: [], nextPage: null } }
    })
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'lis' } })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Atlas' })).toBeTruthy()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    await waitFor(() => {
      const hit = listCalls(fetchMock).some(([input]) => {
        const s = searchOf(input as RequestInfo | URL)
        return s.get('q') === 'lis' && s.get('page') === '1'
      })
      expect(hit).toBe(true)
    })
  })

  it('keeps the newer Search list when an older response arrives later', async () => {
    const li = deferred()
    const lis = deferred()
    stubPaged((q, page) => {
      if (page !== 1) return { body: { venues: [], nextPage: null } }
      if (q === '') return { body: { venues: ALL, nextPage: null } }
      if (q === 'li') return li.promise
      if (q === 'lis') return lis.promise
      return { body: { venues: [], nextPage: null } }
    })
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'li' } })
    await waitFor(() => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
      expect(listCalls(fetchMock).some(([input]) => searchOf(input as RequestInfo | URL).get('q') === 'li')).toBe(true)
    })
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'lis' } })
    await waitFor(() => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
      expect(listCalls(fetchMock).some(([input]) => searchOf(input as RequestInfo | URL).get('q') === 'lis')).toBe(true)
    })
    await act(async () => {
      lis.resolve(jsonResponse({ venues: [MOONLIGHT], nextPage: null }))
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Atlas' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
    await act(async () => {
      li.resolve(jsonResponse({ venues: [MOONLIGHT, ATLAS], nextPage: null }))
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Atlas' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
  })

  it('appends the next page from Load more', async () => {
    stubPaged((q, page) => {
      if (q !== '') return { body: { venues: [], nextPage: null } }
      if (page === 1) return { body: { venues: [MOONLIGHT], nextPage: 2 } }
      if (page === 2) return { body: { venues: [HARBOR], nextPage: null } }
      return { body: { venues: [], nextPage: null } }
    })
    const user = userEvent.setup()
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    })
  })

  it('replaces loaded pages when Search changes', async () => {
    stubPaged((q, page) => {
      if (q === '' && page === 1) return { body: { venues: [MOONLIGHT], nextPage: 2 } }
      if (q === '' && page === 2) return { body: { venues: [HARBOR], nextPage: null } }
      if (q === 'lis' && page === 1) return { body: { venues: [ATLAS], nextPage: null } }
      return { body: { venues: [], nextPage: null } }
    })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'lis' } })
    expect(await screen.findByRole('button', { name: 'Atlas' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Moonlight' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
  })

  it('requests the URL Search value on load', async () => {
    setPath('/?q=por')
    stubPaged((q, page) => {
      if (q === 'por' && page === 1) return { body: { venues: [HARBOR], nextPage: null } }
      return { body: { venues: ALL, nextPage: null } }
    })
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Moonlight' })).toBeNull()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const hit = listCalls(fetchMock).some(([input]) => searchOf(input as RequestInfo | URL).get('q') === 'por')
    expect(hit).toBe(true)
  })

  it('hides Load more when nextPage is null', async () => {
    stubPaged(() => ({ body: { venues: [MOONLIGHT], nextPage: null } }))
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })
})

describe('error', () => {
  it('alerts when page 1 of the current Search fails', async () => {
    stubPaged((q, page) => {
      if (q === '' && page === 1) return { body: { venues: ALL, nextPage: null } }
      if (q === 'lis' && page === 1) return { body: { venues: [] }, status: 500 }
      return { body: { venues: [], nextPage: null } }
    })
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'lis' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not load venues')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Moonlight' })).toBeNull()
  })

  it('keeps page 1 and alerts when Load more fails', async () => {
    stubPaged((q, page) => {
      if (q !== '') return { body: { venues: [], nextPage: null } }
      if (page === 1) return { body: { venues: [MOONLIGHT], nextPage: 2 } }
      return { body: { venues: [] }, status: 500 }
    })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not load more')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
  })

  it('ignores a late next page from a previous Search', async () => {
    const page2 = deferred()
    stubPaged((q, page) => {
      if (q === '' && page === 1) return { body: { venues: [MOONLIGHT], nextPage: 2 } }
      if (q === '' && page === 2) return page2.promise
      if (q === 'lis' && page === 1) return { body: { venues: [ATLAS], nextPage: null } }
      return { body: { venues: [], nextPage: null } }
    })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'lis' } })
    expect(await screen.findByRole('button', { name: 'Atlas' })).toBeTruthy()
    await act(async () => {
      page2.resolve(jsonResponse({ venues: [HARBOR], nextPage: null }))
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Atlas' })).toBeTruthy()
  })
})

describe('functionality', () => {
  it('sends page=1 and omits q when Search is empty', async () => {
    stubPaged(() => ({ body: { venues: ALL, nextPage: null } }))
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const first = listCalls(fetchMock)[0]
    expect(first).toBeTruthy()
    const s = searchOf(first?.[0] as RequestInfo | URL)
    expect(s.get('page')).toBe('1')
    expect(s.get('q')).toBeNull()
  })

  it('Load more requests the current q and next page number', async () => {
    stubPaged((q, page) => {
      if (q === 'lis' && page === 1) return { body: { venues: [MOONLIGHT], nextPage: 2 } }
      if (q === 'lis' && page === 2) return { body: { venues: [ATLAS], nextPage: null } }
      if (q === '') return { body: { venues: ALL, nextPage: null } }
      return { body: { venues: [], nextPage: null } }
    })
    const user = userEvent.setup()
    setPath('/?q=lis')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('button', { name: 'Atlas' })).toBeTruthy()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const page2 = listCalls(fetchMock).filter(([input]) => searchOf(input as RequestInfo | URL).get('page') === '2')
    expect(page2.length).toBeGreaterThan(0)
    expect(searchOf(page2[0]?.[0] as RequestInfo | URL).get('q')).toBe('lis')
  })

  it('still hides closed venues when Open now is checked', async () => {
    stubPaged(() => ({ body: { venues: ALL, nextPage: null } }))
    const user = userEvent.setup()
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    await user.click(screen.getByLabelText('Open now'))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
  })

  it('shows No venues when the current Search page is empty', async () => {
    stubPaged((q) => {
      if (q === '') return { body: { venues: ALL, nextPage: null } }
      return { body: { venues: [], nextPage: null } }
    })
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz' } })
    expect(await screen.findByText('No venues')).toBeTruthy()
  })

  it('hides Load more while a newer Search is in flight', async () => {
    const next = deferred()
    stubPaged((q, page) => {
      if (q === '' && page === 1) return { body: { venues: [MOONLIGHT], nextPage: 2 } }
      if (q === 'lis' && page === 1) return next.promise
      return { body: { venues: [], nextPage: null } }
    })
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'lis' } })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    })
    next.resolve(jsonResponse({ venues: [MOONLIGHT], nextPage: 3 }))
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeTruthy()
  })
})
