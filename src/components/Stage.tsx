import { forwardRef, useEffect, useState } from 'react'
import type { DiscSessionInfo, DriveState, Game, RunStatus } from '../../shared/types'
import type { DiscSuggestion } from '../discMatch'
import { artUrl, formatAgo, formatPlaytime } from '../api'
import { useSpin } from '../useSpin'
import { Disc } from './Disc'

export type StagePhase = 'empty' | 'landing' | 'spinup' | 'ready' | 'ejecting'

interface Props {
  game?: Game
  unknownLabel?: string
  phase: StagePhase
  from: 'shelf' | 'drive'
  drive: DriveState
  status: RunStatus
  libraryEmpty: boolean
  onPlay(): void
  onEject(): void
  onEdit(): void
  onStop(): void
  onCancelWait(): void
  onInstallDisc(): void
  onAddExisting(): void
  onImportHeroic(): void
  /** Disc(s) linked into the running game, for disc swaps */
  discSession: DiscSessionInfo | null
  onSwapDisc(index: number): void
  onEjectDisc(): void
  canInstallAddon: boolean
  onInstallAddon(): void
  /** Best guess at which library game an unknown disc belongs to */
  suggestion?: DiscSuggestion
  /** Add the disc in the drive to a library game: straight away with a game, or by choosing one */
  onLinkDisc(game?: Game): void
}

function speedFor(phase: StagePhase, running: boolean, hasDisc: boolean) {
  if (!hasDisc) return 36
  if (phase === 'landing' || phase === 'ejecting') return 0
  if (phase === 'spinup') return 1500
  return running ? 520 : 170
}

export const Stage = forwardRef<HTMLDivElement, Props>(function Stage(p, anchorRef) {
  const { game, phase, status, drive } = p
  const shown = !!game || !!p.unknownLabel
  const running = !!game && (status.state === 'running' || status.state === 'preparing') && status.gameId === game.id
  const waiting = !!game && status.state === 'waiting-disc' && status.gameId === game.id
  const spinRef = useSpin<HTMLDivElement>(speedFor(phase, running, shown), { response: phase === 'spinup' ? 2.2 : 1.1 })
  const hero = artUrl(game?.art.hero || game?.art.cover)
  const [heroKey, setHeroKey] = useState<string | undefined>()
  useEffect(() => {
    if (phase === 'spinup' || phase === 'ready') setHeroKey(hero)
    if (phase === 'empty' || phase === 'ejecting') setHeroKey(undefined)
  }, [phase, hero])

  const discInDrive = !!game && drive.hasDisc && game.disc.labels.some((l) => l.toLowerCase() === (drive.label ?? '').toLowerCase())
  const needsDisc = !!game && game.disc.source === 'drive' && game.disc.required && !discInDrive
  const reveal = phase === 'ready' || phase === 'spinup'
  const session = game && p.discSession?.owner === game.id ? p.discSession : null

  return (
    <section className={`stage stage--${shown ? 'disc' : 'empty'} phase-${phase} ${running ? 'is-running' : ''}`}>
      <div className="stage-bg">
        <div className="stage-bg-pattern" />
        {heroKey && <div key={heroKey} className="stage-hero" style={{ backgroundImage: `url("${heroKey}")` }} />}
        <div className="stage-veil" />
      </div>

      <div className="stage-inner">
        <div className={`stage-disc from-${p.from}`} ref={anchorRef}>
          <div className="stage-disc-glow" />
          <div ref={spinRef} className="spin">
            {shown ? <Disc game={game} label={p.unknownLabel} size="100%" /> : <Disc blank size="100%" className="disc--ghost" />}
          </div>
        </div>

        {!shown && (
          <div className="stage-empty">
            <h1>Insert a disc</h1>
            <p>
              {p.libraryEmpty
                ? 'Put a game disc in your drive, or add the games you already have.'
                : 'Put a game disc in your drive, or pick one from the shelf below.'}
            </p>
            {p.libraryEmpty && (
              <div className="row">
                <button className="btn btn--primary" onClick={p.onImportHeroic}>Import from Heroic</button>
                <button className="btn" onClick={p.onAddExisting}>Add a game</button>
              </div>
            )}
          </div>
        )}

        {game && (
          <div className={`stage-info ${reveal ? 'is-shown' : ''}`}>
            {game.art.logo ? <img className="stage-logo" src={artUrl(game.art.logo)} alt={game.title} /> : <h1 className="stage-title">{game.title}</h1>}
            <div className="stage-meta">
              {game.year && <span>{game.year}</span>}
              <span>{formatPlaytime(game.playtimeSeconds)}</span>
              {game.lastPlayed && <span>Last played {formatAgo(game.lastPlayed)}</span>}
            </div>
            <div className="chips">
              {game.disc.source === 'drive' && (
                <span className={`chip ${discInDrive ? 'chip--ok' : needsDisc ? 'chip--warn' : ''}`}>
                  <i className="led" /> {discInDrive ? `Disc in drive · ${drive.label}` : `Disc ${game.disc.labels[0] ?? ''}${game.disc.required ? ' needed' : ' optional'}`}
                </span>
              )}
              {game.disc.source === 'image' && (
                <span className="chip">{(game.disc.images?.length ?? 0) > 1 ? `${game.disc.images!.length} disc images` : 'Disc image'}</span>
              )}
              {!!game.addons?.length && (
                <span className="chip" title={game.addons.map((a) => a.title).join(', ')}>
                  + {game.addons.length === 1 ? game.addons[0].title : `${game.addons.length} add-ons`}
                </span>
              )}
              <span className="chip">{game.runner === 'umu' ? 'Proton' : game.runner === 'wine' ? 'Wine' : 'Linux'}</span>
            </div>

            {waiting ? (
              <div className="waiting">
                <div className="waiting-anim">
                  <div className="slot-mini" />
                  <Disc game={game} size={64} className="waiting-disc" />
                </div>
                <div>
                  <strong>Please insert the disc</strong>
                  <p>
                    {status.label ? <>“{status.label}”</> : 'The game disc'}
                    {status.found ? <> — the drive has “{status.found}”.</> : ' is not in the drive.'} The game starts as soon as it’s found.
                  </p>
                </div>
                {status.found && (
                  <button className="btn btn--primary" onClick={() => p.onLinkDisc(game)} title={`Save “${status.found}” as one of ${game.title}'s discs and start`}>
                    Use this disc
                  </button>
                )}
                <button className="btn" onClick={p.onCancelWait}>Cancel</button>
              </div>
            ) : running ? (
              <div className="row">
                <div className="now-playing">
                  <span className="eq"><i /><i /><i /></span>
                  {status.state === 'preparing' ? status.message : 'Now playing'}
                </div>
                <button className="btn" onClick={p.onStop}>Stop</button>
                {session && session.kind === 'image' && session.images.length > 1 && (
                  <div className="seg seg--discs" title="Change disc">
                    {session.images.map((name, i) => (
                      <button key={name + i} className={i === session.current ? 'is-on' : ''} disabled={session.busy} title={name} onClick={() => i !== session.current && p.onSwapDisc(i)}>
                        Disc {i + 1}
                      </button>
                    ))}
                  </div>
                )}
                {session && session.kind === 'drive' && status.state === 'running' && (
                  <button className="btn btn--ghost" disabled={session.busy || !drive.hasDisc} onClick={p.onEjectDisc} title="Open the drive so the game's next disc can go in">
                    Change disc
                  </button>
                )}
              </div>
            ) : (
              <div className="row">
                <button className="btn btn--play" onClick={p.onPlay} autoFocus>
                  <svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
                  Play
                </button>
                <button className="btn" onClick={p.onEject}>Eject</button>
                <button className="btn btn--ghost" onClick={p.onEdit} title="Edit (E)">Edit</button>
              </div>
            )}
            {session?.message && !session.busy && running && <p className="stage-error">{session.message}</p>}
            {status.state === 'error' && status.gameId === game.id && <p className="stage-error">{status.message}</p>}
          </div>
        )}

        {!game && p.unknownLabel && (
          <div className={`stage-info ${reveal ? 'is-shown' : ''}`}>
            <h1 className="stage-title">{p.unknownLabel}</h1>
            <div className="stage-meta">
              <span>{drive.pressed === false ? 'Burned disc' : 'Disc'} in {drive.device}</span>
              {drive.hasSetup && <span>Has an installer</span>}
            </div>
            {p.suggestion ? (
              <p className="stage-hint">
                Looks like it belongs to <strong>{p.suggestion.game.title}</strong> ({p.suggestion.why}).
              </p>
            ) : (
              <p className="stage-hint">This disc isn’t in your library yet.{p.libraryEmpty ? '' : ' Already installed? Add it to its game.'}</p>
            )}
            <div className="row">
              {p.suggestion && (
                <button className="btn btn--play" onClick={() => p.onLinkDisc(p.suggestion!.game)}>Add to {p.suggestion.game.title}</button>
              )}
              {!p.libraryEmpty && (
                <button className={p.suggestion || drive.hasSetup ? 'btn' : 'btn btn--primary'} onClick={() => p.onLinkDisc()}>
                  {p.suggestion ? 'Another game…' : 'Add to a game…'}
                </button>
              )}
              {drive.hasSetup && (
                <button className={p.suggestion ? 'btn' : 'btn btn--play'} onClick={p.onInstallDisc}>Install game</button>
              )}
              {drive.hasSetup && p.canInstallAddon && (
                <button className="btn" onClick={p.onInstallAddon}>Install as add-on</button>
              )}
              <button className="btn btn--ghost" onClick={p.onAddExisting} title="Make a new library entry for an installed game and link this disc to it">New entry…</button>
              <button className="btn btn--ghost" onClick={p.onEject}>Eject</button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
})
