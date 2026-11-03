import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Game } from '../../shared/types'
import { Disc } from './Disc'

interface Props {
  games: Game[]
  selected: number
  insertedId?: string
  inDriveId?: string
  onSelect(i: number): void
  onInsert(i: number): void
  onAdd(): void
}

const SIZE = 148
const GAP = 46
const STEP = SIZE + GAP

/**
 * The disc shelf: discs stand on a glossy floor and *roll* when the shelf moves —
 * each disc turns by distance / radius, so the movement reads as wheels rolling.
 */
export function Shelf({ games, selected, insertedId, inDriveId, onSelect, onInsert, onAdd }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1200)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const offset = width / 2 - SIZE / 2 - selected * STEP
  const roll = (-offset / (SIZE / 2)) * (180 / Math.PI)
  const total = games.length + 1

  return (
    <div
      className="shelf"
      ref={ref}
      onWheel={(e) => {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        if (Math.abs(d) < 4) return
        onSelect(Math.max(0, Math.min(total - 1, selected + (d > 0 ? 1 : -1))))
      }}
    >
      <div className="shelf-floor" />
      <div className="shelf-track" style={{ transform: `translateX(${offset}px)` }}>
        {games.map((g, i) => {
          const dist = Math.abs(i - selected)
          const isIn = g.id === insertedId
          return (
            <button
              key={g.id}
              data-disc={g.id}
              className={`shelf-item ${i === selected ? 'is-selected' : ''} ${isIn ? 'is-inserted' : ''}`}
              style={{ left: i * STEP, '--dist': Math.min(dist, 4) } as CSSProperties}
              onClick={() => (i === selected ? onInsert(i) : onSelect(i))}
              onDoubleClick={() => onInsert(i)}
              tabIndex={-1}
            >
              <div className="shelf-disc" style={{ '--angle': `${roll + i * 37}deg` } as CSSProperties}>
                <Disc game={g} size={SIZE} />
              </div>
              {g.id === inDriveId && <span className="shelf-badge" title="This disc is in your drive">●</span>}
              <span className="shelf-caption">{g.title}</span>
            </button>
          )
        })}
        <button
          className={`shelf-item shelf-add ${selected === games.length ? 'is-selected' : ''}`}
          style={{ left: games.length * STEP, '--dist': Math.min(Math.abs(games.length - selected), 4) } as CSSProperties}
          onClick={() => (selected === games.length ? onAdd() : onSelect(games.length))}
          tabIndex={-1}
        >
          <div className="shelf-disc">
            <div className="add-disc" style={{ width: SIZE, height: SIZE }}>
              <span>+</span>
            </div>
          </div>
          <span className="shelf-caption">Add a game</span>
        </button>
      </div>
    </div>
  )
}
