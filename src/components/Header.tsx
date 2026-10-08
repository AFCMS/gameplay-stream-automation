import { useSetAtom } from "jotai";

import { useLogin } from "../hooks/login";
import { authStateAtom } from "../state/auth";

export function Header() {
  const { authState, login, disconnect } = useLogin();
  const setAuth = useSetAtom(authStateAtom);
  const connecting = authState.status === "loading";
  const connected = authState.status === "authenticated";

  return (
    <header className="border-base-300 border-b">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <div className="text-lg font-semibold tracking-tight">Gameplay Stream Automation</div>
        <div className="flex flex-wrap items-center gap-3">
          {authState.channel ? (
            authState.channels.length > 1 ? (
              <select
                className="select select-sm max-w-56"
                aria-label="Connected YouTube channel"
                value={authState.channel.id}
                onChange={(event) =>
                  setAuth((previous) => ({
                    ...previous,
                    channel:
                      previous.channels.find((channel) => channel.id === event.target.value) ??
                      null,
                  }))
                }
              >
                {authState.channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.title}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-base-content/70 text-sm">{authState.channel.title}</span>
            )
          ) : null}
          <button className="btn btn-sm" disabled={connecting} type="button" onClick={login}>
            {connecting
              ? "Connecting…"
              : connected
                ? "Switch Google account"
                : authState.channel
                  ? "Reconnect Google"
                  : "Connect YouTube"}
          </button>
          {authState.channel ? (
            <button className="btn btn-sm" type="button" onClick={disconnect}>
              Disconnect
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
