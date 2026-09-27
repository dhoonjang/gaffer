"use client";
import { useDialog } from "@/domains/common/lib/use-dialog";

import { useId, useRef, type ReactNode } from "react";

/**
 * 어드민 공용 모달 — 목록에서 항목을 클릭했을 때 그 항목만 담는 창.
 *
 * 창이 서는 동안 뒤의 목록은 조작 대상이 아니다: Esc·배경 클릭으로 닫고,
 * Tab은 창 안에서만 돈다(포커스 트랩). 닫히면 원래 눌렀던 자리로 포커스를 돌린다.
 */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  testId,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  wide?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  const trapTab = useDialog(
    cardRef,
    onClose,
    ".admin-modal-body input:not([disabled]),.admin-modal-body select:not([disabled]),.admin-modal-body textarea:not([disabled])",
  );

  return (
    <div
      className="admin-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? "admin-modal wide" : "admin-modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid={testId}
        ref={cardRef}
        onKeyDown={trapTab}
      >
        <header className="admin-modal-head">
          <div>
            <b className="admin-modal-title" id={headingId}>
              {title}
            </b>
            {subtitle && <span className="admin-modal-sub">{subtitle}</span>}
          </div>
          <button
            className="mini-btn"
            onClick={onClose}
            aria-label="닫기"
            data-testid={testId ? `${testId}-close` : undefined}
          >
            ✕
          </button>
        </header>
        <div className="admin-modal-body">{children}</div>
        {footer && <footer className="admin-modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
