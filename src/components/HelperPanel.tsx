import { useState } from "react";

import { errorMessage } from "../domain/types";
import type { HelperStatus } from "../helper/protocol";
import { gameHelper } from "../services/helper";
import { ErrorNotice } from "./Fields";

export function HelperPanel({ channelId }: { channelId: string }) {
  const [status, setStatus] = useState<HelperStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function check() {
    setBusy(true);
    setError(undefined);

    try {
      setStatus(await gameHelper.status(channelId));
    } catch (cause) {
      setStatus(undefined);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="border-base-300 space-y-4 border-b pb-6"
      aria-label="Studio helper connection"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Studio helper</h2>
          {status ? <span className="text-base-content/60 text-sm">Connected</span> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="btn btn-sm"
            href={`${import.meta.env.BASE_URL}gameplay-helper.user.js`}
            target="_blank"
            rel="noreferrer"
          >
            Install helper
          </a>
          <a
            className="btn btn-sm"
            href="https://studio.youtube.com/"
            target="_blank"
            rel="noreferrer"
          >
            Open Studio
          </a>
          <button className="btn btn-sm" disabled={busy} type="button" onClick={() => void check()}>
            {busy ? "Checking…" : "Check connection"}
          </button>
        </div>
      </div>
      <ErrorNotice message={error} />
    </section>
  );
}
