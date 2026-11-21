import { useMutation } from '@tanstack/react-query'

async function postFavorite(venueId: string): Promise<void> {
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ venueId }),
  })
  if (!res.ok) throw new Error('save')
}

export function useFavorite() {
  return useMutation({ mutationFn: postFavorite })
}
