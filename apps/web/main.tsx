import { SessionContext, useSession } from "./shared/session";
import { StrictMode, useEffect, useState, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, useParams, useSearchParams } from "react-router-dom";
import Home from "./app/page";
import NewGame from "./app/new/page";
const Admin = lazy(() => import("./app/admin/page"));
import { GameScreen } from "./game/game-screen";
const MatchLab = lazy(() => import("./game/match-lab").then((m) => ({ default: m.MatchLab })));
import { Button } from "./shared/button";
import { followJob } from "./shared/api";
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
  const [email, setEmail] = useState<string | null>(null);
  // Google callback이 실패하면 `/#login_error=`로 돌아온다 — 문구는 보이고 주소에서는 지운다
  const [notice, setNotice] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("login_error") ?? "",
  );
  const [pending, setPending] = useState(false);
  const [generation, setGeneration] = useState(0);
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
          const data = (await r.json()) as { local: boolean; email?: string | null };
          setLocal(data.local);
          setEmail(data.email ?? null);
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
        for (const job of data.jobs) await followJob(job.id, () => {}, abort.signal);
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
  if (auth === "out")
    return (
      <main className="service-login">
        <h1>Gaffer</h1>
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setNotice("");
            void fetch("/api/auth/start", { method: "POST" })
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
  const logout = () => {
    setNotice("");
    void fetch("/api/auth/logout", { method: "POST" })
      .then((response) => {
        if (!response.ok) throw new Error("logout");
        for (const key of Object.keys(localStorage))
          if (key.startsWith("gaffer:request:")) localStorage.removeItem(key);
        sessionStorage.removeItem("gaffer:client");
        window.location.replace("/");
      })
      .catch(() => setNotice("로그아웃하지 못했습니다. 다시 시도해 주세요"));
  };
  // 계정·피드백 손잡이는 각 화면의 상단 띠가 든다(`AccountControls`) — 셸은 줄을 따로 쓰지 않는다
  return (
    <SessionContext.Provider value={{ local, email, logout }}>
      <div className="service-shell">
        {notice && <p role="alert">{notice}</p>}
        <div className="service-content" key={generation}>
          <Suspense fallback={<p>불러오는 중…</p>}>{children}</Suspense>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
/** 실험실·DB는 로컬 인증에서만 길이 있다 — 공개 모드에서는 없는 페이지다 */
function AppRoutes() {
  const { local } = useSession();
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/new" element={<NewGame />} />
      <Route path="/game/:id" element={<Game />} />
      {local && <Route path="/lab" element={<Lab />} />}
      {local && <Route path="/admin" element={<Admin />} />}
      <Route path="*" element={<p>페이지를 찾을 수 없습니다</p>} />
    </Routes>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell>
        <AppRoutes />
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
