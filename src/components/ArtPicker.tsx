import { useEffect, useState } from 'react'
import type { ArtResult, GameArt, GridResult } from '../../shared/types'
import { api } from '../api'
import { Modal } from './Modal'

export function ArtPicker({ kind, term: initial, onPick, onClose }: { kind: keyof GameArt; term: string; onPick(url: string): void; onClose(): void }) {
  const [term, setTerm] = useState(initial)
  const [games, setGames] = useState<GridResult[]>()
  const [gameId, setGameId] = useState<number>()
  const [art, setArt] = useState<ArtResult[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function search() {
    setError(undefined)
    setBusy(true)
    try {
      const r = await api.gridSearch(term)
      setGames(r)
      if (r[0]) choose(r[0].id)
      else setArt([])
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  async function choose(id: number) {
    setGameId(id)
    setArt(undefined)
    try {
      setArt(await api.gridArt(id, kind))
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  useEffect(() => {
    if (initial) search()
  }, [])

  return (
    <Modal wide title={`Find ${kind} art`} onClose={onClose}>
      <form className="row" onSubmit={(e) => { e.preventDefault(); search() }}>
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Game name" style={{ flex: 1 }} autoFocus />
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {error && <p className="stage-error">{error}</p>}
      {games && games.length > 0 && (
        <div className="pill-row">
          {games.map((g) => (
            <button key={g.id} className={`pill ${g.id === gameId ? 'is-on' : ''}`} onClick={() => choose(g.id)}>
              {g.name}{g.year ? ` (${g.year})` : ''}
            </button>
          ))}
        </div>
      )}
      <div className={`art-results art-results--${kind}`}>
        {art?.map((a) => (
          <button key={a.url} className="art-result" onClick={() => onPick(a.url)} title={`${a.width}×${a.height}`}>
            <img src={a.thumb} loading="lazy" alt="" />
          </button>
        ))}
        {art && !art.length && <p className="muted">No {kind} images for this game.</p>}
        {gameId && !art && !error && <p className="muted">Loading…</p>}
      </div>
      <p className="field-hint">Artwork from SteamGridDB.</p>
    </Modal>
  )
}
