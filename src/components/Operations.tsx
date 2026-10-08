import { useState } from "react";

import {
  errorMessage,
  publicUrl,
  setupSteps,
  studioUrl,
  type BroadcastOperation,
} from "../domain/types";
import { createBroadcastService, isUnfinished, withChannelLock } from "../services/broadcasts";
import { gameHelper } from "../services/helper";
import type { YouTubeBroadcast, YouTubeClient } from "../services/youtube";
import { libraryStore } from "../storage/database";
import { ErrorNotice } from "./Fields";

export function OperationCard({
  operation,
  api,
  connected,
  onProgress,
}: {
  operation: BroadcastOperation;
  api: YouTubeClient;
  connected: boolean;
  onProgress: (operation: BroadcastOperation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [candidates, setCandidates] = useState<YouTubeBroadcast[] | null>(null);
  const [confirmAbsent, setConfirmAbsent] = useState(false);
  const service = createBroadcastService({
    api,
    helper: gameHelper,
    store: libraryStore,
    onProgress,
  });
  const unfinished = isUnfinished(operation);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);

    try {
      await withChannelLock(operation.channelId, action);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="border-base-300 space-y-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">{operation.draft.title}</h3>
        <span className="badge">
          {operation.status === "complete"
            ? "Ready for OBS"
            : operation.status === "cancelled"
              ? "Not created"
              : "Setup unfinished"}
        </span>
      </div>
      <p className="text-base-content/60 text-sm">{operation.playlistName}</p>
      {operation.broadcastId ? (
        <div className="flex flex-wrap gap-4 text-sm">
          <a
            className="link"
            href={publicUrl(operation.broadcastId)}
            target="_blank"
            rel="noreferrer"
          >
            Public video
          </a>
          <a
            className="link"
            href={studioUrl(operation.broadcastId)}
            target="_blank"
            rel="noreferrer"
          >
            Studio dashboard
          </a>
          {unfinished ? (
            <a className="link" href="https://studio.youtube.com/" target="_blank" rel="noreferrer">
              Open Studio
            </a>
          ) : null}
        </div>
      ) : null}
      {unfinished && operation.broadcastId ? (
        <p className="text-base-content/70 text-sm">
          Remaining:{" "}
          {setupSteps.filter((step) => !operation.completedSteps.includes(step)).join(", ") ||
            "final confirmation"}
          .
        </p>
      ) : null}
      <ErrorNotice message={error ?? operation.error} />
      {unfinished ? (
        <div className="space-y-3">
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !connected}
            onClick={() =>
              void run(async () => {
                if (operation.broadcastId) {
                  await service.resume(operation.id);
                } else {
                  setCandidates(await service.reconcile(operation));
                }
              })
            }
          >
            {busy
              ? "Working…"
              : operation.broadcastId
                ? "Retry unfinished steps"
                : "Find the created broadcast"}
          </button>
          {candidates ? (
            <div className="space-y-3 text-sm">
              {candidates.length ? (
                <p>Select the event created by this attempt:</p>
              ) : (
                <p>No match. Wait two minutes and check Studio.</p>
              )}
              {candidates.map((candidate) => (
                <div className="flex flex-wrap items-center gap-3" key={candidate.id}>
                  <a
                    className="link"
                    href={studioUrl(candidate.id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {candidate.snippet.title} ({candidate.id})
                  </a>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={busy || !connected}
                    onClick={() => void run(() => service.adopt(operation, candidate.id))}
                  >
                    Use this broadcast
                  </button>
                </div>
              ))}
              {!candidates.length ? (
                <>
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={confirmAbsent}
                      onChange={(event) => setConfirmAbsent(event.target.checked)}
                    />
                    I checked Studio and no broadcast was created.
                  </label>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={!confirmAbsent || busy || !connected}
                    onClick={() => void run(() => service.confirmNotCreated(operation))}
                  >
                    Clear this attempt
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
