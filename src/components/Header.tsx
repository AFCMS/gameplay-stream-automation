import { useLogin } from "../hooks/login";

export function Header() {
  const { channel, isLoading, isLoggedIn, login } = useLogin();

  return (
    <nav className="navbar border-base-300 bg-base-200/80 border-b px-4">
      <div className="flex-1">
        <a className="btn btn-ghost text-base sm:text-lg">
          Gameplay Stream Automation
        </a>
      </div>
      <div className="flex flex-row items-center gap-3">
        {isLoggedIn && channel ? (
          <div className="flex items-center gap-2">
            <div className="hidden flex-col text-right sm:flex">
              <span className="text-base-content/60 text-xs tracking-wide uppercase">
                Selected channel
              </span>
              <span className="text-sm font-semibold">{channel.title}</span>
            </div>
          </div>
        ) : null}
        <button
          className="btn btn-primary btn-sm sm:btn-md"
          disabled={isLoading}
          onClick={() => login()}
          type="button"
        >
          {isLoading ? (
            <span className="loading loading-spinner loading-sm" />
          ) : null}
          {isLoading ? "Connecting..." : "Login with Google"}
        </button>
      </div>
    </nav>
  );
}
