import type { ComponentPropsWithRef } from "react";

/**
 * 화면의 버튼은 전부 이 하나를 거친다 — 맨 `<button>`은 ESLint가 막는다.
 *
 * `type`의 기본은 `"button"`이다. 폼 안에서 제출이 되는 것은 `type="submit"`을 적은 것뿐이다.
 *
 * 생김새는 `variant`가 고른다 (tokens.css 「조작」):
 * - `primary` — 키 컬러 채움. 그 화면의 주된 조작 하나
 * - `secondary` — 면 한 단(`--panel-2`), hover에 `--pop`
 * - `ghost` — 면 없이 글자 2층, hover에 면이 선다
 * - `danger` — 지우는 조작. 글자가 `--loss`
 * - `bare` — 생김새를 부르는 쪽 클래스가 다 갖는 조각(탭·행·칩·판 위의 말)
 *
 * `size`는 `md`(36) · `sm`(28) · `icon`(36 정사각)이다.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "bare";
export type ButtonSize = "md" | "sm" | "icon";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
}

/** 버튼이 아닌 요소(링크)가 버튼의 생김새를 빌릴 때 */
export function buttonClass(
  variant: Exclude<ButtonVariant, "bare">,
  size: ButtonSize = "md",
  className?: string,
): string {
  return ["btn", `btn-${variant}`, size === "md" ? "" : `btn-${size}`, className ?? ""]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  const look = variant === "bare" ? className : buttonClass(variant, size, className);
  return <button type={type} className={look || undefined} {...rest} />;
}
