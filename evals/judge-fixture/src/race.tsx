import { useEffect, useState } from 'react'

type Item = { id: string; on: boolean }

export function List({ id, items }: { id: string; items: Item[] }) {
  const [data, setData] = useState<Item[] | null>(null)
  const [copy, setCopy] = useState(items)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState<Item[]>([])

  useEffect(() => {
    setLoading(true)
    fetch(`/items/${id}`)
      .then(r => r.json())
      .then(body => {
        setData(body)
        setLoading(false)
      })
  }, [id])

  useEffect(() => {
    setVisible(copy.filter(item => item.on))
  }, [copy])

  useEffect(() => {
    setCopy(items)
  }, [items])

  if (loading) return <p>loading</p>
  return <p>{(data ?? visible).length}</p>
}
