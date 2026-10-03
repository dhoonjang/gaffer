"use client";

import { CHARACTER_INFORMATION_MAX, type LorebookContent } from "@story-fm/domain";

export function LorebookFields({
  name,
  book,
  onChange,
}: {
  name: string;
  book?: LorebookContent;
  onChange: (book: LorebookContent) => void;
}) {
  return (
    <section>
      <h3>로어북</h3>
      {book ? (
        <>
          <p>{name}</p>
          <label className="admin-field grow">
            키워드 (한 줄에 하나)
            <textarea
              value={book.keywords.join("\n")}
              rows={3}
              onChange={(event) => onChange({ ...book, keywords: event.target.value.split("\n") })}
            />
          </label>
          <label className="admin-field grow">
            설명
            <input
              value={book.description}
              maxLength={240}
              onChange={(event) => onChange({ ...book, description: event.target.value })}
            />
          </label>
          <label className="admin-field grow">
            정보
            <textarea
              value={book.information}
              rows={10}
              maxLength={CHARACTER_INFORMATION_MAX}
              onChange={(event) => onChange({ ...book, information: event.target.value })}
            />
          </label>
        </>
      ) : (
        <button
          className="ghost-btn"
          onClick={() => onChange({ name, keywords: [], description: "", information: "" })}
        >
          로어북 직접 작성
        </button>
      )}
    </section>
  );
}

export function lorebookInput(
  name: string,
  book: LorebookContent | undefined,
): LorebookContent | undefined {
  return book
    ? {
        ...book,
        name,
        keywords: [...new Set(book.keywords.map((word) => word.trim()).filter(Boolean))],
      }
    : undefined;
}
