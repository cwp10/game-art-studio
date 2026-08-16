/**
 * 크로마 알파 정리 — sprite_gen/extract.py `remove_chroma_background()` 이식.
 *
 * 픽셀을 고치는 패스는 3개다(`docs/chroma-alpha.md` "Three passes, in order"):
 *
 *   1. 분류 + 하드 키 컷 — 키에서 `keyThreshold` 안이거나 이미 투명한 픽셀을 지우고
 *      RGB 도 0 으로 만든다(헤일로 방지).
 *   2. 소프트 알파 unmix — 키 영역 근처의 키 틴트 블렌드를 despill RGB + 부분 알파로
 *      분리한다. 블렌드 모델 `observed = (1-k)·subject + k·key` 를 키 틴트 점수에서
 *      풀어, 안티에일리어싱 실루엣이 이진 계단으로 무너지지 않고 커버리지 램프를 지킨다.
 *      in-band 와 out-of-band 는 **같은 루프의 적격 조건**이다(별도 패스가 아니다):
 *      in-band 는 키 깊이 ≤ 2 일 때만, out-of-band 는 항상.
 *   3. 갇힌 스필 despill — 소재 내부에 박힌 작은 키 틴트 덩어리(머리카락 사이 스필)는
 *      제자리에서 색만 고친다. 알파를 유지한다 — 불투명 소재 안이라 커버리지가 아니라
 *      색 보정이고, 부분 알파를 주면 스프라이트에 바늘구멍이 뚫린다.
 *      큰 키 틴트 영역은 의도된 소재이므로 건드리지 않는다.
 *
 * numpy 대신 타입드 배열 + 평면 루프. 값은 원본과 같은 정수 산술 위에서 계산한다.
 */

/** 원본 CLI 기본값 (`extract.py:2197-2210`). */
export const DEFAULT_KEY_THRESHOLD = 96.0;
export const DEFAULT_FRINGE_KEY_THRESHOLD = 180.0;
export const DEFAULT_FRINGE_DELTA = 18.0;
export const DEFAULT_UNMIX_REACH = 4;
export const DEFAULT_SPILL_MAX_FRACTION = 0.005;

/** in-band 블렌드는 키에서 이 깊이 안일 때만 unmix 대상이다 (v1.10.1 가드레일). */
const IN_BAND_UNMIX_KEY_DEPTH = 2;
const SPILL_MIN_TINT = 40.0;

/** remove_chroma_background 픽셀 분류. 소스 색으로 한 번만 정한다. */
const KEYED = 0; // 지워짐: 투명 입력 또는 하드 키 컷
const SUBJECT = 1; // 키 틴트 없음 — 절대 건드리지 않는다
const BLEND_IN_BAND = 2; // 키 틴트, fringeKeyThreshold 안
const BLEND_OUT_OF_BAND = 3; // 키 틴트, fringeKeyThreshold 밖

export type RGB = readonly [number, number, number];

/**
 * 키가 포화시키는 채널과 어둡게 두는 채널.
 *
 * 키에만 의존하므로 한 번 푼다. 퇴화 키(포화 채널이 없거나 어두운 채널이 없음)는
 * 틴트 축 자체가 없어 빈 배열 둘로 돌아오고, 그 빈 상태가 unmix·스필 패스를 끄는
 * 유일한 스위치다.
 */
export function keyChannelSplit(chromaKey: RGB): { keyed: number[]; unkeyed: number[] } {
  const keyed: number[] = [];
  const unkeyed: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (chromaKey[i] >= 192) keyed.push(i);
    if (chromaKey[i] < 64) unkeyed.push(i);
  }
  if (keyed.length === 0 || unkeyed.length === 0) return { keyed: [], unkeyed: [] };
  return { keyed, unkeyed };
}

export function keyTintScore(color: RGB, chromaKey: RGB): number {
  const { keyed, unkeyed } = keyChannelSplit(chromaKey);
  if (keyed.length === 0) return 0;
  let ks = 0;
  for (const i of keyed) ks += color[i];
  let us = 0;
  for (const i of unkeyed) us += color[i];
  return ks / keyed.length - us / unkeyed.length;
}

/**
 * 블렌드 픽셀에서 키 성분을 추정해 RGB 에서 뺀다.
 *
 * 블렌드 모델: `observed = (1-k)·subject + k·key`. keyTintScore 는 채널에 선형이고
 * 키 자신을 `keyTint` 로 점수매기므로 `k = tint/keyTint` 가 틴트 점수 ~0 인 소재
 * 추정치를 복원한다. 소재 커버리지(1-k)와 despill 된 색을 돌려준다.
 */
export function despillColor(
  color: RGB,
  chromaKey: RGB,
  keyTint: number,
  tint: number,
): { coverage: number; color: [number, number, number] } {
  const k = Math.min(tint / keyTint, 1.0);
  const coverage = 1.0 - k;
  if (coverage <= 0) return { coverage: 0, color: [0, 0, 0] };
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = Math.min(255, Math.max(0, Math.round((color[i] - k * chromaKey[i]) / coverage)));
  }
  return { coverage, color: out };
}

/** 키/소재 블렌드 픽셀을 despill RGB + 부분 알파로 분리. */
export function unmixKeyBlend(
  color: RGB,
  alpha: number,
  chromaKey: RGB,
  keyTint: number,
  tint: number,
): [number, number, number, number] {
  const { coverage, color: despilled } = despillColor(color, chromaKey, keyTint, tint);
  const outAlpha = Math.round(alpha * coverage);
  if (outAlpha <= 0) return [0, 0, 0, 0];
  return [despilled[0], despilled[1], despilled[2], outAlpha];
}

function colorDistance(a: RGB, b: RGB): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * 8-연결 1스텝 성장. 이 스텝을 반복해 세는 것이 정확히 체비셰프 거리다.
 * 가장자리를 감싸지 않도록 명시적 인덱스로 편다.
 */
function growChebyshev(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) out[ny * width + nx] = 1;
      }
    }
  }
  return out;
}

export type ChromaCleanOptions = {
  keyThreshold?: number;
  fringeKeyThreshold?: number;
  fringeDelta?: number;
  unmixReach?: number;
  spillMaxFraction?: number;
};

/**
 * RGBA raw 버퍼를 제자리에서 정리한다. 입력은 4채널이어야 한다.
 * 반환값은 같은 버퍼(제자리 수정) — 호출자가 sharp 로 다시 감싼다.
 */
export function removeChromaBackground(
  data: Buffer,
  width: number,
  height: number,
  chromaKey: RGB,
  opts: ChromaCleanOptions = {},
): Buffer {
  const threshold = opts.keyThreshold ?? DEFAULT_KEY_THRESHOLD;
  const fringeThreshold = opts.fringeKeyThreshold ?? DEFAULT_FRINGE_KEY_THRESHOLD;
  const fringeDelta = opts.fringeDelta ?? DEFAULT_FRINGE_DELTA;
  const unmixReach = opts.unmixReach ?? DEFAULT_UNMIX_REACH;
  const spillMaxFraction = opts.spillMaxFraction ?? DEFAULT_SPILL_MAX_FRACTION;

  const n = width * height;
  const { keyed: keyedChannels, unkeyed: unkeyedChannels } = keyChannelSplit(chromaKey);
  const UNSEEN = 255;

  // ── 패스 1: 분류 + 하드 키 컷 ───────────────────────────────────────────
  // 분류는 무엇이 지워지기 전의 **소스 색**으로 정한다. 조건 순서가 곧 if/elif
  // 순서다 — subject 와 in-band 행을 바꾸면 둘 다 참인 곳에서 출력이 달라진다.
  const classes = new Uint8Array(n);
  const keyedMask = new Uint8Array(n);
  const tintField = new Float64Array(n);
  let subjectCount = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const c: RGB = [data[o], data[o + 1], data[o + 2]];
    const dist = colorDistance(c, chromaKey);
    let tint = 0;
    if (keyedChannels.length > 0) {
      let ks = 0;
      for (const k of keyedChannels) ks += c[k];
      let us = 0;
      for (const k of unkeyedChannels) us += c[k];
      tint = ks / keyedChannels.length - us / unkeyedChannels.length;
    }
    tintField[i] = tint;

    const isKeyed = data[o + 3] === 0 || dist <= threshold;
    if (isKeyed) {
      keyedMask[i] = 1;
      classes[i] = KEYED;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 0;
    } else {
      subjectCount++;
      if (tint < fringeDelta) classes[i] = SUBJECT;
      else if (dist <= fringeThreshold) classes[i] = BLEND_IN_BAND;
      else classes[i] = BLEND_OUT_OF_BAND;
    }
  }

  const keyTint = keyTintScore(chromaKey, chromaKey);

  // ── 키 영역까지의 체비셰프 거리 (패스 2의 전제 계산) ────────────────────
  // 바깥 배경과 내부 구멍(머리카락 틈)을 똑같이 센다. 소재 픽셀이 이 걸음을 막지
  // 않으므로, 소재 안에 갇힌 고립 키 블렌드도 깊이를 받는다.
  const depths = new Uint8Array(n).fill(UNSEEN);
  const maxReach = Math.min(UNSEEN - 1, keyTint > 0 ? unmixReach : 0);
  {
    let frontier = keyedMask;
    const reached = new Uint8Array(keyedMask);
    for (let i = 0; i < n; i++) if (keyedMask[i]) depths[i] = 0;
    let depth = 0;
    while (depth < maxReach) {
      let any = false;
      for (let i = 0; i < n; i++) {
        if (frontier[i]) {
          any = true;
          break;
        }
      }
      if (!any) break;
      depth++;
      const grown = growChebyshev(frontier, width, height);
      const next = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (grown[i] && !reached[i]) {
          next[i] = 1;
          depths[i] = depth;
          reached[i] = 1;
        }
      }
      frontier = next;
    }
  }

  // ── 패스 2: 소프트 알파 unmix ───────────────────────────────────────────
  if (keyTint > 0 && unmixReach > 0) {
    const reachCap = Math.min(unmixReach, UNSEEN);
    for (let i = 0; i < n; i++) {
      const d = depths[i];
      if (d === 0 || d > reachCap) continue;
      const cls = classes[i];
      const eligible =
        (cls === BLEND_IN_BAND && d <= IN_BAND_UNMIX_KEY_DEPTH) || cls === BLEND_OUT_OF_BAND;
      if (!eligible) continue;
      const o = i * 4;
      const c: RGB = [data[o], data[o + 1], data[o + 2]];
      const [r, g, b, a] = unmixKeyBlend(c, data[o + 3], chromaKey, keyTint, keyTintScore(c, chromaKey));
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      // 알파만 상한이 없다 — fringeDelta 가 음수면 coverage 가 1 을 넘어 alpha 를
      // 넘길 수 있다. 아래로는 unmixKeyBlend 가 0 으로 막는다.
      data[o + 3] = Math.min(255, a);
    }
  }

  // ── 패스 3: 갇힌 스필 despill ──────────────────────────────────────────
  if (keyTint > 0 && spillMaxFraction > 0) {
    let anyKeyed = false;
    for (let i = 0; i < n; i++) {
      if (keyedMask[i]) {
        anyKeyed = true;
        break;
      }
    }
    if (anyKeyed) {
      const spillLimit = Math.max(32, Math.round(subjectCount * spillMaxFraction));
      // **현재 색**으로 다시 점수매긴다 — 패스 2 가 일부를 고쳤고, despill 된 픽셀은
      // 더 이상 스필 후보가 아니다.
      const current = new Float64Array(n);
      const isCandidate = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (data[o + 3] === 0) continue;
        let ks = 0;
        for (const k of keyedChannels) ks += data[o + k];
        let us = 0;
        for (const k of unkeyedChannels) us += data[o + k];
        const t = ks / keyedChannels.length - us / unkeyedChannels.length;
        current[i] = t;
        if (t >= fringeDelta) isCandidate[i] = 1;
      }

      const visited = new Uint8Array(n);
      for (let start = 0; start < n; start++) {
        if (!isCandidate[start] || visited[start]) continue;
        visited[start] = 1;
        const stack = [start];
        const cluster: number[] = [];
        while (stack.length > 0) {
          const idx = stack.pop() as number;
          cluster.push(idx);
          const x = idx % width;
          const y = (idx / width) | 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
              const nb = ny * width + nx;
              if (isCandidate[nb] && !visited[nb]) {
                visited[nb] = 1;
                stack.push(nb);
              }
            }
          }
        }
        if (cluster.length > spillLimit) continue;
        let maxTint = -Infinity;
        for (const idx of cluster) if (current[idx] > maxTint) maxTint = current[idx];
        if (maxTint <= SPILL_MIN_TINT) continue;
        for (const idx of cluster) {
          const o = idx * 4;
          const c: RGB = [data[o], data[o + 1], data[o + 2]];
          const { coverage, color: despilled } = despillColor(
            c,
            chromaKey,
            keyTint,
            keyTintScore(c, chromaKey),
          );
          if (coverage > 0) {
            data[o] = despilled[0];
            data[o + 1] = despilled[1];
            data[o + 2] = despilled[2];
            // 알파는 그대로 — 색 보정이지 커버리지가 아니다.
          }
        }
      }
    }
  }

  return data;
}
