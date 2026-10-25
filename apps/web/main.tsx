import { SessionContext } from "./shared/session";
import { StrictMode, useEffect, useState, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  useParams,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import Home from "./app/page";
import NewGame from "./app/new/page";
const Admin = lazy(() => import("./app/admin/page"));
import { GameScreen } from "./game/game-screen";
const MatchLab = lazy(() => import("./game/match-lab").then((m) => ({ default: m.MatchLab })));
import { Button, buttonClass } from "./shared/button";
import { pollJob } from "./shared/api";
import "./app/globals.css";
function Game() {
  const { id } = useParams();
  return id ? <GameScreen gameId={id} /> : null;
}
function Lab() {
  const [params] = useSearchParams();
  return <MatchLab labId={params.get("id")} />;
}
function Shell({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [local, setLocal] = useState(false);
  // Google callback이 실패하면 `/#login_error=`로 돌아온다 — 문구는 보이고 주소에서는 지운다
  const [notice, setNotice] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("login_error") ?? "",
  );
  const [pending, setPending] = useState(false);
  const [generation, setGeneration] = useState(0);
  const location = useLocation();
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (!hash.has("login_error")) return;
    hash.delete("login_error");
    const rest = hash.toString();
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`,
    );
  }, []);
  useEffect(() => {
    let active = true;
    void fetch("/api/auth/me")
      .then(async (r) => {
        if (!active) return;
        if (r.ok) {
          const data = (await r.json()) as { local: boolean };
          setLocal(data.local);
          setAuth("in");
        } else setAuth("out");
      })
      .catch(() => {
        if (active) setAuth("out");
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (auth !== "in") return;
    const abort = new AbortController();
    void fetch("/api/jobs", { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) return;
        const data = (await r.json()) as { jobs: { id: string }[] };
        for (const job of data.jobs) await pollJob(job.id, () => {}, abort.signal);
        if (!abort.signal.aborted && data.jobs.length) {
          setGeneration((n) => n + 1);
        }
      })
      .catch(() => {});
    return () => abort.abort();
  }, [auth]);
  if (auth === "loading")
    return (
      <main className="service-login">
        <p>로그인 확인 중…</p>
      </main>
    );
  if (auth === "out") {
    const invite =
      new URLSearchParams(location.hash.slice(1)).get("invite") ??
      new URLSearchParams(location.search).get("invite");
    return (
      <main className="service-login">
        <h1>Gaffer</h1>
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setNotice("");
            void fetch("/api/auth/start", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ invite: invite ?? "" }),
            })
              .then(async (response) => {
                const data = (await response.json()) as { url?: string; error?: string };
                if (response.ok && data.url) window.location.assign(data.url);
                else setNotice(data.error ?? "로그인을 시작하지 못했습니다");
              })
              .catch(() => setNotice("서버에 연결하지 못했습니다"))
              .finally(() => setPending(false));
          }}
        >
          Google로 로그인
        </Button>
        {notice && <p role="alert">{notice}</p>}
      </main>
    );
  }
  return (
    <SessionContext.Provider value={{ local }}>
      <div className="service-shell">
        <nav className="service-toolbar" aria-label="계정">
          <a className={buttonClass("ghost", "sm")} href="mailto:dhoonjang@gmail.com">
            dhoonjang@gmail.com
          </a>
          {/* 로컬 인증은 다시 불러오면 같은 로컬 계정으로 들어오므로 로그아웃이 없다 */}
          {!local && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setPending(true);
                setNotice("");
                void fetch("/api/auth/logout", { method: "POST" })
                  .then((response) => {
                    if (!response.ok) throw new Error("logout");
                    for (const key of Object.keys(localStorage))
                      if (key.startsWith("gaffer:request:")) localStorage.removeItem(key);
                    sessionStorage.removeItem("gaffer:client");
                    window.location.replace("/");
                  })
                  .catch(() => setNotice("로그아웃하지 못했습니다. 다시 시도해 주세요"))
                  .finally(() => setPending(false));
              }}
            >
              로그아웃
            </Button>
          )}
        </nav>
        {notice && <p role="alert">{notice}</p>}
        <div className="service-content" key={generation}>
          <Suspense fallback={<p>불러오는 중…</p>}>{children}</Suspense>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new" element={<NewGame />} />
          <Route path="/game/:id" element={<Game />} />
          <Route path="/lab" element={<Lab />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<p>페이지를 찾을 수 없습니다</p>} />
        </Routes>
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
