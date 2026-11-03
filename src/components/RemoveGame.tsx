import { useEffect, useState } from 'react'
import type { Game, RemovalInfo } from '../../shared/types'
import { api } from '../api'
import { Modal, Toggle } from './Modal'

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Remove a game from the library, optionally with its add-on games and its Windows environment. */
export function RemoveGame({ game, onClose, onRemoved }: { game: Game; onClose(): void; onRemoved(ids: string[]): void }) {
  const [info, setInfo] = useState<RemovalInfo>()
  const [addons, setAddons] = useState(true)
  const [prefix, setPrefix] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.removalInfo(game.id).then(setInfo, (e) => setError(errText(e)))
  }, [game.id])

  const hasAddons = !!info?.addonGames.length
  const prefixBlocked = !!info?.prefixNote || (!!info?.prefixNeedsAddons && !addons)
  const deletePrefix = prefix && !prefixBlocked

  async function remove() {
    setBusy(true)
    setError(undefined)
    try {
      onRemoved(await api.deleteGame(game.id, { addons: hasAddons && addons, prefix: deletePrefix }))
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Remove ${game.title}`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="stage-error foot-error">{error}</span>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Keep it</button>
          <button className="btn btn--danger" onClick={remove} disabled={!info || busy}>
            {deletePrefix ? 'Remove and delete files' : 'Remove'}
          </button>
        </>
      }
    >
      <p>
        {game.title} leaves the shelf, together with its cached artwork and launch log.
        {!deletePrefix && info?.prefix && ' The installed game stays on disk.'}
      </p>
      {hasAddons && (
        <Toggle
          checked={addons}
          onChange={setAddons}
          label={`Also remove its add-on${info!.addonGames.length > 1 ? 's' : ''}: ${info!.addonGames.map((g) => g.title).join(', ')}`}
        />
      )}
      {info?.prefix && (
        <>
          <Toggle checked={deletePrefix} disabled={prefixBlocked} onChange={setPrefix} label="Also delete its Windows environment (the installed game)" />
          <p className="muted remove-path">{info.prefix}</p>
          {info.prefixNote && <p className="muted">{info.prefixNote}</p>}
          {!info.prefixNote && info.prefixNeedsAddons && !addons && <p className="muted">Its add-ons use the same environment, so it can only be deleted together with them.</p>}
          {deletePrefix && <p className="stage-error">Everything installed in it is deleted, save games included. This can't be undone.</p>}
        </>
      )}
    </Modal>
  )
}
