import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { parseFavoriteIds, type Favorites } from './parse'

async function fetchFavorites(): Promise<Favorites> {
  const res = await fetch('/api/favorites')
  if (!res.ok) throw new Error('load')
  return { ids: parseFavoriteIds(await res.json()), error: 'none' }
}

async function sendFavorite(id: string, next: 'saved' | 'unsaved'): Promise<void> {
  const res = await fetch(`/api/favorites/${id}`, { method: next === 'saved' ? 'POST' : 'DELETE' })
  if (!res.ok) throw new Error('save')
}

export function useFavorites() {
  return useQuery({
    queryKey: ['favorites'],
    queryFn: fetchFavorites,
  })
}

type ToggleVars = { id: string; next: 'saved' | 'unsaved' }
type ToggleCtx = { prev: Favorites | undefined; seq: number }

export function useToggleFavorite() {
  const client = useQueryClient()
  const seq = useRef(0)
  return useMutation({
    mutationFn: (vars: ToggleVars) => sendFavorite(vars.id, vars.next),
    onMutate: async (vars: ToggleVars): Promise<ToggleCtx> => {
      const n = seq.current + 1
      seq.current = n
      await client.cancelQueries({ queryKey: ['favorites'] })
      const prev = client.getQueryData<Favorites>(['favorites'])
      const ids = new Set(prev?.ids ?? [])
      if (vars.next === 'saved') ids.add(vars.id)
      else ids.delete(vars.id)
      client.setQueryData<Favorites>(['favorites'], { ids: [...ids], error: 'none' })
      return { prev, seq: n }
    },
    onError: (_err, vars, ctx) => {
      if (ctx === undefined || ctx.seq !== seq.current) return
      client.setQueryData<Favorites>(['favorites'], {
        ids: ctx.prev?.ids ?? [],
        error: vars.next === 'saved' ? 'save' : 'unsave',
      })
    },
  })
}
