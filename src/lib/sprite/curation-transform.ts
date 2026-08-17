// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `curation.py` 이식 — 프레임별 비파괴 변형.
// 원본: sprite-gen/sprite_gen/curation.py (Apache-2.0)

/**
 * 큐레이션의 **프레임별 변형**은 사이드카에만 산다.
 *
 * 정본 계약이 그렇다 — 원본 프레임 PNG 는 절대 다시 쓰지 않고, 사람이 맞춘 위치·각도만
 * `curation.json` 에 적어 두고 **합성할 때마다 다시 적용**한다. 정본에서 이 적용은 다섯
 * 소비자(`compose_atlas` · `compose_gif` · `compose_cycle` · `export_pngs` · `anchor`)를
 * 전부 거친다. 굽는 순간 원본이 사라지는 방식이었다면 잘못 맞춘 정렬을 되돌릴 수 없다.
 *
 * ## 우리 구조에서 이것이 없던 동안 무슨 일이 있었나
 *
 * 에디터에는 프레임을 끌어 옮기는 기능이 이미 있었지만 그 오프셋이 **어디에도 저장되지
 * 않았다.** 큐레이션을 저장하면 서버가 raw 에서 프레임을 다시 뽑아 재합성하므로 옮긴
 * 위치가 조용히 사라졌다. 유일하게 위치를 남기는 경로("보정본 저장")는 시트를 통째로
 * 새 generation 으로 구워 버려서 비파괴가 아니었다.
 *
 * ## 이식 범위
 *
 * 수식(`normalizeTransform` · `isIdentity` · `transformMatrix`)은 정본 그대로다 —
 * 회전·크기·기울이기·좌우반전까지 전부. 저장 형식도 같다.
 *
 * `applyTransform` 의 **역매핑 기하는 정본과 같고 보간만 다르다.** 정본은 PIL 의
 * BICUBIC 을 쓰는데 우리에겐 그 커널이 없어 bilinear 로 샘플링한다. 격자에 정확히
 * 맞아떨어지는 변형(정수 평행이동, 좌우반전, 배율 1)에서는 두 방식이 같은 픽셀을 주고,
 * 지금 UI 가 내보내는 것이 그 범위다. 회전·비정수 배율에서는 가장자리 픽셀이 정본과
 * 다를 수 있다 — 그 차이를 감추지 않는다.
 */

/** 정본 `normalize_transform` 이 채우는 전체 필드. */
export type Transform = {
  /** 도 단위. 화면 y-down 기준으로 양수가 반시계 방향. */
  rotate: number;
  scale: number;
  dx: number;
  dy: number;
  shx: number;
  shy: number;
  /** 0 | 1 — 좌우 반전. 행렬 마지막에 diag(-1, 1) 을 곱한다. */
  flipX: number;
};

export const IDENTITY: Transform = {
  rotate: 0.0,
  scale: 1.0,
  dx: 0,
  dy: 0,
  shx: 0.0,
  shy: 0.0,
  flipX: 0,
};

function num(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** 저장된 변형을 전체 필드가 채워진 형태로 강제한다 (정본 `normalize_transform`). */
export function normalizeTransform(raw: unknown): Transform {
  if (!raw || typeof raw !== "object") return { ...IDENTITY };
  const r = raw as Record<string, unknown>;
  return {
    rotate: num(r, "rotate", 0.0),
    scale: num(r, "scale", 1.0),
    dx: num(r, "dx", 0),
    dy: num(r, "dy", 0),
    shx: num(r, "shx", 0.0),
    shy: num(r, "shy", 0.0),
    flipX: r.flipX ? 1 : 0,
  };
}

/** 정본 `is_identity` — 같은 1e-6 허용오차. */
export function isIdentity(t: Transform): boolean {
  return (
    Math.abs(t.rotate) < 1e-6 &&
    Math.abs(t.scale - 1.0) < 1e-6 &&
    Math.abs(t.dx) < 1e-6 &&
    Math.abs(t.dy) < 1e-6 &&
    Math.abs(t.shx) < 1e-6 &&
    Math.abs(t.shy) < 1e-6 &&
    !t.flipX
  );
}

/**
 * 정방향 2x2 선형 행렬 (m00, m01, m10, m11) = Rotate · Shear · Scale · FlipX.
 *
 * 정본 `transform_matrix` 그대로다. 화면 y-down, 양수 rotate 가 반시계.
 */
export function transformMatrix(t: Transform): [number, number, number, number] {
  const rr = (t.rotate * Math.PI) / 180;
  const c = Math.cos(rr);
  const sn = Math.sin(rr);
  const s = t.scale;
  const { shx, shy } = t;
  let m00 = s * (c + sn * shy);
  const m01 = s * (c * shx + sn);
  let m10 = s * (-sn + c * shy);
  const m11 = s * (c - sn * shx);
  if (t.flipX) {
    m00 = -m00;
    m10 = -m10;
  }
  return [m00, m01, m10, m11];
}

/** 사이드카에 담긴 상태별 변형 맵 — {프레임 인덱스: 변형}. identity 는 걸러낸다. */
export function stateTransforms(raw: unknown): Record<number, Transform> {
  const out: Record<number, Transform> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index)) continue;
    const t = normalizeTransform(value);
    // 정본 `state_plan` 과 같다 — identity 는 담지 않는다. 담아 두면 아래 적용이
    // 의미 없는 리샘플을 돌려 격자에 맞아떨어지던 픽셀을 흔든다.
    if (!isIdentity(t)) out[index] = t;
  }
  return out;
}

/**
 * 변형을 새 셀에 적용한다 (원본 불변).
 *
 * 정본 `apply_transform` 과 같은 구조다 — 정방향 행렬을 뒤집어 **출력 → 입력** 으로
 * 역매핑하고 셀 크기를 그대로 유지한다. 셀이 커지거나 작아지면 아틀라스 배치가
 * 흔들리므로 크기 보존이 계약이다.
 *
 * 보간은 bilinear (정본은 BICUBIC — 모듈 주석 참조). 알파는 프리멀티플라이 없이
 * 채널별로 섞는다. 이 프레임들은 이미 크로마 제거를 거쳐 배경이 완전 투명이고,
 * 반투명 경계에서만 미세하게 갈린다.
 */
export function applyTransform(
  frame: { data: Buffer | Uint8Array; width: number; height: number },
  transform: Transform | null | undefined,
  cell: { width: number; height: number },
): { data: Buffer; width: number; height: number } {
  const t = transform ? normalizeTransform(transform) : { ...IDENTITY };
  const cw = cell.width;
  const ch = cell.height;

  if (isIdentity(t) && frame.width === cw && frame.height === ch) {
    return { data: Buffer.from(frame.data), width: cw, height: ch };
  }

  const [m00, m01, m10, m11] = transformMatrix(t);
  let det = m00 * m11 - m01 * m10;
  // 정본과 같은 특이행렬 방어 — 0 으로 나누지 않고 부호를 지킨 최소값으로 민다.
  if (Math.abs(det) < 1e-6) det = det >= 0 ? 1e-6 : -1e-6;

  // 역 2x2 (출력 → 입력)
  const ia = m11 / det;
  const ib = -m01 / det;
  const id = -m10 / det;
  const ie = m00 / det;

  const cinX = frame.width / 2;
  const cinY = frame.height / 2;
  const coutX = cw / 2 + t.dx;
  const coutY = ch / 2 + t.dy;
  const cx = -(ia * coutX + ib * coutY) + cinX;
  const fy = -(id * coutX + ie * coutY) + cinY;

  const src = frame.data;
  const sw = frame.width;
  const sh = frame.height;
  const out = Buffer.alloc(cw * ch * 4);

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      // PIL 관례: 변환은 출력 픽셀의 **중심**(x+0.5) 에 걸리고, 샘플링 직전에 0.5 를
      // 되뺀다(Pillow `affine_transform` + `*_filter32`). 좌상단으로 계산하면 정수
      // 평행이동에서는 0.5 가 상쇄돼 같은 그림이 나오지만, 부호가 뒤집히는 변환
      // (flipX)에서는 한 픽셀이 밀린다 — 실제로 정본과 1픽셀 어긋났다.
      const sx = ia * (x + 0.5) + ib * (y + 0.5) + cx - 0.5;
      const sy = id * (x + 0.5) + ie * (y + 0.5) + fy - 0.5;
      // 경계 밖은 투명. 셀 밖으로 밀어낸 픽셀은 정본에서도 잘린다.
      if (sx < -1 || sy < -1 || sx > sw || sy > sh) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fyy = sy - y0;
      const dst = (y * cw + x) * 4;

      for (let ch4 = 0; ch4 < 4; ch4++) {
        let acc = 0;
        for (let j = 0; j <= 1; j++) {
          for (let i = 0; i <= 1; i++) {
            const px = x0 + i;
            const py = y0 + j;
            if (px < 0 || py < 0 || px >= sw || py >= sh) continue;
            const w = (i === 0 ? 1 - fx : fx) * (j === 0 ? 1 - fyy : fyy);
            if (w === 0) continue;
            acc += src[(py * sw + px) * 4 + ch4] * w;
          }
        }
        out[dst + ch4] = Math.max(0, Math.min(255, Math.round(acc)));
      }
    }
  }

  return { data: out, width: cw, height: ch };
}
