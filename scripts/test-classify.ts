/**
 * Phase 2 결정적 분류 검증 — codex 미사용 순수 함수 단위 테스트.
 *
 *   pnpm tsx scripts/test-classify.ts
 *
 * spritesheet-classify 의 inferSubjectType / classifyAnchor 를 직접 import 해
 * (prompt, hasRef) → "character" | "effect" 매핑을 단언한다.
 * 회귀 핵심: 슬래시/번개 등 발산 VFX 가 effect 로 유지되고, 캐릭터 모션 동사
 * (공격·시전·방어 등)는 character 로 분류되는지.
 */
import {
  classifyAnchor,
  inferSubjectType,
} from "../src/lib/mcp/spritesheet-classify";

let passCount = 0;
let failCount = 0;

function check(
  prompt: string,
  hasRef: boolean,
  expected: "character" | "effect",
) {
  const got = inferSubjectType(prompt, hasRef);
  const ok = got === expected;
  // inferSubjectType 와 classifyAnchor 일관성도 함께 단언.
  const anchor = classifyAnchor(prompt, hasRef);
  const consistent = anchor === expected;
  const label = `${hasRef ? "[ref] " : ""}"${prompt}" → ${got} (expect ${expected})`;
  if (ok && consistent) {
    passCount++;
    console.log(`  PASS  ${label}`);
  } else {
    failCount++;
    if (!ok) console.log(`  FAIL  ${label}`);
    if (!consistent)
      console.log(
        `  FAIL  classifyAnchor 불일치: "${prompt}" → ${anchor} vs inferSubjectType ${got}`,
      );
  }
}

console.log("── character 매핑 (캐릭터 명사 + 모션 동사: 액션이어도 character) ──");
check("마법사 걷기", false, "character");
check("마법사 공격", false, "character");
check("마법사 마법 시전", false, "character");
check("기사 idle", false, "character");
check("공격 4프레임", false, "character");
check("로봇 걷기", false, "character");
check("불 정령 idle", false, "character");
check("화염 마법사 공격", false, "character"); // char-first: 화염/마법 있어도 캐릭터 우선
check("방패로 막기", false, "character");
// 추가 경계 케이스
check("궁수 회피 구르기", false, "character");
check("전사 사망 애니메이션", false, "character");
check("기사 피격 모션", false, "character");
check("warrior attack 6 frames", false, "character");
check("wizard cast spell animation", false, "character");
check("knight block with shield", false, "character");
check("몬스터 도발 4프레임", false, "character");

console.log("── effect 매핑 (발산 VFX, 캐릭터 단어 없음) ──");
check("슬래시 이펙트", false, "effect");
check("번개 이펙트", false, "effect");
check("폭발 2x2", false, "effect");
check("검기 트레일", false, "effect");
check("화염구 폭발 이펙트", false, "effect"); // char 단어 없음
// 추가 경계 케이스
check("explosion vfx 4 frames", false, "effect");
check("beam blast effect", false, "effect");
check("충격파 이펙트", false, "effect");
check("스파크 파티클", false, "effect");
check("회오리 소용돌이 vfx", false, "effect");

console.log("── hasRef=true → 무조건 character (발산 VFX 단어 있어도) ──");
check("슬래시 이펙트", true, "character"); // ref 있으면 effect 단어여도 character
check("아무 프롬프트", true, "character");
check("폭발 vfx", true, "character");

console.log("── 모호 → character (기존 동작 유지) ──");
check("4프레임 애니메이션", false, "character");
check("2x2 grid", false, "character");
check("loop animation", false, "character");

console.log("── 회귀: 오케스트레이터 보일러플레이트 오염 방지 ──");
// "character consistent across frames" 의 'character' 가 분류를 오염시키면 안 됨.
check("슬래시 이펙트, uniform cells, character consistent across frames", false, "effect");
check("폭발 vfx, subject consistent across frames", false, "effect");

console.log(
  `\n분류 테스트: ${passCount} PASS / ${failCount} FAIL (총 ${passCount + failCount})`,
);
process.exit(failCount === 0 ? 0 : 1);
