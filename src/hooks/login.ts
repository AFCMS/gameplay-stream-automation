import { useGoogleLogin } from "@react-oauth/google";
import { useAtom } from "jotai";

import { authStateAtom, type AuthState, type ChannelSummary } from "../state/auth";

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";
const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";

interface YoutubeChannelThumbnail {
  readonly url?: string;
}

interface YoutubeChannelThumbnails {
  readonly default?: YoutubeChannelThumbnail;
  readonly medium?: YoutubeChannelThumbnail;
  readonly high?: YoutubeChannelThumbnail;
}

interface YoutubeChannelSnippet {
  readonly title?: string;
  readonly thumbnails?: YoutubeChannelThumbnails;
}

interface YoutubeChannelItem {
  readonly id?: string;
  readonly snippet?: YoutubeChannelSnippet;
}

interface YoutubeChannelResponse {
  readonly items?: readonly YoutubeChannelItem[];
}

type LoginHandler = ReturnType<typeof useGoogleLogin>;

export interface UseLoginResult {
  readonly login: LoginHandler;
  readonly authState: AuthState;
  readonly isLoading: boolean;
  readonly isLoggedIn: boolean;
  readonly channel: ChannelSummary | null;
}

const getThumbnailUrl = (snippet: YoutubeChannelSnippet | undefined): string | null => {
  const thumbnails = snippet?.thumbnails;
  return thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Unable to load your YouTube channel.";
};

export function useLogin(): UseLoginResult {
  const [authState, setAuthState] = useAtom(authStateAtom);
  const login = useGoogleLogin({
    scope: YOUTUBE_SCOPE,
    onSuccess: async (tokenResponse) => {
      const accessToken = tokenResponse.access_token;
      if (!accessToken) {
        setAuthState({
          status: "error",
          accessToken: null,
          channel: null,
          errorMessage: "Google login did not return an access token.",
        });
        return;
      }

      setAuthState({
        status: "loading",
        accessToken,
        channel: null,
        errorMessage: null,
      });

      try {
        const response = await fetch(CHANNELS_ENDPOINT, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!response.ok) {
          throw new Error(`YouTube API error (${response.status}).`);
        }

        const data = (await response.json()) as YoutubeChannelResponse;
        const channel = data.items?.[0];
        const channelTitle = channel?.snippet?.title;
        const channelId = channel?.id;

        if (!channelId || !channelTitle) {
          throw new Error("No YouTube channels were returned.");
        }

        setAuthState({
          status: "authenticated",
          accessToken,
          channel: {
            id: channelId,
            title: channelTitle,
            thumbnailUrl: getThumbnailUrl(channel.snippet),
          },
          errorMessage: null,
        });
      } catch (error) {
        setAuthState({
          status: "error",
          accessToken: null,
          channel: null,
          errorMessage: getErrorMessage(error),
        });
      }
    },
    onError: () => {
      setAuthState({
        status: "error",
        accessToken: null,
        channel: null,
        errorMessage: "Google login failed. Please try again.",
      });
    },
  });

  const isLoading = authState.status === "loading";
  const isLoggedIn = authState.status === "authenticated" && authState.channel !== null;
  const channel = authState.channel;

  return {
    login,
    authState,
    isLoading,
    isLoggedIn,
    channel,
  };
}
