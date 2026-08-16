/**
 * 플랜 구동(component-row) 경로 적용 판정 — **순수 함수만** 둔다.
 *
 * MCP 핸들러(`plan-driven-spritesheet.ts`)와 패널(`SpriteGenPanel`)이 같은 판정을
 * 써야 해서 여기로 뺐다. 핸들러 쪽은 DB·sharp 를 import 하므로 클라이언트에서
 * 못 부른다.
 *
 * 조건을 양쪽에 복제하면 갈린다 — 이번 저장소에서 실제로 그랬다: 피사체 추론이
 * `MessageList` 와 `ChatLayout` 두 곳에 복제돼 있었고, 한쪽만 고쳐 캐릭터가
 * 오브젝트로 열리는 버그가 남았다.
 */

export type PlanDrivenGateInput = {
  subjectType: string;
  directions: number | null;
  refId: string | null;
};

/**
 * 이 경로를 쓸 수 있는가. 정본의 component-row 엔진 적용 범위와 같다.
 * 하나라도 어긋나면 기존 격자 경로가 처리한다.
 */
export function canUsePlanDrivenPath(opts: PlanDrivenGateInput): boolean {
  return planDrivenBlocker(opts) === null;
}

/**
 * 플랜 구동 경로를 쓸 수 **없는** 이유. 쓸 수 있으면 null.
 *
 * 이유를 문자열로 돌려주는 목적은 하나다 — 구 격자 경로로 떨어진 사실이 **조용하지
 * 않게** 하는 것. 정본이 base 잠금을 BLOCKING 으로 둔 이유가 "약한 base 가 모든 행을
 * 오염시킨다" 인데, 우리 쪽 조용한 폴백은 그 게이트를 통째로 건너뛰게 만든다.
 */
export function planDrivenBlocker(opts: PlanDrivenGateInput): string | null {
  if (opts.subjectType !== "character") {
    return `피사체가 '${opts.subjectType}' — component-row 엔진은 캐릭터 상태 행을 위한 것이라 이펙트·오브젝트는 격자 경로가 맞습니다`;
  }
  if (opts.directions !== null && opts.directions > 1) {
    return `다방향(${opts.directions}) 시트 — 아직 플랜 구동 경로가 단일 방향만 받습니다`;
  }
  if (!opts.refId) {
    return "참조 이미지가 없습니다 — base 를 먼저 만들고 잠그면 component-row 엔진(방향 앵커 체인 · 컴포넌트 추출 · 큐레이션)을 씁니다";
  }
  return null;
}
