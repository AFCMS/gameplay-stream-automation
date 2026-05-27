import { useGoogleLogin } from "@react-oauth/google";

function App() {
  const login = useGoogleLogin({
    scope: "https://www.googleapis.com/auth/youtube.readonly",
    onSuccess: async (tokenResponse) => {
      const accessToken = tokenResponse.access_token;

      const res = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const data = await res.json();
      console.log(data);
    },
  });

  return <button onClick={() => login()}>Login with Google</button>;
}

export default App;
