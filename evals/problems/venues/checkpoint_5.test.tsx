import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestMethod, requestPath, setPath } from './render-app.tsx'

const MOONLIGHT = {
  id: 'v1',
  name: 'Moonlight',
  city: 'Lisbon',
  open: true,
  description: 'Rooftop in Bairro Alto.',
  hours: '22:00-04:00',
}
const HARBOR = {
  id: 'v2',
  name: 'Harbor',
  city: 'Porto',
  open: false,
  description: 'Dockside room.',
  hours: '21:00-03:00',
}

function deferred(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function stubFavs(opts: {
  ids?: string[]
  favsStatus?: number
  post?: Promise<Response> | number
  del?: Promise<Response> | number
}): void {
  const ids = opts.ids ?? []
  const favsStatus = opts.favsStatus ?? 200
  const post = opts.post ?? 200
  const del = opts.del ?? 200
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      const method = requestMethod(init)
      if (path === '/api/venues' && method === 'GET') {
        return jsonResponse({ venues: [MOONLIGHT, HARBOR], nextPage: null })
      }
      if (path === '/api/venues/v1' && method === 'GET') return jsonResponse(MOONLIGHT)
      if (path === '/api/venues/v2' && method === 'GET') return jsonResponse(HARBOR)
      if (path === '/api/favorites' && method === 'GET') return jsonResponse({ ids }, favsStatus)
      if (path === '/api/favorites/v1' && method === 'POST') {
        return typeof post === 'number' ? jsonResponse({ ok: true }, post) : post
      }
      if (path === '/api/favorites/v2' && method === 'POST') return jsonResponse({ ok: true })
      if (path === '/api/favorites/v1' && method === 'DELETE') {
        return typeof del === 'number' ? jsonResponse({ ok: true }, del) : del
      }
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
  it('turns Save into Unsave before POST finishes', async () => {
    const post = deferred()
    stubFavs({ post: post.promise })
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(screen.getByRole('button', { name: 'Unsave' })).toBeTruthy()
    expect(screen.getByText('Saved: 1')).toBeTruthy()
    post.resolve(jsonResponse({ ok: true }))
    expect(await screen.findByRole('button', { name: 'Unsave' })).toBeTruthy()
  })

  it('decrements the header before DELETE finishes', async () => {
    const del = deferred()
    stubFavs({ ids: ['v1'], del: del.promise })
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    expect(await screen.findByText('Saved: 1')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Unsave' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByText('Saved: 0')).toBeTruthy()
    del.resolve(jsonResponse({ ok: true }))
    await waitFor(() => {
      expect(screen.getByText('Saved: 0')).toBeTruthy()
    })
  })

  it('rolls Save back and alerts when POST fails', async () => {
    stubFavs({ post: 500 })
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not save')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByText('Saved: 0')).toBeTruthy()
  })

  it('rolls Unsave back and alerts when DELETE fails', async () => {
    stubFavs({ ids: ['v1'], del: 500 })
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Unsave' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not unsave')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unsave' })).toBeTruthy()
    expect(screen.getByText('Saved: 1')).toBeTruthy()
  })

  it('ignores a failed POST after a later Unsave click', async () => {
    const post = deferred()
    const del = deferred()
    stubFavs({ post: post.promise, del: del.promise })
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(screen.getByText('Saved: 1')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Unsave' }))
    expect(screen.getByText('Saved: 0')).toBeTruthy()
    post.resolve(jsonResponse({ ok: true }, 500))
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByText('Saved: 0')).toBeTruthy()
    del.resolve(jsonResponse({ ok: true }, 500))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not unsave')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unsave' })).toBeTruthy()
    expect(screen.getByText('Saved: 1')).toBeTruthy()
  })

  it('restores Unsave and the header from GET /api/favorites', async () => {
    stubFavs({ ids: ['v1'] })
    setPath('/?venue=v1')
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Unsave' })).toBeTruthy()
    expect(screen.getByText('Saved: 1')).toBeTruthy()
  })

  it('keeps an older successful POST from changing a later Unsave', async () => {
    const post = deferred()
    const del = deferred()
    stubFavs({ post: post.promise, del: del.promise })
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    await user.click(screen.getByRole('button', { name: 'Unsave' }))
    post.resolve(jsonResponse({ ok: true }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    })
    expect(screen.getByText('Saved: 0')).toBeTruthy()
    del.resolve(jsonResponse({ ok: true }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    })
  })
})

describe('error', () => {
  it('shows Saved: 0 when GET /api/favorites fails and still allows Save', async () => {
    stubFavs({ favsStatus: 500, post: 200 })
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    expect(await screen.findByText('Saved: 0')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('button', { name: 'Unsave' })).toBeTruthy()
    expect(screen.getByText('Saved: 1')).toBeTruthy()
  })

  it('does not alert when GET /api/favorites fails', async () => {
    stubFavs({ favsStatus: 500 })
    setPath('/?venue=v1')
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('functionality', () => {
  it('POSTs to /api/favorites/v1', async () => {
    stubFavs({})
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Unsave' })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const post = fetchMock.mock.calls.find(([input, init]) => {
      return requestPath(input as RequestInfo | URL) === '/api/favorites/v1' && requestMethod(init as RequestInit) === 'POST'
    })
    expect(post).toBeTruthy()
  })

  it('DELETEs /api/favorites/v1', async () => {
    stubFavs({ ids: ['v1'] })
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Unsave' }))
    await screen.findByRole('button', { name: 'Save' })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const del = fetchMock.mock.calls.find(([input, init]) => {
      return (
        requestPath(input as RequestInfo | URL) === '/api/favorites/v1' && requestMethod(init as RequestInit) === 'DELETE'
      )
    })
    expect(del).toBeTruthy()
  })

  it('counts a second saved venue as Saved: 2', async () => {
    stubFavs({})
    const user = userEvent.setup()
    setPath('/?venue=v1')
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved: 1')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Harbor' }))
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved: 2')).toBeTruthy()
  })

  it('shows Saved: 0 when ids is empty', async () => {
    stubFavs({ ids: [] })
    renderApp(<App />)
    expect(await screen.findByText('Saved: 0')).toBeTruthy()
  })

  it('does not count a duplicate id twice', async () => {
    stubFavs({ ids: ['v1', 'v1'] })
    setPath('/?venue=v1')
    renderApp(<App />)
    expect(await screen.findByText('Saved: 1')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Unsave' })).toBeTruthy()
  })
})
