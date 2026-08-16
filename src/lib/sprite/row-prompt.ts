/**
 * row 프롬프트 — sprite_gen/prepare.py `row_prompt()` 이식.
 *
 * 스타일 SSoT 는 첨부 레퍼런스다. 이 빌더는 모션 서술과 레이아웃·크로마 규칙만 담고
 * 체형·비율·아웃라인 굵기를 텍스트로 재기술하지 않는다 (sprite-gen docs/pixel-unfake.md).
 *
 * 여기 문자열은 sprite-gen 의 검증 런에서 굳어진 문구다. 임의로 다듬지 마라.
 */
import type { SpriteRequest, StateSpec } from "@/lib/sprite/request";

/**
 * 기본값은 레퍼런스 추종 + 금지선만이다. 2026-07-05 사고 기록: 기본값에 있던
 * "compact chibi/chunky/thick outline" 조항이 슬림 베이스를 계속 뭉툭하게 되돌렸다.
 * 이 문자열에 체형 형용사를 더하지 마라.
 */
export const STYLE_DEFAULT =
  "match the attached base/anchor reference image EXACTLY: same pixel density " +
  "(logical pixel block size), same body proportions, same outline weight, same " +
  "palette, same shading style, same level of detail. Do not restyle, do not " +
  "change proportions, do not add or remove detail density. Avoid polished " +
  "illustration, painterly rendering, anime key art, 3D render, vector app-icon " +
  "polish, glossy lighting, soft gradients, and anti-aliased high-detail edges.";

export const TRANSPARENCY_ARTIFACT_RULES: readonly string[] = [
  "Prefer pose, expression, and silhouette changes over decorative effects.",
  "Effects are allowed only when state-relevant, opaque, hard-edged, sprite-like, fully inside the same frame slot, and physically touching or overlapping the character silhouette.",
  "Do not draw detached effects: floating stars, loose sparkles, floating punctuation, floating icons, separated smoke clouds, loose dust, disconnected outline bits, or stray pixels.",
  "Do not draw wave marks, motion arcs, speed lines, action streaks, afterimages, blur, smears, halos, glows, auras, floor patches, cast shadows, contact shadows, drop shadows, oval floor shadows, landing marks, or impact bursts.",
  "Do not include text, labels, frame numbers, visible grids, guide marks, speech bubbles, thought bubbles, UI panels, code snippets, scenery, checkerboard transparency, white backgrounds, or black backgrounds.",
  "Reject any pose that is cropped, overlaps another pose, crosses into a neighboring frame slot, or creates a separate disconnected component that is not attached to the character.",
];

const LOCOMOTION_COMMON = [
  "Use distinct gait poses that create a readable cycle instead of repeated standing or static bobbing.",
  "Do not draw speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.",
];

const DIAGONAL_NO_EFFECTS =
  "Do not draw speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.";

export const STATE_REQUIREMENTS: Record<string, readonly string[]> = {
  "running-right": [
    "Show rightward locomotion through body, arm, leg, hair, and prop movement only.",
    ...LOCOMOTION_COMMON,
  ],
  "running-left": [
    "Show leftward locomotion through body, arm, leg, hair, and prop movement only.",
    LOCOMOTION_COMMON[0],
    "If an additional rightward gait row is attached, use it only as a motion-rhythm reference for limb phase and body bounce; do not copy its facing direction or redraw the character from that row.",
    LOCOMOTION_COMMON[1],
  ],
  "running-front-right": [
    "Show 45-degree diagonal locomotion toward camera-right and slightly toward the viewer.",
    "Keep the body three-quarter-front, not pure side view and not straight front view.",
    "Use alternating foot-contact phases so the left and right legs clearly trade forward reach.",
    DIAGONAL_NO_EFFECTS,
  ],
  "running-front-left": [
    "Show 45-degree diagonal locomotion toward camera-left and slightly toward the viewer.",
    "Keep the body three-quarter-front, not pure side view and not straight front view.",
    "Use alternating foot-contact phases so the left and right legs clearly trade forward reach.",
    DIAGONAL_NO_EFFECTS,
  ],
  "running-back-right": [
    "Show 45-degree diagonal locomotion away from the viewer toward camera-right.",
    "Keep the body three-quarter-back, with the face partly hidden but the character still identifiable.",
    "Use alternating foot-contact phases so the left and right legs clearly trade backward/forward reach.",
    DIAGONAL_NO_EFFECTS,
  ],
  "running-back-left": [
    "Show 45-degree diagonal locomotion away from the viewer toward camera-left.",
    "Keep the body three-quarter-back, with the face partly hidden but the character still identifiable.",
    "Use alternating foot-contact phases so the left and right legs clearly trade backward/forward reach.",
    DIAGONAL_NO_EFFECTS,
  ],
  run: [
    "Show locomotion through body, arm, leg, hair, and prop movement only.",
    ...LOCOMOTION_COMMON,
  ],
  walk: [
    "Show locomotion through body, arm, leg, hair, and prop movement only.",
    ...LOCOMOTION_COMMON,
  ],
  frontwalk: [
    "Show front-view walking through alternating leg, arm, shoulder, and body-height changes.",
    "This is difficult: make the foot-contact and passing poses visibly different without changing identity.",
    DIAGONAL_NO_EFFECTS,
  ],
  "45_frontwalk": [
    "Show three-quarter-front walking through alternating leg, arm, shoulder, and body-height changes.",
    "This is difficult: make the foot-contact and passing poses visibly different without changing identity.",
    DIAGONAL_NO_EFFECTS,
  ],
  wave: [
    "Show the gesture through arm pose only: arm down, arm raised, hand tilted, arm returning.",
    "Keep the feet planted unless the action explicitly requests stepping.",
    "Do not draw wave marks, motion arcs, lines, sparkles, symbols, or floating effects around the hand.",
  ],
  jump: [
    "Show the jump through pose and vertical body position only: anticipation, lift, airborne peak, descent, settle.",
    "Do not draw ground shadows, contact shadows, oval shadows, landing marks, dust, smears, or motion marks under the character.",
  ],
};

/**
 * 첨부물의 권한 서열. 정체성은 앵커가, 모션 참조는 행 스트립이, 배치는 가이드가
 * 소유한다. 베이스는 ①에서 잠근 뒤 ③에서 앵커를 만드는 데만 쓰이고 행 입력에서
 * 빠지므로 sprite-gen 의 `character.base_image` 분기는 이식하지 않는다.
 */
const REFERENCE_CONTRACT =
  "Use the attached accepted idle/direction anchor as the canonical character design for this row. " +
  "If a state anchor is attached for a non-locomotion state, treat it as approved state vocabulary only. " +
  "Use the attached layout guide image only for frame count, slot spacing, centering, and safe padding. " +
  "If an additional generated row strip is attached, use it only as a motion reference, never as a replacement identity source. " +
  "Do not simply copy the still reference pose. Generate distinct animation poses that create a readable cycle or action.";

const ANCHOR_LOCK: readonly string[] = [
  "Accepted idle/direction anchors own character identity, outfit details, colors, face design, asymmetric markings, and side-specific accessories for final action rows.",
  "Base character images and original character sheets are pre-idle sources only. Do not reinterpret or reintroduce base-character details inside a direction-anchor action row.",
  "This row owns motion only. Spend the variation budget on limb contacts, arm counter-swing, body height, torso lean, head bob, hair bounce, and loop continuity.",
  "Do not redesign or reinterpret identity details while animating. Keep face, hair shape, markings, palette, outline weight, body proportions, outfit, props, and silhouette copied from the approved anchors.",
  "Preserve side-specific features exactly as the approved anchors show them. Do not solve hairpin side, earring side, logos, handed props, scars, one-sided markings, asymmetric clothing, or lighting cues from scratch inside the row.",
  "When generating a paired left/right row, use the paired row reference only for timing, scale, and animation intensity. Rotate the body, feet, shoulders, face angle, and gaze to the target facing, but keep identity details attached according to the accepted target-direction anchor.",
  "For cyclic locomotion, do not let a single running/walking pose anchor determine every frame's leg phase. Use multi-pose motion references and the layout phase guide for foot contacts.",
  "Prefer a subtler animation over any change that mutates the character identity.",
];

export function buildRowPrompt(request: SpriteRequest, state: string, entry: StateSpec): string {
  const { cell, chromaKey, character } = request;
  const frames = entry.frames;
  const runtimeSize = `${cell.width}x${cell.height}`;

  const stateRequirements = STATE_REQUIREMENTS[state] ?? [];
  const stateRequirementText = stateRequirements.length
    ? "\n\nState-specific requirements:\n" + stateRequirements.map(r => `- ${r}`).join("\n")
    : "";
  const transparencyText = TRANSPARENCY_ARTIFACT_RULES.map(r => `- ${r}`).join("\n");
  const anchorLockText = ANCHOR_LOCK.map(r => `- ${r}`).join("\n");

  return `Create a single horizontal sprite strip for the game character \`${character.id}\` in the state \`${state}\`.

${REFERENCE_CONTRACT}

Character: ${character.description || character.id}.
Style contract: ${STYLE_DEFAULT}.

Use this prompt as an authoritative sprite-production spec. Do not expand it into a polished illustration, painterly character image, anime key art, 3D render, vector mascot, glossy app icon, realistic portrait, or marketing artwork.

Animation action: ${entry.action}.

Anchor lock:
${anchorLockText}
${stateRequirementText}

Transparency and artifact rules:
${transparencyText}

Layout requirements:
- Exactly ${frames} full-body frames, left to right, in one horizontal row.
- The attached layout guide shows the ${frames} frame boxes, inner safe area, and optional motion phase hints for this row. Follow its slot count, spacing, centering, padding, and phase timing.
- Do not reproduce the layout guide itself: no visible boxes, guide lines, center marks, labels, stick figures, guide colors, or guide background may appear in the output.
- Treat the image as ${frames} equal-width invisible ${runtimeSize} frame slots. Fill every slot: each requested slot must contain exactly one complete full-body pose.
- Spread the ${frames} poses evenly across the whole image width. Do not leave any requested slot blank or create large empty gaps between poses.
- Center one complete pose in each slot. No pose may cross into the neighboring slot.
- Use a perfectly flat pure ${chromaKey.name} ${chromaKey.hex} chroma-key background across the whole image.
- Do not use ${chromaKey.hex}, pure ${chromaKey.name}, or chroma-adjacent colors in the character, highlights, props, shadows, or effects.
- Keep the rendering faithful to the attached reference sprite: same outline weight, same palette, same detail level — do not restyle it.
- Keep every frame self-contained with at least ${cell.safeMarginX} px horizontal and ${cell.safeMarginY} px vertical safe padding. No character body part should be clipped by the frame slot.
- Avoid motion blur. Use clear pose changes readable at ${runtimeSize}.
- Preserve the same silhouette, face, proportions, palette, material, and props across every frame.

Output only the sprite strip image.`;
}
