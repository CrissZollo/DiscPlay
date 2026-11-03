import { useEffect, useMemo, useRef, useState } from 'react'
import type { AddonInfo, DiscSessionInfo, DriveState, Game, InstallResult, RunnerInfo } from '../../shared/types'
import { api, newGame } from '../api'
import { Disc } from './Disc'
import { Field, Modal, PathInput } from './Modal'

interface Props {
  drive: DriveState
  library: Game[]
  /** Start in add-on mode; with targetId the game is pre-selected */
  addon?: boolean
  targetId?: string
  onClose(): void
  /** Hands a new (unsaved) game to the editor */
  onCreated(g: Game): void
  /** An add-on was recorded on an existing game */
  onAddonDone(g: Game, message: string): void
}

type AddonUse = 'separate' | 'replace' | 'keep'

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const fileName = (p: string) => p.split('/').pop() ?? p
const looksLikeGame = (p: string) => !/^(unins|uninst|setup|install|config|settings|readme|register|update|patch)/i.test(fileName(p))

export function InstallWizard({ drive, library, addon, targetId: initialTarget, onClose, onCreated, onAddonDone }: Props) {
  const targets = useMemo(() => library.filter((g) => g.runner !== 'native' && g.prefix).sort((a, b) => a.title.localeCompare(b.title)), [library])
  const [step, setStep] = useState<'setup' | 'running' | 'pick'>('setup')
  const [mode, setMode] = useState<'game' | 'addon'>(addon || initialTarget ? 'addon' : 'game')
  const [targetId, setTargetId] = useState(initialTarget ?? '')
  const [from, setFrom] = useState<'drive' | 'image' | 'file'>(drive.hasDisc ? 'drive' : 'image')
  const [title, setTitle] = useState(drive.hasDisc ? drive.suggestedTitle || prettyLabel(drive.label) : '')
  const [images, setImages] = useState<string[]>([])
  const [imageNote, setImageNote] = useState<string>()
  const [setupFile, setSetupFile] = useState('')
  const [proton, setProton] = useState('')
  const [runners, setRunners] = useState<RunnerInfo>()
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<InstallResult>()
  const [chosen, setChosen] = useState<string>()
  const [use, setUse] = useState<AddonUse>('separate')
  const [session, setSession] = useState<DiscSessionInfo | null>(null)
  const [swapError, setSwapError] = useState<string>()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  const target = mode === 'addon' ? targets.find((g) => g.id === targetId) : undefined

  useEffect(() => {
    api.getRunners().then(setRunners)
    const offs = [
      api.onInstallLog((l) => setLines((x) => [...x.slice(-400), l])),
      api.onDiscSession((s) => setSession(s?.owner === 'install' ? s : null)),
    ]
    return () => offs.forEach((o) => o())
  }, [])
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [lines])

  async function addImage() {
    const p = await api.pickFile({
      title: images.length ? `Disc ${images.length + 1} image` : 'Disc image (disc 1)',
      filters: [{ name: 'Disc images', extensions: ['iso', 'img', 'ISO', 'IMG'] }],
      defaultPath: images[0]?.replace(/\/[^/]*$/, ''),
    })
    if (!p) return
    if (!images.length) {
      const set = await api.findDiscSet(p)
      setImages(set)
      setImageNote(set.length > 1 ? `Found ${set.length} discs of this set in the folder.` : undefined)
      if (!title) setTitle(prettyLabel(fileName(set[0]).replace(/\.[^.]+$/, '').replace(/[\s._-]*[([]?(disc|disk|cd|dvd)[\s._-]*\d+[)\]]?/i, '')))
    } else if (!images.includes(p)) {
      setImages([...images, p])
      setImageNote(undefined)
    }
  }

  const moveImage = (i: number, d: -1 | 1) =>
    setImages((x) => {
      const n = [...x]
      ;[n[i], n[i + d]] = [n[i + d], n[i]]
      return n
    })

  async function start() {
    if (!title.trim()) return setError(mode === 'addon' ? 'Name the add-on first.' : 'Name the game first.')
    if (mode === 'addon' && !target) return setError('Choose the game the add-on belongs to.')
    setError(undefined)
    setLines([])
    setStep('running')
    try {
      const r = await api.installFromDisc({
        title: title.trim(),
        from,
        images: from === 'image' ? images : undefined,
        setupPath: from === 'file' ? setupFile : undefined,
        protonPath: mode === 'game' ? proton || undefined : undefined,
        targetId: target?.id,
      })
      setResult(r)
      const first = r.candidates[0]?.path
      setChosen(first)
      if (target) {
        const fresh = r.candidates.filter((c) => c.path !== r.targetExecutable && looksLikeGame(c.path))
        setUse(fresh.length ? 'separate' : 'keep')
        if (fresh.length) setChosen(fresh[0].path)
      }
      setStep('pick')
    } catch (e) {
      setError(errText(e))
      setStep('setup')
    }
  }

  async function finish() {
    if (!result) return
    if (!target) {
      onCreated(newGame({ title: title.trim(), ...result.game, executable: chosen ?? '' }))
      return
    }
    // The labels of the add-on's own discs (only physical discs are recognised by label).
    const addonLabels = from === 'drive' ? result.labels : []
    const info: AddonInfo = {
      id: crypto.randomUUID(),
      title: title.trim(),
      labels: addonLabels,
      installedAt: Date.now(),
      executable: use !== 'keep' ? chosen : undefined,
    }
    const t = library.find((g) => g.id === target.id) ?? target
    const withAddon: Game = { ...t, addons: [...(t.addons ?? []), info] }
    try {
      if (use === 'separate') {
        await api.saveGame(withAddon)
        const disc: Game['disc'] =
          from === 'drive'
            ? { source: 'drive', labels: addonLabels, letter: t.disc.letter || 'd', required: t.disc.required }
            : from === 'image'
              ? { source: 'image', labels: [], images, imagePath: images[0], letter: t.disc.letter || 'd', required: false }
              : { ...t.disc }
        onCreated(
          newGame({
            title: title.trim(),
            runner: t.runner,
            prefix: t.prefix,
            protonPath: t.protonPath,
            wineBinary: t.wineBinary,
            wrapper: t.wrapper,
            env: { ...t.env },
            disc,
            executable: chosen ?? '',
            year: t.year,
            addonOf: t.id,
          }),
        )
      } else {
        const disc = { ...t.disc, labels: [...new Set([...t.disc.labels, ...addonLabels])] }
        // An image-based game gets the add-on's images as extra discs it can swap to.
        if (from === 'image' && t.disc.source === 'image') {
          disc.images = [...new Set([...(t.disc.images?.length ? t.disc.images : t.disc.imagePath ? [t.disc.imagePath] : []), ...images])]
          disc.imagePath = disc.images[0]
        }
        const updated: Game = {
          ...withAddon,
          disc,
          ...(use === 'replace' && chosen ? { executable: chosen, workingDir: undefined } : {}),
        }
        const saved = await api.saveGame(updated)
        onAddonDone(saved, use === 'replace' ? `${info.title} installed – ${t.title} now starts ${fileName(chosen ?? '')}` : `${info.title} installed into ${t.title}`)
      }
    } catch (e) {
      setError(errText(e))
    }
  }

  /** Closing after a new-game install without adding it: offer to delete the prefix it made. */
  const closePick = () => (result?.createdPrefix ? setConfirmDiscard(true) : onClose())
  async function discard() {
    if (!result?.createdPrefix) return onClose()
    try {
      await api.discardInstall(result.createdPrefix)
      onClose()
    } catch (e) {
      setConfirmDiscard(false)
      setError(errText(e))
    }
  }
  const stopInstall = () => api.stop()

  const canStart =
    (from === 'image' ? images.length > 0 : from === 'file' ? !!setupFile : drive.hasDisc) && (mode === 'game' || !!target)
  const settling = step === 'running' && lines.some((l) => l.startsWith('Installer closed, waiting'))
  const showSwap = !!session && (session.kind === 'drive' || session.images.length > 1)
  const discNoun = mode === 'addon' ? 'add-on' : 'game'

  return (
    <Modal
      title={mode === 'addon' ? (target ? `Install add-on · ${target.title}` : 'Install add-on disc') : 'Install from disc'}
      onClose={step === 'running' ? () => {} : step === 'pick' ? closePick : onClose}
      footer={
        step === 'setup' ? (
          <>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={start} disabled={!canStart}>Start installer</button>
          </>
        ) : step === 'pick' && confirmDiscard ? (
          <>
            <span className="muted">Close without adding {title}? Its new Windows environment and everything installed into it will be deleted.</span>
            <span className="spacer" />
            <button className="btn" onClick={() => setConfirmDiscard(false)}>Back</button>
            <button className="btn" onClick={onClose}>Keep the files</button>
            <button className="btn btn--danger" onClick={discard}>Delete and close</button>
          </>
        ) : step === 'pick' ? (
          <>
            {error && <span className="stage-error foot-error">{error}</span>}
            <span className="spacer" />
            <button className="btn" onClick={closePick}>Close</button>
            <button className="btn btn--primary" onClick={finish} disabled={!!target && use !== 'keep' && !chosen}>
              {!target ? 'Add to library' : use === 'separate' ? 'Add to shelf' : 'Done'}
            </button>
          </>
        ) : settling ? (
          <>
            <span className="muted">Waiting for the installer to finish in the background…</span>
            <span className="spacer" />
            <button className="btn btn--small" onClick={stopInstall} title="Stop the installer and everything it started">Stop installer</button>
            <button className="btn btn--small" onClick={() => api.cancelWait()} title="Use this if the installer is closed but DiscPlay keeps waiting">
              The installer is done
            </button>
          </>
        ) : (
          <>
            <span className="muted">Follow the installer window. Keep the default install folder if you can.</span>
            <span className="spacer" />
            <button className="btn btn--small" onClick={stopInstall} title="Stop the installer and everything it started">Stop installer</button>
          </>
        )
      }
    >
      {step === 'setup' && (
        <>
          <div className="install-head">
            <div className="spin" style={{ '--angle': '0deg' } as React.CSSProperties}>
              <Disc label={from === 'image' && images[0] ? fileName(images[0]) : drive.label ?? title} size={92} blank={!drive.hasDisc && from === 'drive'} />
            </div>
            <div className="install-head-main">
              <div className="seg">
                <button className={mode === 'game' ? 'is-on' : ''} onClick={() => setMode('game')}>New game</button>
                <button className={mode === 'addon' ? 'is-on' : ''} onClick={() => setMode('addon')} disabled={!targets.length} title={targets.length ? undefined : 'No Windows games in the library yet'}>
                  Add-on / expansion
                </button>
              </div>
              <div className="seg">
                <button className={from === 'drive' ? 'is-on' : ''} onClick={() => setFrom('drive')}>Disc in drive</button>
                <button className={from === 'image' ? 'is-on' : ''} onClick={() => setFrom('image')}>Disc images</button>
                <button className={from === 'file' ? 'is-on' : ''} onClick={() => setFrom('file')}>Setup file</button>
              </div>
              {from === 'drive' && <p className="muted">{drive.hasDisc ? `“${drive.label ?? 'Disc'}” in ${drive.device}${drive.hasSetup ? ' – installer found' : ''}` : `No disc in ${drive.device}`}</p>}
            </div>
          </div>
          {mode === 'addon' && (
            <Field label="Install into" hint="The add-on goes into this game's Windows environment, with its Proton and settings.">
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="" disabled>Choose a game…</option>
                {targets.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </Field>
          )}
          <Field label={mode === 'addon' ? 'Add-on name' : 'Game name'}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === 'addon' ? 'e.g. Throne of Bhaal' : undefined} autoFocus />
          </Field>
          {from === 'image' && (
            <div className="field">
              <span className="field-label">Disc images</span>
              {!!images.length && (
                <ol className="disc-list">
                  {images.map((img, i) => (
                    <li key={img}>
                      <span className="disc-num">Disc {i + 1}</span>
                      <span className="disc-file" title={img}>{fileName(img)}</span>
                      <span className="disc-tools">
                        <button className="btn btn--tiny btn--ghost" disabled={i === 0} onClick={() => moveImage(i, -1)} aria-label="Move up">↑</button>
                        <button className="btn btn--tiny btn--ghost" disabled={i === images.length - 1} onClick={() => moveImage(i, 1)} aria-label="Move down">↓</button>
                        <button className="btn btn--tiny btn--ghost" onClick={() => setImages(images.filter((x) => x !== img))} aria-label="Remove">✕</button>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <div className="row">
                <button className="btn btn--small" onClick={addImage}>{images.length ? 'Add another disc…' : 'Choose disc 1…'}</button>
                {imageNote && <span className="muted">{imageNote}</span>}
              </div>
              <span className="field-hint">The installer starts from disc 1. When it asks for the next disc, swap it in from this window.</span>
            </div>
          )}
          {from === 'file' && (
            <Field label="Setup program">
              <PathInput value={setupFile} onChange={setSetupFile} onBrowse={async () => { const p = await api.pickFile({ title: 'Setup program', filters: [{ name: 'Programs', extensions: ['exe', 'msi', 'EXE', 'MSI'] }] }); if (p) setSetupFile(p) }} />
            </Field>
          )}
          {mode === 'game' && (
            <Field label="Proton" hint="A new Wine prefix is created for the game.">
              <select value={proton} onChange={(e) => setProton(e.target.value)}>
                <option value="">Default (newest)</option>
                {runners?.protons.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
              </select>
            </Field>
          )}
          {error && <p className="stage-error">{error}</p>}
        </>
      )}
      {step === 'running' && (
        <>
          <div className="install-running">
            <div className="spin spin--auto">
              <Disc label={session?.label ?? title} size={80} />
            </div>
            <div>
              <strong>Installing {title}{target ? ` into ${target.title}` : ''}…</strong>
              <p className="muted">The installer runs in its own window.</p>
            </div>
          </div>
          {showSwap && session && (
            <div className="swap-panel">
              {session.kind === 'image' ? (
                <>
                  <p className="swap-hint">When the installer asks for another disc, insert it here, then press OK in the installer.</p>
                  <ol className="disc-list">
                    {session.images.map((name, i) => (
                      <li key={name + i} className={i === session.current ? 'is-in' : ''}>
                        <span className="disc-num">Disc {i + 1}</span>
                        <span className="disc-file">{name}</span>
                        {i === session.current ? (
                          <span className="chip chip--ok"><i className="led" /> In {session.letter.toUpperCase()}:</span>
                        ) : (
                          <button
                            className="btn btn--small"
                            disabled={session.busy}
                            onClick={() => { setSwapError(undefined); api.swapDisc(i).catch((e) => setSwapError(errText(e))) }}
                          >
                            Insert
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <>
                  <p className="swap-hint">When the installer asks for another disc: eject, put the next disc in, wait until it shows up here, then press OK in the installer.</p>
                  <div className="row">
                    <span className={`chip ${session.label ? 'chip--ok' : 'chip--warn'}`}>
                      <i className="led" /> {session.label ? `“${session.label}” in ${session.letter.toUpperCase()}:` : drive.hasDisc ? `Reading “${drive.label ?? 'disc'}”…` : 'Drive empty – insert the next disc'}
                    </span>
                    <button className="btn btn--small" disabled={session.busy || !drive.hasDisc} onClick={() => { setSwapError(undefined); api.ejectSessionDisc().catch((e) => setSwapError(errText(e))) }}>
                      Eject
                    </button>
                    {session.labels.length > 1 && <span className="muted">Discs used: {session.labels.join(', ')}</span>}
                  </div>
                </>
              )}
              {(swapError || (session.message && !session.busy)) && <p className="stage-error">{swapError ?? session.message}</p>}
              {session.busy && session.message && <p className="muted">{session.message}</p>}
            </div>
          )}
          <pre className="log" ref={logRef}>{lines.join('\n')}</pre>
        </>
      )}
      {step === 'pick' && result && (
        <>
          {result.labels.length > 1 && <p className="muted">Discs used: {result.labels.join(', ')}</p>}
          {target && (
            <ul className="check-list addon-use">
              <li>
                <label>
                  <input type="radio" name="use" checked={use === 'separate'} onChange={() => setUse('separate')} disabled={!result.candidates.length} />
                  <span>Add it to the shelf as its own game<small>Shares {target.title}'s Windows environment{from === 'drive' && result.labels.length ? ` and is recognised by its own disc` : ''}.</small></span>
                </label>
              </li>
              <li>
                <label>
                  <input type="radio" name="use" checked={use === 'replace'} onChange={() => setUse('replace')} disabled={!result.candidates.length} />
                  <span>Start {target.title} with a new program<small>For expansions that replace the game's program.</small></span>
                </label>
              </li>
              <li>
                <label>
                  <input type="radio" name="use" checked={use === 'keep'} onChange={() => setUse('keep')} />
                  <span>Keep {target.title} as it is<small>For patches and add-ons the game loads by itself.{from === 'drive' && result.labels.length ? ' The add-on disc will also bring this game up.' : ''}</small></span>
                </label>
              </li>
            </ul>
          )}
          {(!target || use !== 'keep') && (
            <>
              <p>{result.candidates.length ? `Which program starts the ${discNoun}?` : `No new programs were found. You can pick the program in the editor.`}</p>
              <ul className="check-list">
                {result.candidates.slice(0, 14).map((c) => (
                  <li key={c.path}>
                    <label>
                      <input type="radio" name="exe" checked={chosen === c.path} onChange={() => setChosen(c.path)} />
                      <span>{fileName(c.path)}{c.path === result.targetExecutable ? <small>current program, updated</small> : null}</span>
                      <em>{c.path.replace(/^.*drive_c\//, 'C:/').split('/').slice(0, -1).join('/')} · {(c.size / 1048576).toFixed(1)} MB</em>
                    </label>
                  </li>
                ))}
              </ul>
              {(!!result.candidates.length || !!target) && (
                <PathInput value={chosen ?? ''} onChange={setChosen} onBrowse={async () => { const p = await api.pickFile({ title: 'Program', defaultPath: result.game.prefix }); if (p) setChosen(p) }} />
              )}
            </>
          )}
        </>
      )}
    </Modal>
  )
}

function prettyLabel(l?: string) {
  if (!l) return ''
  return l
    .replace(/_/g, ' ')
    .replace(/\d+$/, '')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
