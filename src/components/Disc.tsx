import { useId } from 'react'
import type { CSSProperties } from 'react'
import type { Game } from '../../shared/types'
import { artUrl } from '../api'

interface Props {
  game?: Game
  /** Text printed on a disc that isn't in the library (e.g. the volume label) */
  label?: string
  /** blank = shiny data side only (the "no disc" ghost) */
  blank?: boolean
  size: number | string
  className?: string
  style?: CSSProperties
}

/**
 * An optical disc drawn in CSS: the printed label and the data layer rotate with `--angle`
 * (set by a parent), while the light reflections stay put, which is what sells the spin.
 */
export function Disc({ game, label, blank, size, className = '', style }: Props) {
  const art = game ? artUrl(game.art.disc || game.art.cover) : undefined
  const logo = game && !game.art.disc ? artUrl(game.art.logo) : undefined
  const sz = typeof size === 'number' ? `${size}px` : size
  return (
    <div className={`disc ${blank ? 'disc--blank' : ''} ${className}`} style={{ '--size': sz, ...style } as CSSProperties}>
      <div className="disc-body">
        <div className="disc-data" />
        {!blank && (
          <div className="disc-print" style={art ? { backgroundImage: `url("${art}")` } : undefined}>
            {!art && <GeneratedLabel title={game?.title ?? label ?? 'Unknown disc'} color={game?.color ?? 'hsl(205 15% 60%)'} />}
            {art && logo && <img className="disc-logo" src={logo} alt="" draggable={false} />}
          </div>
        )}
      </div>
      <div className="disc-hub" />
      <div className="disc-sheen" />
      <div className="disc-edge" />
    </div>
  )
}

function GeneratedLabel({ title, color }: { title: string; color: string }) {
  const id = useId().replace(/:/g, '')
  const len = title.length
  const fs = len > 28 ? 9 : len > 20 ? 11 : len > 12 ? 13 : 16
  return (
    <svg viewBox="0 0 200 200" className="disc-gen">
      <defs>
        <radialGradient id={`g${id}`} cx="50%" cy="38%" r="70%">
          <stop offset="0%" stopColor="white" stopOpacity="0.55" />
          <stop offset="45%" stopColor={color} />
          <stop offset="100%" stopColor={color} stopOpacity="0.85" />
        </radialGradient>
        <path id={`t${id}`} d="M 100,100 m -76,0 a 76,76 0 1,1 152,0" />
        <path id={`b${id}`} d="M 100,100 m -82,0 a 82,82 0 0,0 164,0" />
      </defs>
      <circle cx="100" cy="100" r="100" fill={`url(#g${id})`} />
      <circle cx="100" cy="100" r="64" fill="none" stroke="white" strokeOpacity="0.35" strokeWidth="0.8" />
      <circle cx="100" cy="100" r="92" fill="none" stroke="white" strokeOpacity="0.25" strokeWidth="0.6" />
      <text className="disc-gen-title" fontSize={fs}>
        <textPath href={`#t${id}`} startOffset="50%" textAnchor="middle">
          {title}
        </textPath>
      </text>
      <text className="disc-gen-sub" fontSize="6.5">
        <textPath href={`#b${id}`} startOffset="50%" textAnchor="middle">
          PC CD-ROM · DISCPLAY
        </textPath>
      </text>
    </svg>
  )
}
