import { useMemo, useState } from 'react'
import type { DriveState, Game } from '../../shared/types'
import { suggestGames } from '../discMatch'
import { Disc } from './Disc'
import { Modal, Toggle } from './Modal'

interface Props {
  drive: DriveState
  games: Game[]
  /** Pre-selected game */
  initialId?: string
  onClose(): void
  onLink(game: Game, playFromDisc: boolean): void
}

/** Add an unrecognised disc to a game that is already in the library. */
export function LinkDisc({ drive, games, initialId, onClose, onLink }: Props) {
  const suggestions = useMemo(() => suggestGames(drive, games).filter((s) => s.score >= 40), [drive.label, games])
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(initialId ?? suggestions[0]?.game.id ?? '')
  const [playFromDisc, setPlayFromDisc] = useState(false)
  const label = drive.label ?? 'Disc'

  const list = useMemo(() => {
    const why = new Map(suggestions.map((s) => [s.game.id, s.why]))
    const q = query.trim().toLowerCase()
    const sorted = [
      ...suggestions.map((s) => s.game),
      ...[...games].filter((g) => !why.has(g.id)).sort((a, b) => a.title.localeCompare(b.title)),
    ]
    return sorted.filter((g) => !q || g.title.toLowerCase().includes(q)).map((g) => ({ game: g, why: why.get(g.id) }))
  }, [games, suggestions, query])

  const game = games.find((g) => g.id === chosen)

  return (
    <Modal
      title="Add disc to a game"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!game || !drive.label} onClick={() => game && onLink(game, playFromDisc)}>
            {game ? `Add to ${game.title}` : 'Choose a game'}
          </button>
        </>
      }
    >
      <div className="install-head">
        <div className="spin" style={{ '--angle': '0deg' } as React.CSSProperties}>
          <Disc label={label} size={84} />
        </div>
        <div>
          <strong>“{label}”</strong>
          {drive.suggestedTitle && drive.suggestedTitle !== label && <span className="muted"> · {drive.suggestedTitle}</span>}
          <p className="muted link-intro">Which game is this disc for? Its label is saved with the game, so putting it in brings the game up and counts as the game’s disc.</p>
        </div>
      </div>
      {games.length > 8 && (
        <input className="link-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your games…" autoFocus spellCheck={false} />
      )}
      <ul className="check-list link-list">
        {list.map(({ game: g, why }) => (
          <li key={g.id}>
            <label>
              <input type="radio" name="link-game" checked={chosen === g.id} onChange={() => setChosen(g.id)} />
              <span>
                {g.title}
                {why && <small className="suggested">Likely · {why}</small>}
              </span>
              <em>{g.disc.labels.length ? g.disc.labels.join(', ') : g.disc.source === 'image' ? 'disc image' : 'no disc yet'}</em>
            </label>
          </li>
        ))}
        {!list.length && <li className="muted">No games match “{query}”.</li>}
      </ul>
      {game?.disc.source === 'image' && (
        <Toggle checked={playFromDisc} onChange={setPlayFromDisc} label={`Play ${game.title} from this disc instead of its image`} />
      )}
      {game?.disc.source === 'none' && <p className="muted">{game.title} will use this disc when it’s in, but still starts without it.</p>}
    </Modal>
  )
}
