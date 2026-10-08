import { useState, type FormEvent } from "react";

import {
  errorMessage,
  isLanguage,
  parsePlaylistId,
  type Game,
  type ManagedPlaylist,
} from "../domain/types";
import { withChannelLock } from "../services/broadcasts";
import type { YouTubeClient, YouTubePlaylist } from "../services/youtube";
import { libraryStore } from "../storage/database";
import { ErrorNotice, Field, GamePicker, LanguageField, ThumbnailField } from "./Fields";
import { Modal } from "./Modal";

export function PlaylistEditor({
  channelId,
  api,
  existing,
  mode,
  onClose,
  onSaved,
}: {
  channelId: string;
  api: YouTubeClient;
  existing?: ManagedPlaylist;
  mode: "create" | "import" | "edit";
  onClose: () => void;
  onSaved: (playlist: ManagedPlaylist) => void;
}) {
  const [seriesName, setSeriesName] = useState(existing?.seriesName ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [customName, setCustomName] = useState(Boolean(existing));
  const [game, setGame] = useState<Game | undefined>(existing?.game);
  const [audioLanguage, setAudioLanguage] = useState(existing?.audioLanguage ?? "en");
  const [thumbnail, setThumbnail] = useState(existing?.thumbnail);
  const [importInput, setImportInput] = useState("");
  const [owned, setOwned] = useState<YouTubePlaylist[]>([]);
  const [selected, setSelected] = useState<YouTubePlaylist>();
  const [created, setCreated] = useState<YouTubePlaylist>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [creationUncertain, setCreationUncertain] = useState(false);

  const effectiveName = customName ? name : seriesName ? `${seriesName} - Gameplay` : "";

  function choose(playlist: YouTubePlaylist) {
    setSelected(playlist);
    setName(playlist.snippet.title);
    setCustomName(true);
    setSeriesName(playlist.snippet.title.replace(/\s*- Gameplay$/, ""));
  }

  async function discover(useInput: boolean) {
    setBusy(true);
    setError(undefined);

    try {
      if (useInput) {
        choose(await api.ownedPlaylist(parsePlaylistId(importInput), channelId));
      } else {
        setOwned(await api.ownedPlaylists(channelId));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();

    if (busy || creationUncertain) {
      return;
    }

    if (!game || !seriesName.trim() || !isLanguage(audioLanguage)) {
      setError("Enter a series name, select a YouTube game, and choose a valid audio language.");
      return;
    }

    if (mode === "import" && !selected) {
      setError("Select an owned playlist first.");
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      await withChannelLock(channelId, async () => {
        let remote = selected ?? created;

        if (mode === "create" && !remote) {
          try {
            remote = await api.createPlaylist(effectiveName.trim());
            setCreated(remote);
          } catch (cause) {
            setCreationUncertain(true);
            throw new Error(
              `${errorMessage(cause)} Check your channel’s playlists and import it if it was created.`,
            );
          }
        }

        const playlist: ManagedPlaylist = {
          channelId,
          playlistId: existing?.playlistId ?? remote!.id,
          name: existing?.name ?? remote!.snippet.title,
          seriesName: seriesName.trim(),
          game,
          audioLanguage,
          thumbnail,
          source: existing?.source ?? (mode === "create" ? "created" : "imported"),
          updatedAt: new Date().toISOString(),
        };

        if (
          remote &&
          (remote.snippet.channelId !== channelId ||
            (mode === "create" && remote.status?.privacyStatus !== "public"))
        ) {
          throw new Error(
            "YouTube did not create a public playlist on the expected channel. Review it in Studio.",
          );
        }

        const current = await libraryStore.playlists(channelId);

        if (!existing && current.some((item) => item.playlistId === playlist.playlistId)) {
          throw new Error(
            "This playlist is already in your library. Edit its existing entry instead.",
          );
        }

        await libraryStore.putPlaylist(playlist);
        onSaved(playlist);
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        mode === "edit"
          ? "Playlist defaults"
          : mode === "import"
            ? "Import a YouTube playlist"
            : "Create a playlist"
      }
      onClose={onClose}
      busy={busy}
    >
      <form className="space-y-6" onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy} className="space-y-6">
          {mode === "import" ? (
            <div className="space-y-3">
              <Field label="Playlist URL or ID">
                <input
                  className="input w-full"
                  value={importInput}
                  onChange={(event) => setImportInput(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn"
                  type="button"
                  onClick={() => void discover(true)}
                  disabled={!importInput.trim()}
                >
                  Find playlist
                </button>
                <button className="btn" type="button" onClick={() => void discover(false)}>
                  Browse my playlists
                </button>
              </div>
              {owned.length ? (
                <Field label="Your playlists">
                  <select
                    className="select w-full"
                    value={selected?.id ?? ""}
                    onChange={(event) => {
                      const playlist = owned.find((item) => item.id === event.target.value);
                      if (playlist) {
                        choose(playlist);
                      }
                    }}
                  >
                    <option value="">Choose a playlist</option>
                    {owned.map((playlist) => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.snippet.title}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {selected ? (
                <p className="text-sm">
                  <strong>{selected.snippet.title}</strong>
                </p>
              ) : null}
            </div>
          ) : null}
          <Field label="Series name">
            <input
              className="input w-full"
              required
              maxLength={100}
              value={seriesName}
              onChange={(event) => setSeriesName(event.target.value)}
            />
          </Field>
          {mode === "create" ? (
            <Field label="YouTube playlist name">
              <input
                className="input w-full"
                required
                maxLength={150}
                value={effectiveName}
                onChange={(event) => {
                  setCustomName(true);
                  setName(event.target.value);
                }}
              />
            </Field>
          ) : null}
          <GamePicker channelId={channelId} value={game} onChange={setGame} />
          <LanguageField value={audioLanguage} onChange={setAudioLanguage} />
          <ThumbnailField value={thumbnail} onChange={setThumbnail} />
        </fieldset>
        <ErrorNotice message={error} />
        {created ? (
          <p className="text-sm">
            Playlist created:{" "}
            <a
              className="link"
              target="_blank"
              rel="noreferrer"
              href={`https://www.youtube.com/playlist?list=${created.id}`}
            >
              Open on YouTube
            </a>
          </p>
        ) : null}
        <div className="flex justify-end gap-3 pt-2">
          <button className="btn" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || creationUncertain}>
            {busy ? "Saving…" : mode === "create" ? "Create public playlist" : "Save playlist"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
