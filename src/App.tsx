import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BroadcastEditor } from "./components/BroadcastEditor";
import { ErrorNotice, Thumbnail } from "./components/Fields";
import { Header } from "./components/Header";
import { HelperPanel } from "./components/HelperPanel";
import { OperationCard } from "./components/Operations";
import { PlaylistEditor } from "./components/PlaylistEditor";
import { errorMessage, type BroadcastOperation, type ManagedPlaylist } from "./domain/types";
import { authSessionFor } from "./services/auth";
import { createBroadcastService, isUnfinished, withChannelLock } from "./services/broadcasts";
import { gameHelper } from "./services/helper";
import { syncLibrary } from "./services/sync";
import { YouTubeClient } from "./services/youtube";
import { authStateAtom, type ChannelSummary } from "./state/auth";
import { exportLibrary, importLibrary } from "./storage/backup";
import { libraryStore } from "./storage/database";

function downloadBackup(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = "gameplay-library.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Workspace({ channel }: { channel: ChannelSummary }) {
  const auth = useAtomValue(authStateAtom);
  const atomStore = useStore();
  const connected = auth.status === "authenticated";
  const importInput = useRef<HTMLInputElement>(null);
  const [playlists, setPlaylists] = useState<ManagedPlaylist[]>([]);
  const [operations, setOperations] = useState<BroadcastOperation[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [editor, setEditor] = useState<"create" | "import" | "edit">();
  const [broadcast, setBroadcast] = useState<{ playlist: ManagedPlaylist; count: number }>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [embedRevision, setEmbedRevision] = useState(0);

  const api = useMemo(
    () => new YouTubeClient(() => authSessionFor(atomStore).accessToken(channel.id)),
    [atomStore, channel.id],
  );

  const refresh = useCallback(async () => {
    const [savedPlaylists, savedOperations] = await Promise.all([
      libraryStore.playlists(channel.id),
      libraryStore.operations(channel.id),
    ]);

    setPlaylists(
      savedPlaylists.sort((first, second) => first.seriesName.localeCompare(second.seriesName)),
    );
    setOperations(savedOperations);
  }, [channel.id]);

  useEffect(() => {
    let active = true;

    void Promise.all([libraryStore.playlists(channel.id), libraryStore.operations(channel.id)])
      .then(([savedPlaylists, savedOperations]) => {
        if (active) {
          setPlaylists(
            savedPlaylists.sort((first, second) =>
              first.seriesName.localeCompare(second.seriesName),
            ),
          );
          setOperations(savedOperations);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [channel.id]);

  const selected = playlists.find((playlist) => playlist.playlistId === selectedId) ?? playlists[0];
  const recentOperations = [...operations].sort((first, second) =>
    second.createdAt.localeCompare(first.createdAt),
  );
  const unfinished = operations.filter(isUnfinished);
  const visibleOperations = [
    ...unfinished,
    ...recentOperations.filter((operation) => !isUnfinished(operation)).slice(0, 5),
  ];

  function onProgress(operation: BroadcastOperation) {
    setOperations((previous) => [
      ...previous.filter((item) => item.id !== operation.id),
      operation,
    ]);
  }

  async function action(task: () => Promise<void>) {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(undefined);
    setNotice(undefined);

    try {
      await task();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-7xl space-y-7 px-5 py-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Your gameplay library
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-sm"
            disabled={busy}
            type="button"
            onClick={() =>
              void action(async () => downloadBackup(await exportLibrary(libraryStore)))
            }
          >
            Export library
          </button>
          <button
            className="btn btn-sm"
            disabled={busy}
            type="button"
            onClick={() => importInput.current?.click()}
          >
            Import backup
          </button>
          <button
            className="btn btn-sm"
            disabled={!connected || busy}
            type="button"
            onClick={() =>
              void action(async () => {
                await withChannelLock(channel.id, () => syncLibrary(channel.id, api, libraryStore));
                await refresh();
                setEmbedRevision((previous) => previous + 1);
              })
            }
          >
            Refresh from YouTube
          </button>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            aria-label="Import a library backup"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";

              if (file) {
                void action(async () => {
                  const added = await importLibrary(libraryStore, await file.text());
                  await refresh();
                  setNotice(`Imported ${added} playlists.`);
                });
              }
            }}
          />
        </div>
      </div>
      <ErrorNotice message={auth.errorMessage ?? error} />
      {notice ? <output className="alert text-sm">{notice}</output> : null}
      <HelperPanel channelId={channel.id} />
      <div className="grid gap-8 lg:grid-cols-[18rem_1fr]">
        <aside className="space-y-5" aria-label="Managed playlists">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Series</h2>
            <span className="text-base-content/60 text-sm">{playlists.length}</span>
          </div>
          <div className="flex gap-2">
            <button
              className="btn btn-sm flex-1"
              type="button"
              disabled={!connected || busy}
              onClick={() => setEditor("create")}
            >
              New playlist
            </button>
            <button
              className="btn btn-sm flex-1"
              type="button"
              disabled={!connected || busy}
              onClick={() => setEditor("import")}
            >
              Import playlist
            </button>
          </div>
          <div className="space-y-2">
            {playlists.map((playlist) => (
              <button
                className={`hover:bg-base-200 w-full rounded-xl p-4 text-left ${selected?.playlistId === playlist.playlistId ? "bg-base-200 ring-base-300 ring-1" : ""}`}
                key={playlist.playlistId}
                type="button"
                aria-pressed={selected?.playlistId === playlist.playlistId}
                onClick={() => setSelectedId(playlist.playlistId)}
              >
                <span className="block font-semibold">{playlist.seriesName}</span>
                <span className="text-base-content/60 mt-1 block text-xs leading-relaxed">
                  {playlist.game.title}
                </span>
              </button>
            ))}
          </div>
          {loading ? <output className="text-sm">Loading your library…</output> : null}
        </aside>
        <section className="min-w-0">
          {selected ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold">{selected.seriesName}</h2>
                  <p className="text-base-content/60 mt-2 text-sm">
                    {selected.game.title} · {selected.audioLanguage}
                  </p>
                </div>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={
                    !connected ||
                    busy ||
                    unfinished.some((operation) => operation.playlistId === selected.playlistId)
                  }
                  onClick={() =>
                    void action(async () => {
                      const count = await api.availableCount(selected.playlistId);
                      setBroadcast({ playlist: selected, count });
                    })
                  }
                >
                  {busy ? "Loading…" : "Prepare broadcast"}
                </button>
              </div>
              <iframe
                key={`${selected.playlistId}:${embedRevision}`}
                title={`${selected.name} playlist`}
                className="bg-base-200 aspect-video w-full rounded-xl"
                src={`https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(selected.playlistId)}`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <Thumbnail
                    blob={selected.thumbnail}
                    className="aspect-video w-24 rounded-lg object-cover"
                  />
                  <div>
                    <p className="text-sm font-medium">{selected.name}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <a
                    className="btn btn-sm"
                    href={`https://www.youtube.com/playlist?list=${selected.playlistId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open playlist
                  </a>
                  <button className="btn btn-sm" type="button" onClick={() => setEditor("edit")}>
                    Edit defaults
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="border-base-300 flex min-h-80 flex-col items-start justify-center rounded-2xl border border-dashed p-8 sm:p-12">
              <h2 className="text-2xl font-semibold">Add your first series</h2>
              <button
                className="btn mt-6"
                type="button"
                disabled={!connected}
                onClick={() => setEditor("import")}
              >
                Import an existing playlist
              </button>
            </div>
          )}
        </section>
      </div>
      {visibleOperations.length ? (
        <section className="border-base-300 space-y-4 border-t pt-7" aria-label="Recent broadcasts">
          <h2 className="text-xl font-semibold">Broadcasts</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {visibleOperations.map((operation) => (
              <OperationCard
                key={operation.id}
                operation={operation}
                api={api}
                connected={connected}
                onProgress={onProgress}
              />
            ))}
          </div>
        </section>
      ) : null}
      {editor && (editor !== "edit" || selected) ? (
        <PlaylistEditor
          channelId={channel.id}
          api={api}
          mode={editor}
          existing={editor === "edit" ? selected : undefined}
          onClose={() => setEditor(undefined)}
          onSaved={(playlist) => {
            setPlaylists((previous) => [
              ...previous.filter((item) => item.playlistId !== playlist.playlistId),
              playlist,
            ]);
            setSelectedId(playlist.playlistId);
            setEditor(undefined);
          }}
        />
      ) : null}
      {broadcast ? (
        <BroadcastEditor
          playlist={broadcast.playlist}
          channelTitle={channel.title}
          availableCount={broadcast.count}
          onClose={() => setBroadcast(undefined)}
          onReview={async () => {
            await Promise.all([
              api.ownedPlaylist(broadcast.playlist.playlistId, channel.id),
              gameHelper.status(channel.id),
            ]);
          }}
          onCreate={async (draft, progress) => {
            const service = createBroadcastService({
              api,
              helper: gameHelper,
              store: libraryStore,
              onProgress: (operation) => {
                onProgress(operation);
                progress(operation);
              },
            });

            await withChannelLock(channel.id, () => service.create(broadcast.playlist, draft));
          }}
        />
      ) : null}
    </main>
  );
}

function App() {
  const auth = useAtomValue(authStateAtom);

  return (
    <div className="bg-base-100 text-base-content min-h-screen">
      <Header />
      {auth.channel ? (
        <Workspace key={auth.channel.id} channel={auth.channel} />
      ) : (
        <main className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:py-32">
          <section>
            <h1 className="max-w-xl text-5xl leading-tight font-semibold tracking-tight sm:text-6xl">
              Your gameplay,
              <br />
              in order.
            </h1>
            <p className="text-base-content/70 mt-7 max-w-lg text-lg leading-relaxed">
              Manage your playlists and prepare YouTube broadcasts.
            </p>
            <div className="mt-6">
              <ErrorNotice message={auth.errorMessage} />
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

export default App;
