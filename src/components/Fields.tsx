import { useEffect, useId, useState, type ReactNode } from "react";

import { errorMessage, validateThumbnail, type Game } from "../domain/types";
import { gameHelper } from "../services/helper";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-base-content/60 text-xs leading-relaxed">{hint}</span> : null}
    </label>
  );
}

export function ErrorNotice({ message }: { message?: string | null }) {
  return message ? (
    <div className="alert alert-error text-sm" role="alert">
      {message}
    </div>
  ) : null;
}

export function Thumbnail({ blob, className = "" }: { blob?: Blob; className?: string }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!blob) {
      return;
    }

    const nextUrl = URL.createObjectURL(blob);
    // The URL is an external resource tied to this effect's lifetime.
    // oxlint-disable-next-line react/set-state-in-effect
    setUrl(nextUrl);

    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);

  return blob && url ? <img src={url} alt="Broadcast thumbnail" className={className} /> : null;
}

export function ThumbnailField({
  value,
  onChange,
}: {
  value?: Blob;
  onChange: (value?: Blob) => void;
}) {
  const [error, setError] = useState<string>();

  function select(file?: File) {
    try {
      if (file) {
        validateThumbnail(file);
        onChange(file);
      }

      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Thumbnail" hint="PNG or JPEG">
        <input
          type="file"
          accept="image/png,image/jpeg"
          className="file-input w-full"
          onChange={(event) => select(event.target.files?.[0])}
        />
      </Field>
      {value ? (
        <div className="flex items-center gap-4">
          <Thumbnail blob={value} className="aspect-video w-32 rounded-lg object-cover" />
          <button className="btn btn-sm" type="button" onClick={() => onChange(undefined)}>
            Remove thumbnail
          </button>
        </div>
      ) : null}
      <ErrorNotice message={error} />
    </div>
  );
}

export function GamePicker({
  channelId,
  value,
  onChange,
}: {
  channelId: string;
  value?: Game;
  onChange: (game: Game) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState(value?.title ?? "");
  const [results, setResults] = useState<Game[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function search() {
    if (!query.trim() || busy) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      setResults(await gameHelper.searchGames(channelId, query.trim()));
      setSearched(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">YouTube game</legend>
      <div className="flex gap-2">
        <input
          aria-label="Search YouTube games"
          aria-controls={id}
          className="input min-w-0 flex-1"
          value={query}
          maxLength={200}
          placeholder="Search the game catalog"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }}
        />
        <button
          className="btn"
          type="button"
          disabled={busy || !query.trim()}
          onClick={() => void search()}
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </div>
      {value ? (
        <p className="text-sm">
          Selected: <strong>{value.title}</strong>
          {value.year ? ` (${value.year})` : ""}
        </p>
      ) : null}
      <div id={id} className="max-h-52 overflow-y-auto" aria-live="polite">
        {results.map((game) => (
          <button
            key={game.mid}
            type="button"
            className="hover:bg-base-300 flex w-full items-center justify-between gap-4 rounded-lg px-3 py-3 text-left text-sm"
            onClick={() => {
              onChange(game);
              setQuery(game.title);
              setResults([]);
              setSearched(false);
            }}
          >
            <span>{game.title}</span>
            <span className="text-base-content/60">{game.year}</span>
          </button>
        ))}
        {searched && !results.length ? (
          <p className="text-base-content/60 text-sm">No matches.</p>
        ) : null}
      </div>
      <ErrorNotice message={error} />
    </fieldset>
  );
}

export function LanguageField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();

  return (
    <Field label="Audio language">
      <input
        className="input w-full"
        list={id}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={id}>
        <option value="en">English</option>
        <option value="fr">French</option>
        <option value="fr-FR">French (France)</option>
        <option value="en-US">English (United States)</option>
        <option value="de">German</option>
        <option value="es">Spanish</option>
        <option value="ja">Japanese</option>
        <option value="pt">Portuguese</option>
      </datalist>
    </Field>
  );
}
