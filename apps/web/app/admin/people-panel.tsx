"use client";

import { useEffect, useState } from "react";
import { LorebookContentSchema, personaRoleLabel, type LorebookContent } from "@gaffer/domain";
import type { AdminPersonaRow } from "@gaffer/engine";
import { LorebookFields, lorebookInput } from "./lorebook-fields";
import { Modal } from "./modal";

interface PeopleResponse {
  people?: AdminPersonaRow[];
  error?: string;
  message?: string;
}

export function PeoplePanel({
  onError,
  onMessage,
}: {
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [seed, setSeed] = useState(0);
  const [people, setPeople] = useState<AdminPersonaRow[]>([]);
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState<AdminPersonaRow | null>(null);
  const [book, setBook] = useState<LorebookContent>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/admin/catalog/person?seed=${seed}`, { signal: controller.signal })
      .then(async (response) => {
        const data: PeopleResponse = await response.json();
        if (!response.ok) throw new Error(data.error ?? "조회 실패");
        setPeople(data.people ?? []);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          onError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => controller.abort();
  }, [seed, onError]);

  async function save() {
    if (!person) return;
    const parsed = LorebookContentSchema.safeParse(lorebookInput(person.name, book));
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력 오류");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/catalog/person?seed=${seed}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: person.characterId, lorebook: parsed.data }),
      });
      const data: PeopleResponse = await response.json();
      if (!response.ok) throw new Error(data.error ?? "저장 실패");
      setPeople(data.people ?? []);
      onMessage(data.message ?? "저장 완료");
      setPerson(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="admin-fields">
        <label className="admin-field">
          인물 생성 시드
          <input
            type="number"
            min={0}
            max={0xffff_ffff}
            value={seed}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isSafeInteger(next) && next >= 0 && next <= 0xffff_ffff) setSeed(next);
            }}
          />
        </label>
        <label className="admin-field grow">
          이름 검색
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <p>새 게임의 인물 로어북을 편집합니다. 생성 인물은 게임 시드에 맞춰 조회합니다.</p>
      <table className="admin-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>역할</th>
            <th>설명</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {people
            .filter((row) => row.name.includes(query))
            .map((row) => (
              <tr key={row.characterId}>
                <td>{row.name}</td>
                <td>{personaRoleLabel(row.role)}</td>
                <td>{row.lorebook.description}</td>
                <td>
                  <button
                    className="ghost-btn"
                    onClick={() => {
                      setPerson(row);
                      setBook(row.lorebook);
                      setError(null);
                    }}
                  >
                    {row.edited ? "편집됨 · 편집" : "편집"}
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {person && (
        <Modal
          title={`${person.name} 편집`}
          onClose={() => setPerson(null)}
          footer={
            <button className="primary-btn" disabled={saving} onClick={() => void save()}>
              {saving ? "저장 중…" : "저장"}
            </button>
          }
        >
          {error && <div className="admin-msg err">{error}</div>}
          <LorebookFields name={person.name} book={book} onChange={setBook} />
        </Modal>
      )}
    </>
  );
}
