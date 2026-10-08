import { atom } from "jotai";

export interface ChannelSummary {
  readonly id: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
}

export type AuthStatus = "idle" | "loading" | "authenticated" | "expired" | "error";

export interface AuthState {
  readonly status: AuthStatus;
  readonly accessToken: string | null;
  readonly expiresAt: number | null;
  readonly channels: readonly ChannelSummary[];
  readonly channel: ChannelSummary | null;
  readonly errorMessage: string | null;
}

export const initialAuthState = {
  status: "idle",
  accessToken: null,
  expiresAt: null,
  channels: [],
  channel: null,
  errorMessage: null,
} as const satisfies AuthState;

export const authStateAtom = atom<AuthState>(initialAuthState);

export function accessTokenForChannel(state: AuthState, channelId: string): string {
  if (state.channel?.id !== channelId) {
    throw new Error("The connected channel changed. Return to the original channel to continue.");
  }

  if (!state.accessToken || !state.expiresAt || state.expiresAt - Date.now() < 30_000) {
    throw new Error("Reconnect Google before continuing.");
  }

  return state.accessToken;
}
