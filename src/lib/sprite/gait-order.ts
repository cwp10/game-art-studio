/**
 * 걷기·달리기 행의 **프레임 순서 판정** — 비전 모델의 답을 계약으로 좁힌다.
 *
 * ## 왜 측정이 아니라 비전인가
 *
 * 우리 추출은 프레임마다 피사체를 셀에 정규화해 넣는다(`fitToCell` + 발 무게중심 정렬).
 * 그 결과 걷기 위상의 절반인 **수직 성분이 지워진다** — 실측에서 8프레임 전부 실루엣
 * 높이 207, 하단 y 231 로 같았다. `contact → down → passing → up` 중 down/up 을
 * 가를 근거가 남지 않는다. 남는 신호인 발 폭도 124·81 사이에 89·91·91·92·95 가 몰려
 * 순서를 정하기에 부족하고, 두 발이 겹치는 프레임에서는 어느 발이 앞인지 잴 수 없다
 * (8프레임 중 5개가 그랬다).
 *
 * 사람 눈에는 그게 보인다. 정본도 같은 자리에서 사람을 부른다 — `qa-motion.md` 는
 * 휴머노이드 행의 접촉 시트를 **독립 비전 모델**에 넘겨 판정받기를 권한다.
 *
 * ## 왜 답을 세 가지로 고정하는가
 *
 * "올바른 순서를 내놓아라" 라고만 물으면 모델은 **고칠 수 없는 행에도** 그럴듯한 순서를
 * 지어낸다. 정본이 자동 프레임 순서 선택을 약속하지 말라고 못박은 것도, 모션 실패는
 * 재타이밍이 아니라 **행 재생성**으로 고치라고 한 것도 같은 이유다.
 *
 * 그래서 판정을 세 갈래로 강제한다:
 *
 *   - `reorder`            — 프레임은 온전하고 순서만 틀렸다
 *   - `drop-then-reorder`  — 중복·불량 프레임을 빼면 사이클이 선다
 *   - `regenerate`         — 재배열로는 안 된다(좌우 교대가 아예 없는 등). 다시 뽑아라
 *
 * `regenerate` 를 낼 수 있어야 이 도구가 정직해진다.
 */

/** 모델이 낼 수 있는 판정. */
export type GaitVerdict = "reorder" | "drop-then-reorder" | "regenerate";

export type GaitOrderSuggestion = {
  verdict: GaitVerdict;
  /** 재생 순서(0-based). `regenerate` 면 빈 배열. */
  order: number[];
  /** 빼기를 권한 프레임(0-based). `drop-then-reorder` 에서만 채워진다. */
  drop: number[];
  /** 사람에게 보일 근거 한두 문장. */
  reason: string;
};

export class GaitOrderInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GaitOrderInvalid";
  }
}

const VERDICTS: readonly GaitVerdict[] = ["reorder", "drop-then-reorder", "regenerate"];

/** 모델 출력에서 JSON 객체 하나를 꺼낸다 — 코드펜스·군더더기 문장을 견딘다. */
function extractJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1].trim() : text;
  // 앞뒤에 말이 붙어도 첫 `{` 부터 마지막 `}` 까지를 본다.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new GaitOrderInvalid(`판정 JSON 을 찾을 수 없습니다: ${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    throw new GaitOrderInvalid(`판정 JSON 파싱 실패: ${(e as Error).message}`);
  }
}

function asIndexList(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new GaitOrderInvalid(`${field} 가 배열이 아닙니다`);
  return value.map(v => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n)) throw new GaitOrderInvalid(`${field} 에 정수가 아닌 값: ${String(v)}`);
    return n;
  });
}

/**
 * 모델 응답을 검증된 제안으로 바꾼다.
 *
 * `frameCount` 는 그 행의 프레임 수다. 모델은 **1-based** 로 답하게 하고(접촉 시트에
 * 찍힌 번호와 같아야 사람이 대조할 수 있다) 여기서 0-based 로 낮춘다.
 *
 * 조용히 고치지 않는다 — 범위를 벗어나거나 중복된 인덱스는 던진다. 잘못된 순서를
 * 눈치채지 못한 채 채택하면 사람이 승인한 것과 다른 시퀀스가 굽힌다.
 */
export function parseGaitOrder(raw: string, frameCount: number): GaitOrderSuggestion {
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new GaitOrderInvalid(`frameCount 가 양의 정수가 아닙니다: ${String(frameCount)}`);
  }
  const parsed = extractJson(raw) as Record<string, unknown>;

  const verdict = String(parsed.verdict ?? "").trim() as GaitVerdict;
  if (!VERDICTS.includes(verdict)) {
    throw new GaitOrderInvalid(
      `알 수 없는 판정 '${String(parsed.verdict)}' — ${VERDICTS.join(" | ")} 중 하나여야 합니다`,
    );
  }

  const reason = String(parsed.reason ?? "").trim();
  if (!reason) throw new GaitOrderInvalid("reason 이 비었습니다 — 근거 없는 판정은 채택할 수 없습니다");

  // 재생성 권고에는 순서가 의미 없다. 모델이 관성으로 채워 보내도 버린다 —
  // 남겨 두면 UI 가 "이 순서로 바꾸면 된다" 로 읽힌다.
  if (verdict === "regenerate") {
    return { verdict, order: [], drop: [], reason };
  }

  const order1 = asIndexList(parsed.order, "order");
  const drop1 = asIndexList(parsed.drop, "drop");

  if (order1.length === 0) {
    throw new GaitOrderInvalid(`판정이 '${verdict}' 인데 order 가 비었습니다`);
  }
  for (const n of [...order1, ...drop1]) {
    if (n < 1 || n > frameCount) {
      throw new GaitOrderInvalid(
        `프레임 번호 ${n} 이 범위를 벗어납니다 (1..${frameCount}) — 접촉 시트와 다른 행을 본 답입니다`,
      );
    }
  }
  const seen = new Set<number>();
  for (const n of order1) {
    if (seen.has(n)) throw new GaitOrderInvalid(`order 에 프레임 ${n} 이 두 번 나옵니다`);
    seen.add(n);
  }
  for (const n of drop1) {
    if (seen.has(n)) {
      throw new GaitOrderInvalid(`프레임 ${n} 이 order 와 drop 에 동시에 있습니다`);
    }
  }

  // reorder 는 프레임을 버리지 않는다는 뜻이다 — drop 이 있으면 판정과 답이 어긋난 것.
  if (verdict === "reorder" && drop1.length > 0) {
    throw new GaitOrderInvalid(
      `판정이 'reorder' 인데 drop 이 ${drop1.length}개 있습니다 — 'drop-then-reorder' 여야 합니다`,
    );
  }
  if (verdict === "drop-then-reorder" && drop1.length === 0) {
    throw new GaitOrderInvalid("판정이 'drop-then-reorder' 인데 drop 이 비었습니다");
  }
  // 남긴 것과 뺀 것을 합치면 행 전체여야 한다. 아무 말 없이 사라진 프레임이 있으면
  // 사람이 그 프레임을 어떻게 할지 결정한 적이 없다는 뜻이다.
  if (order1.length + drop1.length !== frameCount) {
    throw new GaitOrderInvalid(
      `order(${order1.length}) + drop(${drop1.length}) 가 프레임 수 ${frameCount} 와 다릅니다 — ` +
        `언급되지 않은 프레임이 있습니다`,
    );
  }

  return {
    verdict,
    order: order1.map(n => n - 1),
    drop: drop1.map(n => n - 1),
    reason,
  };
}

/** 이 제안이 현재 순서와 같은가 — 같으면 채택 버튼을 띄울 이유가 없다. */
export function isNoOpSuggestion(s: GaitOrderSuggestion, frameCount: number): boolean {
  if (s.verdict !== "reorder") return false;
  if (s.order.length !== frameCount) return false;
  return s.order.every((v, i) => v === i);
}

/** 비전 모델에 줄 지시. 세 판정을 강제하고 1-based 번호로 답하게 한다. */
export function gaitOrderPrompt(state: string, frameCount: number): string {
  return [
    `The image is a contact sheet of ${frameCount} sprite frames from one animation row ("${state}").`,
    `Each frame has its 1-based number printed above it. Read the image, then judge the walk/run cycle.`,
    ``,
    `Judge in this order:`,
    `1. Do the frames show alternating left/right leg contact — a full gait cycle?`,
    `   Look at which leg is forward in each frame. A real cycle alternates.`,
    `2. Are any frames near-duplicates of each other, or anatomically broken?`,
    `3. Would reordering (and possibly dropping) the frames produce a readable loop?`,
    ``,
    `Answer with ONE JSON object and nothing else:`,
    `{"verdict": "reorder" | "drop-then-reorder" | "regenerate",`,
    ` "order": [1-based frame numbers in playback order],`,
    ` "drop": [1-based frame numbers to leave out],`,
    ` "reason": "one or two sentences, plain language"}`,
    ``,
    `Rules:`,
    `- "reorder": frames are all usable, only the sequence is wrong. "drop" must be empty.`,
    `- "drop-then-reorder": some frames are duplicates or broken. List them in "drop".`,
    `- "regenerate": the frames cannot form a cycle no matter the order — for example the`,
    `  same leg leads in every frame, so there is no left/right alternation to recover.`,
    `  Use this honestly. Do NOT invent a plausible order for a row that cannot work.`,
    `  For "regenerate", set "order" and "drop" to [].`,
    `- For the other two verdicts, every frame number 1..${frameCount} must appear exactly`,
    `  once across "order" and "drop" combined.`,
  ].join("\n");
}
