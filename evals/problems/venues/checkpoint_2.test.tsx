import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestPath, setPath } from './render-app.tsx'

const VENUES = [
  { id: 'v1', name: 'Moonlight', city: 'Lisbon', open: true },
  { id: 'v2', name: 'Harbor', city: 'Porto', open: false },
  { id: 'v3', name: 'Atlas', city: 'Lisbon', open: true },
]

function searchOf(input: RequestInfo | URL): URLSearchParams {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(href, 'http://localhost').searchParams
}

function stubList(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input)
      if (path === '/api/favorites') return jsonResponse({ ids: [] })
      if (path === '/api/venues') {
        const q = (searchOf(input).get('q') ?? '').toLowerCase()
        const venues =
          q === ''
            ? VENUES
            : VENUES.filter(v => v.name.toLowerCase().includes(q) || v.city.toLowerCase().includes(q))
        return jsonResponse({ venues })
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
  it('filters the list by the search box', async () => {
    stubList()
    const user = userEvent.setup()
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    await user.type(screen.getByLabelText('Search'), 'lis')
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Atlas' })).toBeTruthy()
  })

  it('keeps only open venues when Open now is checked', async () => {
    stubList()
    const user = userEvent.setup()
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    await user.click(screen.getByLabelText('Open now'))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Atlas' })).toBeTruthy()
  })

  it('restores search and open from the URL', async () => {
    setPath('/?q=lis&open=1')
    stubList()
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
    const box = screen.getByLabelText('Search')
    expect((box as HTMLInputElement).value).toBe('lis')
    expect((screen.getByLabelText('Open now') as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
  })

  it('sorts by city then id when Sort is City', async () => {
    stubList()
    const user = userEvent.setup()
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Atlas' })).toBeTruthy()
    await user.selectOptions(screen.getByLabelText('Sort'), 'City')
    await waitFor(() => {
      expect(query().get('sort')).toBe('city')
    })
    const names = screen.getAllByRole('button').map(el => el.textContent)
    expect(names).toEqual(['Moonlight', 'Atlas', 'Harbor'])
  })
})

describe('error', () => {
  it('still alerts when the list request fails with filters in the URL', async () => {
    setPath('/?q=lis')
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
  it('writes q to the URL as the user types', async () => {
    stubList()
    const user = userEvent.setup()
    renderApp(<App />)
    await screen.findByLabelText('Search')
    await user.type(screen.getByLabelText('Search'), 'por')
    await waitFor(() => {
      expect(query().get('q')).toBe('por')
    })
  })

  it('writes open=1 to the URL when Open now is checked', async () => {
    stubList()
    const user = userEvent.setup()
    renderApp(<App />)
    await screen.findByLabelText('Open now')
    await user.click(screen.getByLabelText('Open now'))
    await waitFor(() => {
      expect(query().get('open')).toBe('1')
    })
  })

  it('removes q when Search is cleared', async () => {
    stubList()
    const user = userEvent.setup()
    renderApp(<App />)
    await screen.findByLabelText('Search')
    await user.type(screen.getByLabelText('Search'), 'lis')
    await waitFor(() => {
      expect(query().get('q')).toBe('lis')
    })
    await user.clear(screen.getByLabelText('Search'))
    await waitFor(() => {
      expect(query().get('q')).toBeNull()
    })
  })

  it('removes open when Open now is unchecked', async () => {
    stubList()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByLabelText('Open now'))
    await waitFor(() => {
      expect(query().get('open')).toBe('1')
    })
    await user.click(screen.getByLabelText('Open now'))
    await waitFor(() => {
      expect(query().get('open')).toBeNull()
    })
  })

  it('matches Search without regard to letter case', async () => {
    stubList()
    const user = userEvent.setup()
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()
    await user.type(screen.getByLabelText('Search'), 'LIS')
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
  })

  it('sorts by name then id when Sort is missing from the URL', async () => {
    stubList()
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Atlas' })).toBeTruthy()
    const names = screen.getAllByRole('button').map(el => el.textContent)
    expect(names).toEqual(['Atlas', 'Harbor', 'Moonlight'])
  })

  it('updates the search box, Open now, Sort, and list on back and forward', async () => {
    stubList()
    window.history.pushState({}, '', '/')
    window.history.pushState({}, '', '/?q=lis&open=1&sort=city')
    renderApp(<App />)
    expect(await screen.findByRole('button', { name: 'Moonlight' })).toBeTruthy()
    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('lis')
    expect((screen.getByLabelText('Open now') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Sort') as HTMLSelectElement).value).toBe('city')
    expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()

    window.history.back()
    await waitFor(() => {
      expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('')
    })
    expect((screen.getByLabelText('Open now') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Sort') as HTMLSelectElement).value).toBe('name')
    expect(await screen.findByRole('button', { name: 'Harbor' })).toBeTruthy()

    window.history.forward()
    await waitFor(() => {
      expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('lis')
    })
    expect((screen.getByLabelText('Open now') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Sort') as HTMLSelectElement).value).toBe('city')
    expect(screen.queryByRole('button', { name: 'Harbor' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Moonlight' })).toBeTruthy()
  })
})
