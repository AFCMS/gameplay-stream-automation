import { useAtomValue } from "jotai";

import { Header } from "./components/Header";
import { authStateAtom } from "./state/auth";

function App() {
  const authState = useAtomValue(authStateAtom);

  return (
    <div className="bg-base-100 text-base-content min-h-screen">
      <Header />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10">
        <section className="card border-base-300 bg-base-200/60 border">
          <pre>{JSON.stringify(authState.channel?.title, null, 2)}</pre>
        </section>
      </main>
    </div>
  );
}

export default App;
