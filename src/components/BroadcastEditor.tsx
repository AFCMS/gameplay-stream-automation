import { useState, type FormEvent } from "react";

import {
  broadcastTitle,
  errorMessage,
  publicUrl,
  studioUrl,
  validateDraft,
  type BroadcastDraft,
  type BroadcastOperation,
  type ManagedPlaylist,
} from "../domain/types";
import { ErrorNotice, Field, GamePicker, LanguageField, ThumbnailField } from "./Fields";
import { Modal } from "./Modal";

export function BroadcastEditor({
  playlist,
  channelTitle,
  availableCount,
  onClose,
  onReview,
  onCreate,
}: {
  playlist: ManagedPlaylist;
  channelTitle: string;
  availableCount: number;
  onClose: () => void;
  onReview: () => Promise<void>;
  onCreate: (
    draft: BroadcastDraft,
    onProgress: (operation: BroadcastOperation) => void,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState<BroadcastDraft>({
    title: broadcastTitle(playlist.seriesName, availableCount + 1),
    episode: availableCount + 1,
    game: playlist.game,
    audioLanguage: playlist.audioLanguage,
    thumbnail: playlist.thumbnail,
    madeForKids: false,
  });
  const [customTitle, setCustomTitle] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BroadcastOperation>();
  const [error, setError] = useState<string>();

  async function review(event: FormEvent) {
    event.preventDefault();

    if (busy) {
      return;
    }

    setBusy(true);

    try {
      validateDraft(draft);
      setError(undefined);
      await onReview();
      setConfirming(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (busy) {
      return;
    }

    setBusy(true);
    setConfirming(false);
    setError(undefined);

    try {
      await onCreate(draft, setProgress);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal title="Prepare a broadcast" onClose={onClose} busy={busy}>
        <p className="text-base-content/70 mb-6 text-sm">
          {playlist.name} · {availableCount} {availableCount === 1 ? "video" : "videos"}
        </p>
        <form className="space-y-6" onSubmit={(event) => void review(event)}>
          <fieldset className="space-y-6" disabled={busy}>
            <div className="grid gap-5 sm:grid-cols-[7rem_1fr]">
              <Field label="Episode">
                <input
                  className="input w-full"
                  type="number"
                  min={1}
                  step={1}
                  required
                  value={draft.episode}
                  onChange={(event) => {
                    const episode = event.target.valueAsNumber;
                    setDraft({
                      ...draft,
                      episode,
                      title: customTitle
                        ? draft.title
                        : broadcastTitle(playlist.seriesName, episode),
                    });
                  }}
                />
              </Field>
              <Field label="Broadcast title">
                <input
                  className="input w-full"
                  required
                  maxLength={100}
                  value={draft.title}
                  onChange={(event) => {
                    setCustomTitle(true);
                    setDraft({ ...draft, title: event.target.value });
                  }}
                />
              </Field>
            </div>
            <GamePicker
              channelId={playlist.channelId}
              value={draft.game}
              onChange={(game) => setDraft({ ...draft, game })}
            />
            <LanguageField
              value={draft.audioLanguage}
              onChange={(audioLanguage) => setDraft({ ...draft, audioLanguage })}
            />
            <ThumbnailField
              value={draft.thumbnail}
              onChange={(thumbnail) => setDraft({ ...draft, thumbnail })}
            />
            <label className="flex items-center gap-3 text-sm">
              <input
                className="checkbox"
                type="checkbox"
                checked={draft.madeForKids}
                onChange={(event) => setDraft({ ...draft, madeForKids: event.target.checked })}
              />
              Made for kids
            </label>
          </fieldset>
          <ErrorNotice message={error} />
          {progress ? (
            <div className="bg-base-200 space-y-3 rounded-xl p-4 text-sm" aria-live="polite">
              <p>{progress.broadcastId ? "Applying settings…" : "Creating…"}</p>
              {progress.broadcastId ? (
                <>
                  <div className="flex flex-wrap gap-4">
                    <a
                      className="link"
                      href={publicUrl(progress.broadcastId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Public video
                    </a>
                    <a
                      className="link"
                      href={studioUrl(progress.broadcastId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Studio dashboard
                    </a>
                  </div>
                  {!progress.completedSteps.includes("game") ? (
                    <a
                      className="link"
                      href="https://studio.youtube.com/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Studio
                    </a>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          <div className="flex justify-end gap-3 pt-2">
            <button className="btn" type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Preparing…" : "Review broadcast"}
            </button>
          </div>
        </form>
      </Modal>
      {confirming ? (
        <Modal title="Create a public broadcast?" onClose={() => setConfirming(false)}>
          <div className="space-y-6">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-base-content/60">Channel</dt>
              <dd>{channelTitle}</dd>
              <dt className="text-base-content/60">Playlist</dt>
              <dd>{playlist.name}</dd>
              <dt className="text-base-content/60">Title</dt>
              <dd className="font-semibold">{draft.title}</dd>
              <dt className="text-base-content/60">Game</dt>
              <dd>{draft.game.title}</dd>
              <dt className="text-base-content/60">Visibility</dt>
              <dd>Public</dd>
            </dl>
            <div className="flex justify-end gap-3">
              <button className="btn" type="button" onClick={() => setConfirming(false)}>
                Go back
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => void create()}>
                Create public broadcast
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
