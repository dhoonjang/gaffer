"use client";

import { CHARACTER_INFORMATION_MAX, type CharacterBookContent } from "@story-fm/domain";

export function CharacterBookFields({
  name,
  book,
  onChange,
}: {
  name: string;
  book?: CharacterBookContent;
  onChange: (book: CharacterBookContent) => void;
}) {
  return (
    <section>
      <h3>캐릭터북</h3>
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
          캐릭터북 직접 작성
        </button>
      )}
    </section>
  );
}

export function characterBookInput(
  name: string,
  book: CharacterBookContent | undefined,
): CharacterBookContent | undefined {
  return book
    ? {
        ...book,
        name,
        keywords: [...new Set(book.keywords.map((word) => word.trim()).filter(Boolean))],
      }
    : undefined;
}
