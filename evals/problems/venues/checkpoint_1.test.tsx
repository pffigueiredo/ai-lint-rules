import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import App from './src/App'
import { jsonResponse, renderApp, requestPath, setPath } from './render-app.tsx'

const VENUES = [
  { id: 'v1', name: 'Moonlight', city: 'Lisbon', open: true },
  { id: 'v2', name: 'Harbor', city: 'Porto', open: false },
]

function stubList(result: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (requestPath(input) === '/api/venues') return jsonResponse(result, status)
      if (requestPath(input) === '/api/favorites') return jsonResponse({ ids: [] })
      return jsonResponse({ error: 'missing' }, 404)
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
  it('shows loading text while the list request is in flight', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>(r => {
      resolve = r
    })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    renderApp(<App />)
    expect(await screen.findByText('Loading venues')).toBeTruthy()
    resolve(jsonResponse({ venues: VENUES }))
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
  })

  it('lists venue names as buttons', async () => {
    stubList({ venues: VENUES })
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Harbor' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows an empty message when there are no venues', async () => {
    stubList({ venues: [] })
    renderApp(<App />)
    expect(await screen.findByText('No venues')).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})

describe('error', () => {
  it('alerts when the list response is not OK', async () => {
    stubList({ venues: [] }, 500)
    renderApp(<App />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not load venues')).toBeTruthy()
  })

  it('alerts when the list request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    )
    renderApp(<App />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not load venues')).toBeTruthy()
  })
})

describe('functionality', () => {
  it('shows each venue city', async () => {
    stubList({ venues: VENUES })
    renderApp(<App />)
    expect(await screen.findByText('Lisbon')).toBeTruthy()
    expect(screen.getAllByText('Porto').length).toBeGreaterThan(0)
  })
})
