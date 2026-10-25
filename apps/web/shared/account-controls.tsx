import { useEffect, useRef, useState } from "react";
import { Button, buttonClass } from "./button";
import { IconSettings } from "./icons";
import { useSession } from "./session";

/** 피드백 메일의 수신처 — 화면에는 드러내지 않는다 */
const FEEDBACK_MAILTO = "mailto:dhoonjang@gmail.com";

/**
 * 설정 — **톱니바퀴 하나.** 게임 밖의 일만 모은다: 로그인한 계정, 피드백 보내기, 로그아웃.
 * 로컬 인증에는 로그아웃이 없다(다시 불러오면 같은 로컬 계정이다).
 *
 * `inRail`이면 게임 메뉴(아이콘 줄)의 마지막 칸이다 — 메뉴 안의 구분선으로 떨어진다.
 * 700 아래에서 메뉴가 서랍으로 접히면 톱니바퀴 대신 계정·피드백·로그아웃이 서랍 하단에
 * 그대로 펼쳐진다(`.account-drawer` — 접는 일은 CSS가 한다).
 */
export function AccountControls({ inRail = false }: { inRail?: boolean }) {
  const { local, email, logout } = useSession();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const toggle = () => setOpen((value) => !value);
  const controls = (
    <div className="account-controls" ref={root}>
      {inRail ? (
        <Button
          variant="bare"
          title="설정"
          aria-label="설정"
          aria-expanded={open}
          onClick={toggle}
          data-testid="settings-button"
        >
          <IconSettings />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          title="설정"
          aria-label="설정"
          aria-expanded={open}
          onClick={toggle}
          data-testid="settings-button"
        >
          <IconSettings />
        </Button>
      )}
      {open && (
        <div className="account-menu" data-testid="settings-menu">
          <span className="account-email">{email ?? "로컬 계정"}</span>
          <a className={buttonClass("ghost", "sm")} href={FEEDBACK_MAILTO}>
            피드백 보내기
          </a>
          {!local && (
            <Button variant="ghost" size="sm" onClick={logout}>
              로그아웃
            </Button>
          )}
        </div>
      )}
    </div>
  );
  if (!inRail) return controls;
  return (
    <>
      <span className="rail-sep account-sep" />
      {controls}
      <div className="account-drawer">
        <span className="account-email">{email ?? "로컬 계정"}</span>
        <a className="account-drawer-link" href={FEEDBACK_MAILTO}>
          피드백 보내기
        </a>
        {!local && (
          <Button variant="bare" className="account-drawer-link" onClick={logout}>
            로그아웃
          </Button>
        )}
      </div>
    </>
  );
}
