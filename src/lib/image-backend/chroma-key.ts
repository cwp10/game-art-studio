/**
 * 공유 chroma-key 모듈 — green/magenta 적응형 키잉 + flood-fill 본체 보호 + despill.
 *
 * 이 적응형 구현은 원래 spritesheet-postprocess.ts 에만 있었고 codex-exec.ts 는 단순
 * greenness-feather 별도 구현을 썼다. 두 경로가 동일 알고리즘을 쓰도록 여기로 추출했다.
 *   - spritesheet-postprocess.ts: chromaKeyFile 로 re-export
 *   - codex-exec.ts: green 전용 얇은 래퍼(chromaKeyGreen)가 호출
 *
 * sharp + node:fs 만 의존하는 순수 픽셀 모듈. top-level 사이드이펙트 없음.
 */
import fs from "node:fs";
import sharp from "sharp";

export type ChromaKeyColor = "green" | "magenta";

/**
 * 녹색 피사체/이펙트 감지 정규식 — green 대신 magenta(#ff00ff) chroma-key 로 전환할지 결정.
 *
 * 초록 발광 이펙트(독·산성·자연마법 등)나 녹색 본체(슬라임·이끼)는 green screen 위에 그리면
 * chroma-key 후처리에서 본체가 함께 날아간다. 이 패턴에 걸리면 magenta 배경으로 생성·키잉한다.
 *
 * 주의: magic·glow·enchanted 같은 범용어는 넣지 않는다 — 파란/빨간 마법까지 magenta 로 가버린다.
 * 명시적으로 초록 계열을 가리키는 색·소재·이펙트 어휘만 포함한다.
 *
 * server.ts(generate_image), spritesheet-handler.ts(make_spritesheet),
 * codex-exec.ts(remove_bg/layer_extract) 세 경로가 같은 기준을 쓰도록 단일 소스로 둔다.
 */
export const GREEN_SUBJECT_RE =
  /녹색|초록|연두|green|슬라임|slime|잎|leaf|이끼|moss|독성|독액|독|산성|자연\s*마법|풀숲|풀|초원|포이즌|에메랄드|poison|toxic|acid|venom|nature\s*magic|emerald|jade|lime|herb|algae/i;

type Logger = (line: string) => void;
const noop: Logger = () => {};

/**
 * chroma-key 처리 (in-place). keyColor 에 따라 keyness 정의가 다름:
 *   - green:   keyness = g - max(r,b)   (#00ff00 류)
 *   - magenta: keyness = min(r,b) - g   (#ff00ff 류 — R·B 높고 G 낮음)
 *
 * 처리:
 *   1. 적응형 임계값: 명백한 키 픽셀들의 keyness 분포를 샘플링해 hard-key 임계값을
 *      실제 톤에 맞춰 보수적으로 보정(기본 40 근처에서 제한 범위 내).
 *   2. 본체 보호: 시트 가장자리에서 4-connectivity 로 도달 가능한 키 픽셀(=배경)만
 *      투명화. 캐릭터에 둘러싸인 내부 키색(녹색 옷 안쪽)은 보존.
 *   3. despill: 배경-connected 영역 경계의 fringe 픽셀 키 채널을 탈채도 + 알파 감쇠.
 *
 * 반환: 투명화된(keyedOut) 픽셀 수. 호출측이 0 이면 fallbackBgRemove 폴백.
 */
export async function chromaKeyFile(
  filePath: string,
  keyColor: ChromaKeyColor = "green",
  log: Logger = noop,
  // 셀 면적(px) — enclosed 포켓 키아웃 임계 기준. 시트는 cellW*cellH, 단일 이미지는 미지정(전체).
  cellArea?: number,
): Promise<number> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const W = info.width;
  const H = info.height;
  const N = W * H;

  // keyness: 키 색에 가까울수록 큰 양수.
  const keyness = (i: number): number => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return keyColor === "green" ? g - Math.max(r, b) : Math.min(r, b) - g;
  };
  // 키색 dominant 채널이 충분히 밝은지(확실한 키 픽셀 판정 보조).
  const keyChannelBright = (i: number): boolean =>
    keyColor === "green" ? data[i + 1] > 90 : data[i] > 90 && data[i + 2] > 90;

  // 1. 적응형 hard 임계값 — 명백한 키 픽셀(keyness>60)의 중앙값 keyness 를 보고
  //    기본 40 을 [30,50] 범위로 보정. 분포가 약하면 기본 유지(보수적).
  const strong: number[] = [];
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    const k = keyness(i);
    if (k > 60 && keyChannelBright(i)) strong.push(k);
  }
  // 기본 50: 강한 녹색 신호 없을 때(투명 배경 리스킨 등) keyness 41-50 구간의
  // 파란초록 계열 콘텐츠 픽셀(망토·스카프 등)을 실수로 키아웃하지 않도록 보수적으로 설정.
  // 실제 green-bg 이미지는 strong.length>N*0.02 로 적응형 분기가 켜져 이 값을 덮어씀.
  let hardThresh = 50;
  if (strong.length > N * 0.02) {
    strong.sort((a, b) => a - b);
    const median = strong[Math.floor(strong.length / 2)];
    // magenta 키는 배경이 순수 #ff00ff(keyness≈255)이므로 임계값을 높게 유지해야
    // 자주색/보라색 캐릭터 픽셀(keyness 80-130)을 실수로 키아웃하지 않는다.
    // green 키는 기존 [30,50] 유지.
    const [thMin, thMax] = keyColor === "magenta" ? [120, 200] : [30, 50];
    hardThresh = Math.max(thMin, Math.min(thMax, Math.round(median * 0.5)));
  }
  const fringeFloor = keyColor === "green" ? 5 : 2;
  const fringeSpan = Math.max(8, Math.round((hardThresh - fringeFloor) * 0.6));

  // 2. hard-key 후보 마스크.
  const isHardKey = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    if (keyness(i) > hardThresh && keyChannelBright(i)) isHardKey[p] = 1;
  }

  // 3. 테두리에서 flood fill(4-conn) → 배경-connected hard-key 만 bgKey=1.
  //    내부에 둘러싸인 키색(녹색 옷 안쪽)은 도달 못 해 보존됨.
  const bgKey = new Uint8Array(N);
  const stack: number[] = [];
  const pushIfKey = (p: number) => {
    if (p >= 0 && p < N && isHardKey[p] === 1 && bgKey[p] === 0) {
      bgKey[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < W; x++) {
    pushIfKey(x); // top row
    pushIfKey((H - 1) * W + x); // bottom row
  }
  for (let y = 0; y < H; y++) {
    pushIfKey(y * W); // left col
    pushIfKey(y * W + (W - 1)); // right col
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % W;
    if (x > 0) pushIfKey(p - 1);
    if (x < W - 1) pushIfKey(p + 1);
    if (p >= W) pushIfKey(p - W);
    if (p < N - W) pushIfKey(p + W);
  }

  // 3.5. enclosed 키 포켓 키아웃 — 테두리에서 도달 못 한 hard-key(다리 사이 등) 중
  //   "셀 대비 작은" 컴포넌트만 배경 bleed 로 보고 추가 투명화. 큰 내부 키색(녹색 옷·
  //   슬라임 본체)은 보존(CASE D/E 회귀 금지). 다리 사이 포켓은 셀의 <1% 수준인 반면
  //   옷 패치는 셀의 수% 이상이라 셀 면적 비율로 구분된다.
  {
    // 셀 면적 미지정 시 전체 이미지를 한 셀로 간주(단일 이미지 경로 보수적 처리).
    const cellPx = cellArea && cellArea > 0 ? cellArea : N;
    const pocketCap = Math.max(48, Math.round(cellPx * 0.02)); // 셀의 2% 미만 = 포켓
    const visited = new Uint8Array(N);
    const cstk: number[] = [];
    for (let s = 0; s < N; s++) {
      if (isHardKey[s] !== 1 || bgKey[s] === 1 || visited[s] === 1) continue;
      visited[s] = 1;
      const comp: number[] = [s];
      cstk.length = 0;
      cstk.push(s);
      while (cstk.length > 0) {
        const p = cstk.pop()!;
        const x = p % W;
        const tryp = (q: number) => {
          if (q >= 0 && q < N && isHardKey[q] === 1 && bgKey[q] === 0 && visited[q] === 0) {
            visited[q] = 1;
            comp.push(q);
            cstk.push(q);
          }
        };
        if (x > 0) tryp(p - 1);
        if (x < W - 1) tryp(p + 1);
        if (p >= W) tryp(p - W);
        if (p < N - W) tryp(p + W);
      }
      if (comp.length < pocketCap) {
        for (const p of comp) bgKey[p] = 1; // 작은 포켓 → 배경으로 흡수
      }
    }
  }

  // 3.6. bgKey 까지의 거리장(BFS, 반경 DESPILL_RADIUS 까지만). despill 존을 배경 경계
  //   1px → N px feather 로 확대해 다크 엣지 2~3px 안쪽 녹색 halo 까지 잡되, 내부 깊은
  //   키색(옷·본체)은 거리 > 반경이라 영향 없음(CASE D 보존).
  const DESPILL_RADIUS = 14; // 경계에서 먼 fringe 잔재까지 흡수 (green/magenta 동일)
  const bgDist = new Uint8Array(N).fill(255);
  {
    const bfs: number[] = [];
    for (let p = 0; p < N; p++) {
      if (bgKey[p] === 1) {
        bgDist[p] = 0;
        bfs.push(p);
      }
    }
    let head = 0;
    while (head < bfs.length) {
      const p = bfs[head++];
      const d = bgDist[p];
      if (d >= DESPILL_RADIUS) continue;
      const x = p % W;
      const relax = (q: number) => {
        if (q >= 0 && q < N && bgDist[q] > d + 1) {
          bgDist[q] = d + 1;
          bfs.push(q);
        }
      };
      if (x > 0) relax(p - 1);
      if (x < W - 1) relax(p + 1);
      if (p >= W) relax(p - W);
      if (p < N - W) relax(p + W);
    }
  }

  // 4. 적용: 배경-connected hard-key → 투명. 배경 경계 DESPILL_RADIUS 이내 fringe → despill + 알파 감쇠.
  let keyedOut = 0;
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    if (bgKey[p] === 1) {
      data[i + 3] = 0;
      keyedOut++;
      continue;
    }
    if (data[i + 3] === 0) continue;
    const k = keyness(i);
    if (k <= fringeFloor) continue;
    // fringe 는 배경(bgKey)에서 반경 이내일 때만 처리 — 내부 깊은 키색 보존.
    if (bgDist[p] > DESPILL_RADIUS) continue;
    // despill: 키 채널을 반대 채널 쪽으로 끌어내림(green→g=max(r,b), magenta→r,b=g).
    // magenta despill: G 채널이 높으면 진짜 자주색/보라색 캐릭터 픽셀이므로 스킵.
    // 마젠타 스필은 G≈0-20, 자주색 캐릭터는 G≈30-80 으로 구분 가능.
    if (keyColor === "green") {
      // 배경 거리에 따라 despill 강도 조절: 가까울수록 더 강하게
      const spillStrength = 1 - bgDist[p] / (DESPILL_RADIUS + 1);
      const targetG = Math.max(data[i], data[i + 2]);
      data[i + 1] = Math.round(data[i + 1] - (data[i + 1] - targetG) * Math.max(0.5, spillStrength));
      if (data[i + 1] > 0) data[i + 1] = Math.max(0, data[i + 1] - 3);
    } else {
      if (data[i + 1] > 80) continue; // G 높음 → 자주색 캐릭터, despill 스킵
      data[i] = data[i + 1];
      data[i + 2] = data[i + 1];
    }
    const fade = 1 - Math.min(1, (k - fringeFloor) / fringeSpan);
    data[i + 3] = Math.round(data[i + 3] * fade);
  }

  // Alpha erosion: 배경 경계 1px 이내 픽셀을 투명화해 despill 후 남은 fringe 잔재 제거.
  // 이펙트·소프트 경계 이미지에서 haloing을 확실히 없앤다.
  for (let p = 0; p < N; p++) {
    if (data[p * ch + 3] === 0) continue;
    if (bgDist[p] <= 1) data[p * ch + 3] = 0;
  }

  const tmpPath = filePath + ".chroma.tmp";
  try {
    await sharp(data, {
      raw: { width: W, height: H, channels: ch as 1 | 2 | 3 | 4 },
    })
      .png()
      .toFile(tmpPath);
    fs.renameSync(tmpPath, filePath);
  } finally {
    // rename 성공 시 .tmp 는 이미 사라짐. write/rename 사이 크래시·예외로 남은 고아만 정리.
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
  log(`chromaKeyFile(${keyColor}): hardThresh=${hardThresh} keyedOut=${keyedOut}/${N}`);
  return keyedOut;
}
