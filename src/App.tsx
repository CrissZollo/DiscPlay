import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DiscSessionInfo, DriveState, Game, RunStatus, Settings } from '../shared/types'
import { api, newGame } from './api'
import { setSoundEnabled, sfx } from './sound'
import { useInput, type InputAction } from './useInput'
import { Disc } from './components/Disc'
import { GameEditor } from './components/GameEditor'
import { HeroicImport } from './components/HeroicImport'
import { InstallWizard } from './components/InstallWizard'
import { LinkDisc } from './components/LinkDisc'
import { bestSuggestion, withLabel } from './discMatch'
import { Modal, modalOpen } from './components/Modal'
import { SettingsModal } from './components/SettingsModal'
import { Shelf } from './components/Shelf'
import { Stage, type StagePhase } from './components/Stage'
import { TitleBar } from './components/TitleBar'

type ModalState =
  | { kind: 'editor'; game: Game; isNew: boolean }
  | { kind: 'settings' }
  | { kind: 'heroic' }
  | { kind: 'install'; addon?: boolean; targetId?: string }
  | { kind: 'add' }
  | { kind: 'link'; initialId?: string }
  | null

interface StageState {
  gameId?: string
  unknownLabel?: string
  phase: StagePhase
  from: 'shelf' | 'drive'
}

interface Toast {
  id: number
  text: string
  kind?: 'error'
}

const EMPTY_STAGE: StageState = { phase: 'empty', from: 'shelf' }

export function App() {
  const [library, setLibrary] = useState<Game[]>([])
  const [settings, setSettings] = useState<Settings>()
  const [drive, setDrive] = useState<DriveState>({ device: '/dev/sr0', present: false, hasDisc: false })
  const [status, setStatus] = useState<RunStatus>({ state: 'idle' })
  const [discSession, setDiscSession] = useState<DiscSessionInfo | null>(null)
  const [selected, setSelected] = useState(0)
  const [stage, setStage] = useState<StageState>(EMPTY_STAGE)
  const [flight, setFlight] = useState<{ game: Game; from: DOMRect } | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const anchorRef = useRef<HTMLDivElement>(null)
  const timers = useRef<number[]>([])
  const stageRef = useRef(stage)
  stageRef.current = stage

  const games = useMemo(() => [...library].sort((a, b) => a.title.localeCompare(b.title)), [library])
  const gamesRef = useRef(games)
  gamesRef.current = games
  const stageGame = games.find((g) => g.id === stage.gameId)
  const running = status.state === 'running' || status.state === 'preparing' || status.state === 'waiting-disc'

  const toast = useCallback((text: string, kind?: 'error') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    // Long messages stay up long enough to be read.
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), Math.max(kind === 'error' ? 7000 : 3800, text.length * 60))
  }, [])

  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }
  const clearTimers = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  // ---- bootstrap -------------------------------------------------------------------
  useEffect(() => {
    api.getLibrary().then(setLibrary)
    api.getSettings().then((s) => {
      setSettings(s)
      setSoundEnabled(s.sound)
    })
    api.getStatus().then(setStatus)
    api.getDiscSession().then(setDiscSession)
    api.getDrive().then((d) => {
      setDrive(d)
      onDriveChange(d, { device: d.device, present: d.present, hasDisc: false })
    })
    const offs = [
      api.onLibrary(setLibrary),
      api.onDiscSession(setDiscSession),
      api.onNotice((text) => toast(text)),
      api.onStatus((s: RunStatus) => {
        setStatus((prev) => {
          if (s.state === 'error') {
            sfx.error()
            toast(s.message, 'error')
          }
          if (s.state === 'running' && prev.state !== 'running') toast('Game started – have fun!')
          return s
        })
      }),
      api.onDrive((d: DriveState) =>
        setDrive((prev) => {
          onDriveChange(d, prev)
          return d
        }),
      ),
    ]
    return () => offs.forEach((o) => o())
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'console'
  }, [settings?.theme])

  // ---- disc choreography ---------------------------------------------------------
  /** Put a game's disc "in the drive": fly it from the shelf (or slide it in from the slot). */
  const insert = useCallback((game: Game, from: 'shelf' | 'drive') => {
    const cur = stageRef.current
    if (cur.gameId === game.id && cur.phase !== 'ejecting') return
    const go = () => {
      clearTimers()
      sfx.insert()
      if (from === 'shelf') {
        const el = document.querySelector(`[data-disc="${game.id}"] .disc`)
        const rect = el?.getBoundingClientRect()
        setStage({ gameId: game.id, phase: 'landing', from })
        if (rect) setFlight({ game, from: rect })
        else landed()
      } else {
        setStage({ gameId: game.id, phase: 'landing', from })
        later(850, landed)
      }
      const i = gamesRef.current.findIndex((g) => g.id === game.id)
      if (i >= 0) setSelected(i)
    }
    if (cur.phase !== 'empty' && (cur.gameId || cur.unknownLabel)) {
      setStage((s) => ({ ...s, phase: 'ejecting' }))
      later(420, go)
    } else go()
  }, [])

  const landed = useCallback(() => {
    setFlight(null)
    sfx.spinUp()
    setStage((s) => ({ ...s, phase: 'spinup' }))
    later(1300, () => setStage((s) => (s.phase === 'spinup' ? { ...s, phase: 'ready' } : s)))
  }, [])

  const showUnknown = (label: string) => {
    clearTimers()
    sfx.insert()
    setStage({ unknownLabel: label, phase: 'landing', from: 'drive' })
    later(850, landed)
  }

  const ejectVisual = useCallback(() => {
    clearTimers()
    sfx.eject()
    setStage((s) => ({ ...s, phase: 'ejecting' }))
    later(560, () => setStage(EMPTY_STAGE))
  }, [])

  function onDriveChange(d: DriveState, prev: DriveState) {
    const s = stageRef.current
    const newDisc = d.hasDisc && (!prev.hasDisc || prev.label !== d.label)
    if (newDisc) {
      const label = (d.label ?? '').toLowerCase()
      const match = gamesRef.current.find((g) => g.disc.labels.some((l) => l.toLowerCase() === label))
      api.getSettings().then((st) => {
        if (match) {
          if (st.autoInsert && !runningRef.current) insert(match, 'drive')
          else toast(`${match.title} disc inserted`)
        } else if (!st.offerInstall) {
          if (d.media !== 'audio') toast(`Unknown disc “${d.label ?? 'Disc'}” inserted. Use Add to install it or link it to a game.`)
        } else if (!runningRef.current) {
          // A disc going in takes over the screen, like a known one does.
          if (s.gameId || s.unknownLabel) {
            setStage((x) => ({ ...x, phase: 'ejecting' }))
            later(420, () => showUnknown(d.label ?? 'Disc'))
          } else showUnknown(d.label ?? 'Disc')
        }
      })
    } else if (!d.hasDisc && prev.hasDisc) {
      if (s.from === 'drive' && (s.gameId || s.unknownLabel) && !runningRef.current) ejectVisual()
    }
  }
  const runningRef = useRef(running)
  runningRef.current = running

  // When the library loads after the drive, match the disc that's already in.
  useEffect(() => {
    if (!library.length || !drive.hasDisc) return
    const s = stageRef.current
    if (s.unknownLabel) {
      const label = (drive.label ?? '').toLowerCase()
      const match = games.find((g) => g.disc.labels.some((l) => l.toLowerCase() === label))
      if (match) insert(match, 'drive')
    }
  }, [library])

  // A game is running that isn't on the stage (DiscPlay was reopened mid-game): show it, so it can be stopped.
  useEffect(() => {
    if (status.state !== 'running' && status.state !== 'waiting-disc') return
    const g = games.find((x) => x.id === status.gameId)
    if (g && !stageRef.current.gameId) insert(g, 'drive')
  }, [status, games])

  // ---- unknown discs ------------------------------------------------------------------
  const unknownDisc = !!stage.unknownLabel && !stageGame && drive.hasDisc
  const suggestion = useMemo(() => (unknownDisc ? bestSuggestion(drive, games) : undefined), [unknownDisc, drive.label, drive.suggestedTitle, games])

  /** Save the disc in the drive as one of this game's discs, then bring the game up. */
  const linkDisc = async (game: Game, playFromDisc = false) => {
    const label = drive.label
    if (!drive.hasDisc || !label) return toast('There is no disc with a label in the drive.', 'error')
    const fresh = gamesRef.current.find((g) => g.id === game.id) ?? game
    try {
      const saved = await api.saveGame({ ...fresh, disc: withLabel(fresh, label, playFromDisc) })
      setModal(null)
      toast(`“${label}” is now a disc of ${saved.title}`)
      insert(saved, 'drive')
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  // ---- actions ---------------------------------------------------------------------
  const play = useCallback(() => {
    const g = gamesRef.current.find((x) => x.id === stageRef.current.gameId)
    if (!g || runningRef.current) return
    sfx.start()
    api.launch(g.id).catch((e) => toast(String(e.message ?? e), 'error'))
  }, [])

  const eject = useCallback(() => {
    const s = stageRef.current
    if (runningRef.current) return
    if (s.from === 'drive') {
      api.ejectDrive().catch(() => {})
    }
    ejectVisual()
  }, [])

  const openAdd = () => {
    sfx.open()
    setModal({ kind: 'add' })
  }

  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const onAction = useCallback(
    (a: InputAction) => {
      if (modalOpen()) return
      const list = gamesRef.current
      const s = stageRef.current
      const sel = Math.min(selectedRef.current, list.length)
      if (a === 'left' || a === 'right') {
        const n = Math.max(0, Math.min(list.length, sel + (a === 'left' ? -1 : 1)))
        if (n !== sel) {
          sfx.tick()
          setSelected(n)
        }
      } else if (a === 'confirm') {
        if (sel === list.length) openAdd()
        else if (list[sel] && list[sel].id !== s.gameId) insert(list[sel], 'shelf')
        else if (s.phase === 'ready' || s.phase === 'spinup') play()
      } else if (a === 'play') {
        if (s.gameId) play()
        else if (list[sel]) insert(list[sel], 'shelf')
      } else if (a === 'back') {
        if (s.gameId || s.unknownLabel) eject()
      } else if (a === 'edit') {
        const g = list.find((x) => x.id === s.gameId) ?? list[sel]
        if (g) setModal({ kind: 'editor', game: g, isNew: false })
      } else if (a === 'add') openAdd()
    },
    [insert, play, eject],
  )
  useInput(onAction)

  const close = () => {
    sfx.close()
    setModal(null)
  }

  return (
    <div className="app">
      <TitleBar drive={drive} onAdd={openAdd} onSettings={() => { sfx.open(); setModal({ kind: 'settings' }) }} />
      <Stage
        ref={anchorRef}
        game={stageGame}
        unknownLabel={stageGame ? undefined : stage.unknownLabel}
        phase={stage.phase}
        from={stage.from}
        drive={drive}
        status={status}
        libraryEmpty={!games.length}
        onPlay={play}
        onEject={eject}
        onEdit={() => stageGame && setModal({ kind: 'editor', game: stageGame, isNew: false })}
        onStop={() => api.stop()}
        discSession={discSession}
        onSwapDisc={(i) => api.swapDisc(i).catch((e) => toast(errText(e), 'error'))}
        onEjectDisc={() => api.ejectSessionDisc().catch((e) => toast(errText(e), 'error'))}
        canInstallAddon={games.some((g) => g.runner !== 'native' && g.prefix)}
        onInstallAddon={() => setModal({ kind: 'install', addon: true })}
        suggestion={suggestion}
        onLinkDisc={(g) => {
          // Waiting for this game's disc, or a confident guess: link right away. Otherwise let the user choose.
          if (g && (status.state === 'waiting-disc' || g.id === suggestion?.game.id)) linkDisc(g)
          else {
            sfx.open()
            setModal({ kind: 'link', initialId: g?.id })
          }
        }}
        onCancelWait={() => api.cancelWait()}
        onInstallDisc={() => setModal({ kind: 'install' })}
        onAddExisting={() =>
          setModal({
            kind: 'editor',
            isNew: true,
            game: newGame({ disc: { source: 'drive', labels: drive.label ? [drive.label] : [], letter: 'd', required: false } }),
          })
        }
        onImportHeroic={() => setModal({ kind: 'heroic' })}
      />
      <Shelf
        games={games}
        selected={Math.min(selected, games.length)}
        insertedId={stage.phase !== 'ejecting' ? stage.gameId : undefined}
        inDriveId={drive.hasDisc ? games.find((g) => g.disc.labels.some((l) => l.toLowerCase() === (drive.label ?? '').toLowerCase()))?.id : undefined}
        onSelect={(i) => {
          if (i !== selected) sfx.tick()
          setSelected(i)
        }}
        onInsert={(i) => games[i] && insert(games[i], 'shelf')}
        onAdd={openAdd}
      />
      <div className="hints">
        <span><kbd>←</kbd><kbd>→</kbd> choose</span>
        <span><kbd>Enter</kbd> insert / play</span>
        <span><kbd>Esc</kbd> eject</span>
        <span><kbd>E</kbd> edit</span>
      </div>

      {flight && <FlyingDisc game={flight.game} from={flight.from} anchor={anchorRef} onDone={landed} />}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'toast--error' : ''}`}>{t.text}</div>
        ))}
      </div>

      {modal?.kind === 'add' && (
        <Modal title="Add a game" onClose={close}>
          <div className="add-options">
            <button className="add-option" onClick={() => setModal({ kind: 'install' })}>
              <Disc blank size={64} />
              <strong>Install from disc</strong>
              <span>Run the setup from a CD/DVD or disc image into a new prefix.</span>
            </button>
            <button className="add-option" onClick={() => setModal({ kind: 'install', addon: true })} disabled={!games.some((g) => g.runner !== 'native' && g.prefix)}>
              <Disc label="Expansion" size={64} game={{ ...newGame({ title: 'Expansion' }), color: 'hsl(32 85% 55%)' }} />
              <strong>Install an add-on disc</strong>
              <span>Add an expansion or patch disc to a game you already have.</span>
            </button>
            <button className="add-option" onClick={() => setModal({ kind: 'editor', game: newGame(), isNew: true })}>
              <Disc label="Installed game" size={64} />
              <strong>Add an installed game</strong>
              <span>Point at a game that's already installed in a prefix.</span>
            </button>
            <button className="add-option" onClick={() => setModal({ kind: 'heroic' })}>
              <Disc label="Heroic" size={64} game={{ ...newGame({ title: 'Heroic' }), color: 'hsl(265 60% 55%)' }} />
              <strong>Import from Heroic</strong>
              <span>Bring over your sideloaded Heroic games, art and settings.</span>
            </button>
          </div>
        </Modal>
      )}
      {modal?.kind === 'editor' && (
        <GameEditor
          game={modal.game}
          isNew={modal.isNew}
          drive={drive}
          library={library}
          toast={toast}
          onClose={close}
          onSaved={(g) => {
            setModal(null)
            toast(`Saved ${g.title}`)
            if (modal.isNew) later(80, () => insert(g, 'drive'))
          }}
          onInstallAddon={(g) => setModal({ kind: 'install', addon: true, targetId: g.id })}
          onDeleted={(id) => {
            setModal(null)
            if (stageRef.current.gameId === id) setStage(EMPTY_STAGE)
          }}
        />
      )}
      {modal?.kind === 'settings' && settings && (
        <SettingsModal
          settings={settings}
          onClose={close}
          onSaved={(s) => {
            setSettings(s)
            setSoundEnabled(s.sound)
            setModal(null)
          }}
          onImportHeroic={() => setModal({ kind: 'heroic' })}
        />
      )}
      {modal?.kind === 'heroic' && (
        <HeroicImport
          onClose={close}
          onDone={(n) => {
            setModal(null)
            toast(`Imported ${n} game${n === 1 ? '' : 's'} from Heroic`)
          }}
        />
      )}
      {modal?.kind === 'link' && (
        <LinkDisc drive={drive} games={games} initialId={modal.initialId} onClose={close} onLink={(g, fromDisc) => linkDisc(g, fromDisc)} />
      )}
      {modal?.kind === 'install' && (
        <InstallWizard
          drive={drive}
          library={library}
          addon={modal.addon}
          targetId={modal.targetId}
          onClose={close}
          onCreated={(g) => setModal({ kind: 'editor', game: g, isNew: true })}
          onAddonDone={(g, msg) => {
            setModal(null)
            toast(msg)
            later(80, () => insert(g, 'shelf'))
          }}
        />
      )}
    </div>
  )
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** A disc travelling from the shelf into the drive, rolling as it goes. */
function FlyingDisc({ game, from, anchor, onDone }: { game: Game; from: DOMRect; anchor: React.RefObject<HTMLDivElement | null>; onDone(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const spin = useRef<HTMLDivElement>(null)
  const [to, setTo] = useState<DOMRect>()
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect()
    if (r) setTo(r)
    else onDone()
  }, [])
  useLayoutEffect(() => {
    if (!to || !ref.current || !spin.current) return
    const s = from.width / to.width
    const dx = from.left - to.left
    const dy = from.top - to.top
    const anim = ref.current.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.3 - 60}px) scale(${(s + 1) / 2.2})`, offset: 0.55 },
        { transform: 'translate(0, 0) scale(1)' },
      ],
      { duration: 760, easing: 'cubic-bezier(.45,.05,.25,1)', fill: 'forwards' },
    )
    spin.current.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-620deg)' }], { duration: 760, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' })
    anim.onfinish = onDone
    return () => anim.cancel()
  }, [to])
  if (!to) return null
  return (
    <div className="flying" ref={ref} style={{ left: to.left, top: to.top, width: to.width, height: to.height }}>
      <div ref={spin} className="flying-spin">
        <Disc game={game} size="100%" />
      </div>
    </div>
  )
}
