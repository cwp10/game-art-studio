/**
 * `curation-transform.ts` 가 정본 `curation.py` 의 변형 계약과 같은가.
 *
 * 수식(normalize_transform · is_identity · transform_matrix)은 **정본을 실제로 실행해**
 * 값을 맞춘다. `apply_transform` 은 보간이 다르므로(정본 BICUBIC, 우리 bilinear) 격자에
 * 정확히 맞아떨어지는 변형 — 정수 평행이동, 좌우반전, 배율 1 — 에서만 픽셀 동일을 주장하고,
 * 그 범위가 지금 UI 가 내보내는 전부다.
 *
 * 실행: npx tsx scripts/test-curation-transform.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  IDENTITY,
  applyTransform,
  isIdentity,
  normalizeTransform,
  stateTransforms,
  transformMatrix,
  type Transform,
} from "../src/lib/sprite/curation-transform";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";
const SG = "/Users/wonpyoung/Developer/workspace/sprite-gen";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

const RAW_CASES: unknown[] = [
  {},
  { dx: 3, dy: -4 },
  { rotate: 12.5 },
  { scale: 0.75 },
  { shx: 0.2, shy: -0.1 },
  { flipX: true },
  { flipX: 1, rotate: -30, scale: 1.5, dx: 10, dy: 20, shx: 0.3, shy: 0.4 },
  { rotate: "7", scale: "2" },        // 문자열 숫자
  { rotate: 0, scale: 1, dx: 0, dy: 0 },
  null,
  "쓰레기",
  { flipX: 0 },
];

const canonicalAvailable = existsSync(PY);
if (!canonicalAvailable) {
  console.log("\n! 정본 인터프리터가 없어 대조를 건너뜁니다 — 우리 쪽 계약만 검사합니다\n");
}

if (canonicalAvailable) {
  console.log("\n[1] normalize_transform · is_identity · transform_matrix — 정본과 값 대조");
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SG)})
from sprite_gen.curation import normalize_transform, is_identity, transform_matrix
out = []
for raw in json.loads(sys.argv[1]):
    try:
        t = normalize_transform(raw if isinstance(raw, dict) else {})
    except Exception as e:
        out.append({"error": str(e)}); continue
    out.append({"t": t, "identity": is_identity(t), "m": list(transform_matrix(t))})
print(json.dumps(out))
`;
  const raw = execFileSync(PY, ["-c", script, JSON.stringify(RAW_CASES)], {
    cwd: SG,
    encoding: "utf8",
  });
  const expected = JSON.parse(raw) as Array<{
    t: Transform;
    identity: boolean;
    m: [number, number, number, number];
  }>;

  RAW_CASES.forEach((input, i) => {
    const exp = expected[i];
    const got = normalizeTransform(input);
    const label = JSON.stringify(input);
    const fieldsMatch = (Object.keys(exp.t) as Array<keyof Transform>).every(
      k => Math.abs(Number(got[k]) - Number(exp.t[k])) < 1e-9,
    );
    check(`normalize ${label}`, fieldsMatch, `${JSON.stringify(got)} vs ${JSON.stringify(exp.t)}`);
    check(`is_identity ${label}`, isIdentity(got) === exp.identity);
    const m = transformMatrix(got);
    const mMatch = m.every((v, j) => Math.abs(v - exp.m[j]) < 1e-9);
    check(`matrix ${label}`, mMatch, `${JSON.stringify(m)} vs ${JSON.stringify(exp.m)}`);
  });
}

console.log("\n[2] stateTransforms — identity 는 걸러내고 정수 키만 받는다");
const st = stateTransforms({
  "0": { dx: 5 },
  "1": { rotate: 0, scale: 1 },   // identity → 제외
  "2": { flipX: 1 },
  abc: { dx: 9 },                  // 정수 아닌 키 → 제외
  "3.5": { dx: 9 },                // 정수 아닌 키 → 제외
});
check("담긴 인덱스는 0 과 2", JSON.stringify(Object.keys(st).sort()) === '["0","2"]', JSON.stringify(Object.keys(st)));
check("identity 는 제외", st[1] === undefined);
check("빈 입력은 빈 맵", Object.keys(stateTransforms(undefined)).length === 0);

console.log("\n[3] applyTransform — 셀 크기 보존, 격자 정렬 변형은 정확한 픽셀 복사");
// 8x8 셀, (2,2)-(3,3) 에 불투명 빨강 블록.
const W = 8, H = 8;
function makeFrame(): { data: Buffer; width: number; height: number } {
  const data = Buffer.alloc(W * H * 4);
  for (let y = 2; y <= 3; y++) {
    for (let x = 2; x <= 3; x++) {
      const p = (y * W + x) * 4;
      data[p] = 255; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}
function pixelAt(img: { data: Buffer; width: number }, x: number, y: number): number[] {
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
}

const frame = makeFrame();
const cell = { width: W, height: H };

const identityOut = applyTransform(frame, IDENTITY, cell);
check("identity 는 바이트 동일", Buffer.compare(identityOut.data, frame.data) === 0);
check("identity 도 원본 버퍼를 공유하지 않는다", identityOut.data !== frame.data);

const moved = applyTransform(frame, { ...IDENTITY, dx: 2, dy: 1 }, cell);
check("셀 크기 보존", moved.width === W && moved.height === H);
check("(2,2) 빨강이 (4,3) 으로 이동", JSON.stringify(pixelAt(moved, 4, 3)) === "[255,0,0,255]", JSON.stringify(pixelAt(moved, 4, 3)));
check("원래 자리는 비었다", pixelAt(moved, 2, 2)[3] === 0);
check("원본은 불변", JSON.stringify(pixelAt(frame, 2, 2)) === "[255,0,0,255]");

const flipped = applyTransform(frame, { ...IDENTITY, flipX: 1 }, cell);
check("flipX 후 원래 자리는 비었다", pixelAt(flipped, 2, 2)[3] === 0);

if (canonicalAvailable) {
  console.log("\n[4] applyTransform — 격자 정렬 변형은 정본과 픽셀 동일");
  // 정수 평행이동·좌우반전은 샘플 위치가 격자에 정확히 맞아 BICUBIC 과 bilinear 가
  // 같은 픽셀을 준다. 회전·비정수 배율은 커널이 달라 여기서 주장하지 않는다.
  const gridAligned: Array<Partial<Transform>> = [
    { dx: 2, dy: 1 },
    { dx: -3, dy: 2 },
    { flipX: 1 },
    { flipX: 1, dx: 1 },
    { scale: 1, dx: 0, dy: 0 },
  ];
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SG)})
from PIL import Image
from sprite_gen.curation import apply_transform
W = H = ${W}
src = Image.new("RGBA", (W, H), (0, 0, 0, 0))
for y in range(2, 4):
    for x in range(2, 4):
        src.putpixel((x, y), (255, 0, 0, 255))
out = []
for t in json.loads(sys.argv[1]):
    img = apply_transform(src, t, (W, H))
    out.append(list(img.tobytes()))
print(json.dumps(out))
`;
  const rawOut = execFileSync(PY, ["-c", script, JSON.stringify(gridAligned)], {
    cwd: SG,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const expectedPixels = JSON.parse(rawOut) as number[][];
  gridAligned.forEach((t, i) => {
    const got = applyTransform(frame, { ...IDENTITY, ...t }, cell);
    const exp = Buffer.from(expectedPixels[i]);
    const same = Buffer.compare(got.data, exp) === 0;
    let firstDiff = -1;
    if (!same) for (let b = 0; b < exp.length; b++) if (got.data[b] !== exp[b]) { firstDiff = b; break; }
    check(
      `정본과 픽셀 동일 ${JSON.stringify(t)}`,
      same,
      firstDiff >= 0 ? `첫 차이 byte ${firstDiff}: ${got.data[firstDiff]} vs ${exp[firstDiff]}` : "",
    );
  });
}

// 셀 밖으로 밀어낸 픽셀은 잘린다 — 정본도 같다(출력이 셀 크기 고정).
const pushed = applyTransform(frame, { ...IDENTITY, dx: 100, dy: 0 }, cell);
let anyOpaque = false;
for (let i = 0; i < W * H; i++) if (pushed.data[i * 4 + 3] !== 0) anyOpaque = true;
check("셀 밖으로 민 프레임은 전부 투명", !anyOpaque);

// 특이행렬(scale 0) 이어도 던지지 않는다 — 정본이 det 를 1e-6 으로 민다.
let threw = false;
try { applyTransform(frame, { ...IDENTITY, scale: 0 }, cell); } catch { threw = true; }
check("scale 0 에서 죽지 않는다", !threw);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
