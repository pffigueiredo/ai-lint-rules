import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestMethod, requestPath, setPath } from './render-app.tsx'

const VENUES = [
  { id: 'v1', name: 'Moonlight', city: 'Lisbon', open: true },
  { id: 'v2', name: 'Harbor', city: 'Porto', open: false },
]

const DETAILS = {
  v1: {
    id: 'v1',
    name: 'Moonlight',
    city: 'Lisbon',
    open: true,
    description: 'Rooftop in Bairro Alto.',
    hours: '22:00-04:00',
  },
  v2: {
    id: 'v2',
    name: 'Harbor',
    city: 'Porto',
    open: false,
    description: 'Dockside room.',
    hours: '21:00-03:00',
  },
}

function stubApi(opts?: { detailStatus?: number; favoriteStatus?: number }): void {
  const detailStatus = opts?.detailStatus ?? 200
  const favoriteStatus = opts?.favoriteStatus ?? 200
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      const method = requestMethod(init)
      if (path === '/api/venues' && method === 'GET') return jsonResponse({ venues: VENUES })
      if (path === '/api/venues/v1' && method === 'GET') {
        return jsonResponse(DETAILS.v1, detailStatus)
      }
      if (path === '/api/venues/v2' && method === 'GET') {
        return jsonResponse(DETAILS.v2, detailStatus)
      }
      if (path === '/api/favorites' && method === 'GET') return jsonResponse({ ids: [] })
      if (path === '/api/favorites/v1' && method === 'POST') {
        return jsonResponse({ ok: true }, favoriteStatus)
      }
      return jsonResponse({ error: 'missing' }, 404)
    }),
  )
}

function query(): URLSearchParams {
  return new URLSearchParams(window.location.search)
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
  it('opens details from a list click and stores venue in the URL', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Moonlight' }))
    await waitFor(() => {
      expect(query().get('venue')).toBe('v1')
    })
    expect(await screen.findByRole('region', { name: 'Venue details' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Moonlight' })).toBeTruthy()
  })

  it('restores details from venue in the URL', async () => {
    setPath('/?venue=v2')
    stubApi()
    renderApp(<App />)
    expect(await screen.findByRole('heading', { name: 'Harbor' })).toBeTruthy()
  })

  it('shows Unsave after a successful save', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Moonlight' }))
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('button', { name: 'Unsave' })).toBeTruthy()
  })
})

describe('error', () => {
  it('alerts when venue details fail to load', async () => {
    setPath('/?venue=v1')
    stubApi({ detailStatus: 500 })
    renderApp(<App />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not load venue')).toBeTruthy()
  })

  it('alerts when save fails', async () => {
    stubApi({ favoriteStatus: 500 })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Moonlight' }))
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not save')).toBeTruthy()
  })
})

describe('functionality', () => {
  it('shows description and hours', async () => {
    setPath('/?venue=v1')
    stubApi()
    renderApp(<App />)
    expect(await screen.findByText('Rooftop in Bairro Alto.')).toBeTruthy()
    expect(screen.getByText('22:00-04:00')).toBeTruthy()
  })

  it('posts to /api/favorites/v1', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Moonlight' }))
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Unsave' })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const post = fetchMock.mock.calls.find(([input, init]) => {
      return requestPath(input as RequestInfo | URL) === '/api/favorites/v1' && requestMethod(init as RequestInit) === 'POST'
    })
    expect(post).toBeTruthy()
  })
})
