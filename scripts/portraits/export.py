"""생성 원본(raw/<QID>.png — 초록 배경 · 파란 표식 티셔츠) → 화면이 쓰는 초상 두 벌.

  h/<선수 id>.webp  머리 정사각형 (원형 자리 — 전술판 토큰·명단 행·화자)
  p/<선수 id>.webp  4:5 흉상     (선수 카드 히어로·게이트 맞대결·골 토스트)

두 벌 모두 **가로 두 칸짜리 한 장**이다: 왼쪽이 배경을 지운 사람(티셔츠는 밝은 회색 음영),
오른쪽이 같은 틀의 티셔츠 마스크(알파). 화면은 왼쪽 위에 구단 색을 오른쪽 마스크로 곱해 칠한다 —
이적해도 다시 만들지 않고, 요청도 초상 하나에 한 번이다.

틀은 사람마다 **마스크에서 잰다**: 정수리 위 여유는 머리 폭의 일정 비율, 흉상은 어깨가 틀의 양 끝과
아래를 넘어가는 가장 큰 4:5 사각형. 그런 자리가 없는 초상(어깨가 좁거나 잘린 생성물)은 내보내지 않고
결과에 `unfilled`로 알린다 — 그 선수는 화면에서 폴백으로 선다.

사용: python3 -I scripts/portraits/export.py <초상 작업 폴더> <출력 폴더> <QID→선수 id JSON>
"""
import json, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
from PIL import Image, ImageFilter

WORK = 1024           # 틀을 재는 캔버스 — 생성 원본과 같은 크기라 해상도를 잃지 않는다
HEAD_W = 0.40         # 캔버스 폭 대비 머리 폭
TOP = 0.08            # 정수리 높이
HEAD_PX = 112         # 머리 정사각형 한 변 (52px 토큰의 2배 밀도)
BUST_PX = (560, 700)  # 흉상 4:5 (268px 히어로의 2배 밀도)
ASPECT = BUST_PX[0] / BUST_PX[1]
HEAD_BOX = 1.38       # 머리 정사각형 한 변 = 머리 폭 × 이 값
HEAD_LIFT = 0.07      # 정사각형이 정수리 위로 올라서는 몫 (한 변 대비)
HEADROOM = 0.16       # 흉상의 정수리 위 여유 (머리 폭 대비)
MIN_BUST = 1.5        # 흉상의 최소 높이 (머리 폭 대비) — 이보다 낮으면 얼굴만 남는다


def soft(mask, grow=0, blur=1.0):
    im = Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8))
    if grow > 0: im = im.filter(ImageFilter.MaxFilter(grow))
    if grow < 0: im = im.filter(ImageFilter.MinFilter(-grow))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(blur))).astype(np.float32) / 255


def cut_out(path):
    """배경을 지우고 머리 폭·정수리를 캔버스에 맞춘 (사람 RGBA, 티셔츠 마스크 L)"""
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    alpha = soft(1 - np.clip((G - np.maximum(R, B) - 0.08) / 0.22, 0, 1), grow=-3, blur=1.2)
    shirt = soft(np.clip((B - np.maximum(R, G) - 0.10) / 0.20, 0, 1), blur=1.0) * alpha
    # 디스필 — 배경의 초록, 티셔츠의 파랑이 피부에 묻은 만큼 누른다
    G = np.minimum(G, np.maximum(R, B) * 1.02 + 0.01)
    B = np.where(shirt < 0.5, np.minimum(B, np.maximum(R, G) * 1.08 + 0.02), B)
    # 음영 — 티셔츠의 밝기를 0.55~1.0으로 펴서 곱하기 바탕으로 쓴다
    inside = shirt > 0.6
    V = np.maximum(np.maximum(R, G), B)
    lo, hi = np.percentile(V[inside], [3, 97]) if inside.sum() > 200 else (0.0, 1.0)
    shade = 0.55 + 0.45 * np.clip((V - lo) / max(hi - lo, 1e-3), 0, 1)
    base = np.stack([R, G, B], -1) * (1 - shirt[..., None]) + shade[..., None] * shirt[..., None]
    # 머리 폭·정수리 — 티셔츠를 뺀 몸에서 정수리 아래 30% 구간의 가장 넓은 줄
    body = (alpha > 0.5) & (shirt < 0.5)
    rows = np.where(body.any(1))[0]
    if len(rows) == 0: raise ValueError("배경 제거 후 남은 것이 없다")
    top = rows[0]; band = body[top: top + int(0.30 * body.shape[0])]
    cols = np.where(band[int(band.sum(1).argmax())])[0]
    head_w = cols[-1] - cols[0]; cx = (cols[-1] + cols[0]) / 2
    s = HEAD_W * WORK / head_w; off = (round(WORK / 2 - cx * s), round(TOP * WORK - top * s))
    size = (round(rgb.shape[1] * s), round(rgb.shape[0] * s))
    cut = Image.fromarray((np.concatenate([base, alpha[..., None]], -1) * 255).astype(np.uint8), "RGBA").resize(size, Image.LANCZOS)
    msk = Image.fromarray((shirt * 255).astype(np.uint8), "L").resize(size, Image.LANCZOS)
    person = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0)); person.alpha_composite(cut, off)
    mask = Image.new("L", (WORK, WORK), 0); mask.paste(msk, off)
    return person, mask


def frames(person):
    """마스크에서 잰 (머리 정사각형, 4:5 흉상 또는 None)"""
    a = np.asarray(person)[..., 3] > 128
    ys = np.where(a.any(1))[0]; top, bottom = int(ys[0]), int(ys[-1])
    span = lambda y: (int(np.argmax(a[y])), int(len(a[y]) - np.argmax(a[y][::-1])))
    head = a[top: top + int((bottom - top) * 0.42)]
    xs = np.where(head.any(0))[0]; hl, hr = int(xs[0]), int(xs[-1]) + 1
    cx, hw = (hl + hr) / 2, hr - hl
    side = hw * HEAD_BOX; hy = top - side * HEAD_LIFT
    head_box = (cx - side / 2, hy, cx + side / 2, hy + side)
    y0 = top - hw * HEADROOM
    # 아래에서 위로 — 어깨가 틀의 양 끝을 넘는 가장 큰 틀
    for yb in range(bottom, top + int(hw * MIN_BUST), -1):
        h = yb + 1 - y0; w = h * ASPECT; l, r = cx - w / 2, cx + w / 2
        sl, sr = span(yb)
        if sl <= l + 1 and sr >= r - 1 and l >= 0 and r <= a.shape[1]:
            return head_box, (l, y0, r, yb + 1)
    return head_box, None


def crop(im, box, size):
    l, t, r, b = box
    canvas = Image.new(im.mode, (int(round(r - l)), int(round(b - t))), 0)
    canvas.paste(im, (int(round(-l)), int(round(-t))))
    return canvas.resize(size, Image.LANCZOS)


def sprite(person, mask, box, size):
    sheet = Image.new("RGBA", (size[0] * 2, size[1]), (0, 0, 0, 0))
    sheet.paste(crop(person, box, size), (0, 0))
    m = crop(mask, box, size)
    # CSS mask-image는 알파를 읽는다 — 흰 바탕에 마스크를 알파로 싣는다
    sheet.paste(Image.merge("RGBA", (Image.new("L", size, 255),) * 3 + (m,)), (size[0], 0))
    return sheet


def run(job):
    root, out, qid, pid = job
    try:
        person, mask = cut_out(f"{root}/raw/{qid}.png")
        head_box, bust_box = frames(person)
        if bust_box is None: return dict(id=pid, qid=qid, unfilled=True)
        sprite(person, mask, head_box, (HEAD_PX, HEAD_PX)).save(f"{out}/h/{pid}.webp", "WEBP", quality=80, method=6)
        sprite(person, mask, bust_box, BUST_PX).save(f"{out}/p/{pid}.webp", "WEBP", quality=74, method=6)
        return dict(id=pid, qid=qid)
    except Exception as e:  # 한 장의 실패가 나머지를 멈추지 않는다 — 결과에 남긴다
        return dict(id=pid, qid=qid, error=str(e))


if __name__ == "__main__":
    root, out, map_path = sys.argv[1:4]
    ids = json.load(open(map_path))
    progress = json.load(open(f"{root}/progress.json"))
    for d in ("h", "p"): os.makedirs(f"{out}/{d}", exist_ok=True)
    # 검수를 통과한 초상만 — 파일 규격 통과와 시각 검수 통과는 별개다
    jobs = [(root, out, q, ids[q]) for q, v in sorted(progress.items()) if v.get("status") == "done" and q in ids]
    with ProcessPoolExecutor() as pool: report = list(pool.map(run, jobs, chunksize=8))
    json.dump(report, sys.stdout, ensure_ascii=False)
