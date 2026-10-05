import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";

import { authStateAtom } from "../state/auth";
import { playlistPostfix } from "../utils/constants";

const PLAYLISTS_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlists";

interface PlaylistSnippet {
  readonly title?: string;
  readonly publishedAt?: string;
}

interface PlaylistItem {
  readonly id?: string;
  readonly snippet?: PlaylistSnippet;
}

interface PlaylistResponse {
  readonly items?: readonly PlaylistItem[];
  readonly nextPageToken?: string;
}

interface PlaylistRow {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

interface PlaylistState {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly playlists: readonly PlaylistRow[];
  readonly errorMessage: string | null;
}

const initialPlaylistState = {
  status: "idle",
  playlists: [],
  errorMessage: null,
} as const satisfies PlaylistState;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

const getPlaylistUrl = (playlistId: string): string =>
  `https://www.youtube.com/playlist?list=${playlistId}`;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Unable to load playlists.";
};

const getPlaylistRow = (item: PlaylistItem): PlaylistRow | null => {
  const id = item.id;
  const title = item.snippet?.title;
  // YouTube playlists do not expose a separate updated timestamp.
  const updatedAt = item.snippet?.publishedAt;

  if (!id || !title || !updatedAt) {
    return null;
  }

  if (!title.trim().endsWith(playlistPostfix)) {
    return null;
  }

  return {
    id,
    title,
    updatedAt,
  };
};

const fetchPlaylists = async (
  accessToken: string,
  signal: AbortSignal,
): Promise<readonly PlaylistRow[]> => {
  const playlists: PlaylistRow[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(PLAYLISTS_ENDPOINT);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");

    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`YouTube API error (${response.status}).`);
    }

    const data = (await response.json()) as PlaylistResponse;
    const items = data.items ?? [];

    for (const item of items) {
      const row = getPlaylistRow(item);
      if (row) {
        playlists.push(row);
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  playlists.sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt));

  return playlists;
};

export function PlaylistsTable() {
  const authState = useAtomValue(authStateAtom);
  const accessToken = authState.accessToken;
  const isAuthenticated = authState.status === "authenticated" && accessToken !== null;
  const [playlistState, setPlaylistState] = useState<PlaylistState>(initialPlaylistState);

  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      // oxlint-disable-next-line react/set-state-in-effect
      setPlaylistState(initialPlaylistState);
      return;
    }

    let isActive = true;
    const controller = new AbortController();

    const loadPlaylists = async () => {
      setPlaylistState({
        status: "loading",
        playlists: [],
        errorMessage: null,
      });

      try {
        const playlists = await fetchPlaylists(accessToken, controller.signal);
        if (!isActive) {
          return;
        }

        setPlaylistState({
          status: "loaded",
          playlists,
          errorMessage: null,
        });
      } catch (error) {
        if (!isActive || controller.signal.aborted) {
          return;
        }

        setPlaylistState({
          status: "error",
          playlists: [],
          errorMessage: getErrorMessage(error),
        });
      }
    };

    void loadPlaylists();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [accessToken, isAuthenticated]);

  return (
    <section className="card border-base-300 bg-base-200/60 border">
      <div className="card-body gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="card-title text-xl">Gameplay playlists</h2>
          <p className="text-base-content/70 text-sm">
            Showing playlists ending with "{playlistPostfix}".
          </p>
        </div>
        {!isAuthenticated ? (
          <output className="alert alert-info alert-soft">
            <span>Log in to load your playlists.</span>
          </output>
        ) : null}
        {isAuthenticated && playlistState.status === "loading" ? (
          <output className="alert alert-info alert-soft">
            <span className="loading loading-spinner loading-sm" />
            <span>Loading playlists...</span>
          </output>
        ) : null}
        {isAuthenticated && playlistState.status === "error" ? (
          <div role="alert" className="alert alert-error alert-soft">
            <span>{playlistState.errorMessage}</span>
          </div>
        ) : null}
        {isAuthenticated &&
        playlistState.status === "loaded" &&
        playlistState.playlists.length === 0 ? (
          <output className="alert alert-warning alert-soft">
            <span>No playlists matched this postfix.</span>
          </output>
        ) : null}
        {isAuthenticated && playlistState.playlists.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Playlist</th>
                  <th className="text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {playlistState.playlists.map((playlist) => (
                  <tr key={playlist.id}>
                    <td>
                      <a
                        className="link link-hover font-semibold"
                        href={getPlaylistUrl(playlist.id)}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {playlist.title}
                      </a>
                    </td>
                    <td className="text-right">
                      {dateFormatter.format(new Date(playlist.updatedAt))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
