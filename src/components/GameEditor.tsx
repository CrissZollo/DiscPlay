import { useEffect, useState } from 'react'
import type { DriveState, Game, GameArt, RunnerInfo } from '../../shared/types'
import { api, artUrl } from '../api'
import { ArtPicker } from './ArtPicker'
import { Disc } from './Disc'
import { RemoveGame } from './RemoveGame'
import { Field, Modal, PathInput, Toggle } from './Modal'

interface Props {
  game: Game
  isNew: boolean
  drive: DriveState
  onClose(): void
  onSaved(g: Game): void
  onDeleted(id: string): void
  onInstallAddon(g: Game): void
  toast(msg: string, kind?: 'error'): void
  library: Game[]
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`)

function splitArgs(line: string) {
  const out: string[] = []
  const re = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]))
  return out
}

export function GameEditor({ game: initial, isNew, drive, onClose, onSaved, onDeleted, onInstallAddon, toast, library }: Props) {
  const [g, setG] = useState<Game>(initial)
  const [args, setArgs] = useState(initial.args.map(quote).join(' '))
  const [env, setEnv] = useState(Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join('\n'))
  const [labels, setLabels] = useState(initial.disc.labels.join(', '))
  const [images, setImages] = useState<string[]>(
    initial.disc.images?.length ? initial.disc.images : [initial.disc.imagePath ?? ''],
  )
  const [runners, setRunners] = useState<RunnerInfo>()
  const [picker, setPicker] = useState<keyof GameArt | null>(null)
  const [log, setLog] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    api.getRunners().then(setRunners)
  }, [])

  const set = <K extends keyof Game>(k: K, v: Game[K]) => setG((x) => ({ ...x, [k]: v }))
  const setDisc = (patch: Partial<Game['disc']>) => setG((x) => ({ ...x, disc: { ...x.disc, ...patch } }))

  async function browse(kind: 'exe' | 'prefix' | 'image' | 'wrapper' | 'cwd', index = 0) {
    const opts = {
      exe: { title: 'Choose the game program', filters: [{ name: 'Programs', extensions: ['exe', 'bat', 'sh', 'AppImage', 'x86_64', '*'] }] },
      prefix: { title: 'Choose the Wine prefix folder', directory: true },
      image: { title: 'Choose a disc image', filters: [{ name: 'Disc images', extensions: ['iso', 'img', 'ISO', 'IMG'] }] },
      wrapper: { title: 'Choose a wrapper script' },
      cwd: { title: 'Choose the working folder', directory: true },
    }[kind]
    const p = await api.pickFile({ ...opts, defaultPath: kind === 'exe' && g.prefix ? `${g.prefix}/drive_c` : undefined })
    if (!p) return
    if (kind === 'exe') {
      setG((x) => ({ ...x, executable: p, workingDir: undefined, title: x.title || p.split('/').pop()!.replace(/\.(exe|sh|bat)$/i, '') }))
      const m = /^(.*?)\/(?:pfx\/)?drive_c\//.exec(p)
      if (m && !g.prefix) set('prefix', m[1])
    } else if (kind === 'prefix') set('prefix', p)
    else if (kind === 'image') {
      // Picking disc 1 of a set pulls in the other discs next to it.
      const set = index === 0 && images.filter(Boolean).length <= 1 ? await api.findDiscSet(p) : [p]
      setImages((x) => {
        const n = [...x]
        n.splice(index, set.length === 1 ? 1 : n.length, ...set)
        return n.filter((v, i) => v || i === 0)
      })
      setDisc({ source: 'image' })
    }
    else if (kind === 'wrapper') set('wrapper', quote(p))
    else set('workingDir', p)
  }

  async function chooseLocalArt(kind: keyof GameArt) {
    const p = await api.pickFile({ title: `Choose ${kind} image`, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico'] }] })
    if (!p) return
    const name = await api.importArt(g.id, kind, p)
    setG((x) => ({ ...x, art: { ...x.art, [kind]: name } }))
  }

  async function save() {
    if (!g.title.trim()) return toast('Give the game a title.', 'error')
    const envObj: Record<string, string> = {}
    for (const line of env.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) envObj[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    const out: Game = {
      ...g,
      title: g.title.trim(),
      args: splitArgs(args),
      env: envObj,
      disc: {
        ...g.disc,
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
        images: images.map((s) => s.trim()).filter(Boolean),
        imagePath: images.map((s) => s.trim()).find(Boolean),
      },
    }
    onSaved(await api.saveGame(out))
  }

  const preview: Game = { ...g, disc: { ...g.disc } }

  return (
    <Modal
      wide
      title={isNew ? 'Add a game' : `Edit · ${initial.title}`}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button className="btn btn--ghost btn--small" onClick={() => setConfirmDelete(true)}>Remove…</button>
          )}
          <span className="spacer" />
          {!isNew && initial.runner !== 'native' && initial.prefix && (
            <button className="btn btn--small" onClick={() => onInstallAddon(initial)} title="Install an expansion or patch disc into this game (unsaved changes here are dropped)">
              Install add-on…
            </button>
          )}
          {!isNew && <button className="btn btn--small" onClick={async () => setLog(await api.readLog(g.id))}>Last log</button>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="editor">
        <aside className="editor-preview">
          <div className="spin editor-spin" style={{ '--angle': '-18deg' } as React.CSSProperties}>
            <Disc game={preview} size={210} />
          </div>
          <div className="art-grid">
            {(['cover', 'hero', 'logo', 'disc'] as const).map((k) => (
              <div key={k} className={`art-slot art-slot--${k}`}>
                <div className="art-thumb" style={g.art[k] ? { backgroundImage: `url("${artUrl(g.art[k])}")` } : undefined}>
                  {!g.art[k] && <span>{k === 'disc' ? 'Disc label' : k[0].toUpperCase() + k.slice(1)}</span>}
                </div>
                <div className="art-actions">
                  <button className="btn btn--tiny" onClick={() => setPicker(k)} title="Search SteamGridDB">Search</button>
                  <button className="btn btn--tiny" onClick={() => chooseLocalArt(k)}>File</button>
                  {g.art[k] && <button className="btn btn--tiny btn--ghost" onClick={() => setG((x) => ({ ...x, art: { ...x.art, [k]: undefined } }))}>✕</button>}
                </div>
              </div>
            ))}
          </div>
          {!g.art.cover && !g.art.disc && (
            <Field label="Disc colour">
              <input type="color" value={hslToHex(g.color)} onChange={(e) => set('color', e.target.value)} />
            </Field>
          )}
        </aside>

        <div className="editor-form">
          <div className="grid2">
            <Field label="Title">
              <input value={g.title} onChange={(e) => set('title', e.target.value)} autoFocus={isNew} />
            </Field>
            <Field label="Year">
              <input value={g.year ?? ''} onChange={(e) => set('year', e.target.value)} placeholder="2003" />
            </Field>
          </div>

          <h3>Launch</h3>
          <div className="seg">
            {(['umu', 'wine', 'native'] as const).map((r) => (
              <button key={r} className={g.runner === r ? 'is-on' : ''} onClick={() => set('runner', r)}>
                {r === 'umu' ? 'Proton (umu)' : r === 'wine' ? 'Wine' : 'Linux native'}
              </button>
            ))}
          </div>
          <Field label="Program">
            <PathInput value={g.executable} onChange={(v) => set('executable', v)} onBrowse={() => browse('exe')} placeholder="/path/to/game.exe" />
          </Field>
          <Field label="Arguments">
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-window -nosound" spellCheck={false} />
          </Field>
          {g.runner !== 'native' && (
            <div className="grid2">
              <Field label="Wine prefix" hint="Each game can have its own Windows environment.">
                <PathInput value={g.prefix ?? ''} onChange={(v) => set('prefix', v || undefined)} onBrowse={() => browse('prefix')} placeholder="~/Games/DiscPlay/Prefixes/Game" />
              </Field>
              {g.runner === 'umu' ? (
                <Field label="Proton" hint={runners && !runners.umu ? '⚠ umu-launcher not found' : undefined}>
                  <select value={g.protonPath ?? ''} onChange={(e) => set('protonPath', e.target.value || undefined)}>
                    <option value="">Default (newest)</option>
                    {runners?.protons.map((p) => (
                      <option key={p.path} value={p.path}>{p.name}</option>
                    ))}
                    {g.protonPath && !runners?.protons.some((p) => p.path === g.protonPath) && <option value={g.protonPath}>{g.protonPath}</option>}
                  </select>
                </Field>
              ) : (
                <Field label="Wine binary">
                  <input value={g.wineBinary ?? ''} onChange={(e) => set('wineBinary', e.target.value || undefined)} placeholder={runners?.wine ?? 'wine'} />
                </Field>
              )}
            </div>
          )}

          <h3>Disc</h3>
          <div className="seg">
            {(['none', 'drive', 'image'] as const).map((s) => (
              <button key={s} className={g.disc.source === s ? 'is-on' : ''} onClick={() => setDisc({ source: s })}>
                {s === 'none' ? 'No disc' : s === 'drive' ? 'Disc in drive' : 'Disc image (ISO)'}
              </button>
            ))}
          </div>
          {g.disc.source === 'drive' && (
            <Field
              label="Disc labels"
              hint="Volume labels of this game's discs, comma separated. Inserting one of them brings this game up."
            >
              <div className="path-input">
                <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="DSLOA1, DSLOA2" spellCheck={false} />
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={!drive.hasDisc || !drive.label}
                  onClick={() => {
                    const cur = labels.split(',').map((s) => s.trim()).filter(Boolean)
                    if (drive.label && !cur.includes(drive.label)) setLabels([...cur, drive.label].join(', '))
                  }}
                >
                  {drive.hasDisc && drive.label ? `Add “${drive.label}”` : 'No disc in drive'}
                </button>
              </div>
            </Field>
          )}
          {g.disc.source === 'image' && (
            <div className="field">
              <span className="field-label">Disc images</span>
              {images.map((img, i) => (
                <div className="path-input disc-row" key={i}>
                  <span className="disc-num">Disc {i + 1}</span>
                  <input value={img} onChange={(e) => setImages(images.map((x, j) => (j === i ? e.target.value : x)))} spellCheck={false} placeholder="/path/to/disc.iso" />
                  <button type="button" className="btn btn--small" onClick={() => browse('image', i)}>Browse…</button>
                  {images.length > 1 && (
                    <button type="button" className="btn btn--small btn--ghost" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label={`Remove disc ${i + 1}`}>✕</button>
                  )}
                </div>
              ))}
              <div className="row">
                <button type="button" className="btn btn--small" onClick={() => browse('image', images.length)}>Add disc…</button>
                <span className="field-hint">Disc 1 goes in at launch. Change discs on the play screen while the game runs.</span>
              </div>
            </div>
          )}
          {g.disc.source !== 'none' && (
            <div className="row">
              <Field label="Drive letter">
                <select value={g.disc.letter} onChange={(e) => setDisc({ letter: e.target.value })} style={{ width: 90 }}>
                  {'defghijklmnopqrstuvwxy'.split('').map((l) => (
                    <option key={l} value={l}>{l.toUpperCase()}:</option>
                  ))}
                </select>
              </Field>
              {g.disc.source === 'drive' && (
                <Toggle checked={g.disc.required} onChange={(v) => setDisc({ required: v })} label="The game needs its disc to start" />
              )}
            </div>
          )}

          {(!!g.addons?.length || g.addonOf) && (
            <>
              <h3>Add-ons</h3>
              {g.addonOf && <p className="muted">Add-on of {library.find((x) => x.id === g.addonOf)?.title ?? 'another game'} – shares its Windows environment.</p>}
              {!!g.addons?.length && (
                <ul className="addon-list">
                  {g.addons.map((a) => (
                    <li key={a.id}>
                      <strong>{a.title}</strong>
                      <span className="muted">
                        {[a.labels.length ? `disc ${a.labels.join(', ')}` : '', `installed ${new Date(a.installedAt).toLocaleDateString()}`].filter(Boolean).join(' · ')}
                      </span>
                      <button
                        type="button"
                        className="btn btn--tiny btn--ghost"
                        title="Forget this add-on (its files stay installed)"
                        onClick={() => setG((x) => ({ ...x, addons: x.addons?.filter((y) => y.id !== a.id) }))}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <details className="advanced">
            <summary>Advanced</summary>
            <Field label="Wrapper command" hint="Put in front of the launch command, e.g. a disc wrapper script or gamescope -w 640 -h 480 --">
              <PathInput value={g.wrapper ?? ''} onChange={(v) => set('wrapper', v || undefined)} onBrowse={() => browse('wrapper')} />
            </Field>
            <Field label="Working folder">
              <PathInput value={g.workingDir ?? ''} onChange={(v) => set('workingDir', v || undefined)} onBrowse={() => browse('cwd')} placeholder="Folder of the program" />
            </Field>
            <Field label="Environment variables" hint="One per line, KEY=value">
              <textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} placeholder="PROTON_USE_WINED3D=1" />
            </Field>
            <Field label="Notes">
              <textarea rows={2} value={g.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </details>
        </div>
      </div>

      {picker && (
        <ArtPicker
          kind={picker}
          term={g.title}
          onClose={() => setPicker(null)}
          onPick={async (url) => {
            try {
              const name = await api.importArt(g.id, picker, url)
              setG((x) => ({ ...x, art: { ...x.art, [picker]: name } }))
              setPicker(null)
            } catch (e) {
              toast((e as Error).message, 'error')
            }
          }}
        />
      )}
      {log !== undefined && (
        <Modal wide title="Last launch log" onClose={() => setLog(undefined)}>
          <pre className="log">{log}</pre>
        </Modal>
      )}
      {confirmDelete && <RemoveGame game={initial} onClose={() => setConfirmDelete(false)} onRemoved={(ids) => ids.forEach(onDeleted)} />}
    </Modal>
  )
}

function hslToHex(c: string) {
  if (c.startsWith('#')) return c
  const m = /hsl\((\d+)\s+(\d+)%\s+(\d+)%/.exec(c)
  if (!m) return '#4aa3df'
  const h = +m[1] / 360
  const s = +m[2] / 100
  const l = +m[3] / 100
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
