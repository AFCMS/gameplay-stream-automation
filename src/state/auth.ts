import { atom } from "jotai";

export interface ChannelSummary {
  readonly id: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
}

export type AuthStatus = "idle" | "loading" | "authenticated" | "error";

export interface AuthState {
  readonly status: AuthStatus;
  readonly accessToken: string | null;
  readonly channel: ChannelSummary | null;
  readonly errorMessage: string | null;
}

const initialAuthState = {
  status: "idle",
  accessToken: null,
  channel: null,
  errorMessage: null,
} as const satisfies AuthState;

export const authStateAtom = atom<AuthState>(initialAuthState);
