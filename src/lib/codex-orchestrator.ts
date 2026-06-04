/**
 * Codex 직접 모드 오케스트레이터 — 규칙 기반 의도 파서.
 *
 * Claude CLI 없이 동작하는 팀원(Codex 구독만 보유)을 위해, 사용자 자연어 메시지를
 * MCP 도구 호출 명세(CodexIntent)로 변환한다. 순수 함수 — DB·파일·네트워크 접근 없음.
 *
 * chat/route.ts 의 runChatCodexDirect() 가 이 결과를 받아 ImageJob 으로 분기 실행한다.
 *
 * 마커 규약은 chat/route.ts 가 user 메시지 본문에 prefix 하는 것과 동일:
 *   [reference: <id>]  첨부 입력 이미지 (여러 개 가능 — 순서대로)
 *   [mask: <id>]       인페인트 마스크 PNG
 *   [extract]          마스크 영역(또는 prompt 부위)을 투명 배경으로 추출
 *   [spritesheet: rows=N; cols=M; ...]  스프라이트시트 디렉티브
 *
 * CodexIntent.args 는 MCP server.ts 의 CallArgs 와 호환되게 유지한다(타입 안정성 §4).
 */

export type CodexTool =
  | "generate_image"
  | "make_spritesheet"
  | "make_emote_sheet"
  | "make_tileset"
  | "generate_normal_map"
  | "edit_image"
  | "upscale_image"
  | "resize_image"
  | "remove_background"
  | "inpaint_image"
  | "reskin_image";

export type CodexIntent = {
  tool: CodexTool;
  args: {
    prompt?: string;
    inputGenerationId?: string;
    maskGenerationId?: string;
    extractObject?: boolean;
    styleReferenceId?: string;
    paletteOnly?: boolean;
    rows?: number;
    cols?: number;
    targetSize?: number;
    seamlessLoop?: boolean;
    subjectType?: string;
    anchorStrategy?: string;
    directions?: string;
    viewpoint?: string;
    strength?: number;
  };
};

const RESIZE_TARGET_SIZES = [64, 128, 256, 512, 1024, 2048, 4096, 8192];

/** 자연어에 배경 언급이 전혀 없으면 투명 배경을 기본값으로 부착. 픽셀아트면 도트 키워드도. */
function adjustPrompt(prompt: string): string {
  let p = prompt.trim();
  const lower = p.toLowerCase();
  const isPixelArt = /픽셀아트|픽셀 아트|도트|pixel art|pixelart/.test(lower);
  const mentionsBg = /배경|background|숲|하늘|dungeon|던전|forest|sky/.test(lower);
  if (isPixelArt) {
    p = p.replace(/[.,]?\s*$/, "") + ", pixel art, 16-bit style, transparent background, sharp pixels";
  } else if (!mentionsBg) {
    p = p.replace(/[.,]?\s*$/, "") + ", transparent background";
  }
  return p;
}

/** seamlessLoop 의도 감지 — 루프/사이클/idle 키워드. */
function detectSeamlessLoop(message: string): boolean {
  return /루프|loop|seamless|반복|걷기 사이클|walk cycle|idle|아이들|무한 반복|끊김 없이/i.test(message);
}

/** [spritesheet: rows=6; cols=7; subjectType=character; ...] 디렉티브 파싱. */
function parseSpritesheetMarker(marker: string): {
  rows?: number;
  cols?: number;
  subjectType?: string;
  anchorStrategy?: string;
  directions?: string;
  seamlessLoop?: boolean;
  viewpoint?: string;
} {
  const out: ReturnType<typeof parseSpritesheetMarker> = {};
  // "key=value" 쌍을 ; 로 구분. 값에 공백·콜론이 없다고 가정(디렉티브 컨벤션).
  for (const part of marker.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!val) continue;
    switch (key) {
      case "rows": out.rows = Number(val) || undefined; break;
      case "cols": out.cols = Number(val) || undefined; break;
      case "subjectType": out.subjectType = val; break;
      case "anchorStrategy": out.anchorStrategy = val; break;
      case "directions": out.directions = val; break;
      case "viewpoint": out.viewpoint = val; break;
      case "seamlessLoop": out.seamlessLoop = val === "true"; break;
    }
  }
  return out;
}

/** 메시지에서 모든 [reference: id] id 를 등장 순서대로 수집. */
function extractReferenceIds(message: string): string[] {
  const ids: string[] = [];
  const re = /\[reference:\s*([^\]]+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) ids.push(m[1].trim());
  return ids;
}

/** 모든 마커([...])와 디렉티브를 벗긴 자연어 본문. */
function stripMarkers(message: string): string {
  return message.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

/** 픽셀 크기 지정에서 targetSize(가장 가까운 허용값) 산출. */
function parseTargetSize(message: string): number | undefined {
  // "512px", "256 px", "1024x768", "64×64" 등에서 숫자 추출.
  const m = message.match(/(\d{2,5})\s*(?:px|x|×|X)/);
  if (!m) {
    const m2 = message.match(/(\d{2,5})\s*픽셀/);
    if (!m2) return undefined;
    return nearestSize(Number(m2[1]));
  }
  return nearestSize(Number(m[1]));
}

function nearestSize(n: number): number {
  let best = RESIZE_TARGET_SIZES[0];
  let bestDiff = Infinity;
  for (const s of RESIZE_TARGET_SIZES) {
    const d = Math.abs(s - n);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  return best;
}

/**
 * 자연어(+마커) 메시지를 CodexIntent 로 변환.
 * 우선순위: spritesheet 마커 > mask > extract > reference+키워드 > 키워드 단독.
 */
export function parseIntent(message: string): CodexIntent {
  const refIds = extractReferenceIds(message);
  const hasMask = /\[mask:\s*([^\]]+)\]/i.test(message);
  const maskId = message.match(/\[mask:\s*([^\]]+)\]/i)?.[1]?.trim();
  const hasExtract = /\[extract\]/i.test(message);
  const naturalText = stripMarkers(message);
  const lower = naturalText.toLowerCase();
  const seamlessLoop = detectSeamlessLoop(message);

  // ── 1. [spritesheet: ...] 디렉티브 ─────────────────────────────────────────
  const sheetMarker = message.match(/\[spritesheet:\s*([^\]]+)\]/i);
  if (sheetMarker) {
    const parsed = parseSpritesheetMarker(sheetMarker[1]);
    return {
      tool: "make_spritesheet",
      args: {
        prompt: adjustPrompt(naturalText),
        rows: parsed.rows ?? 6,
        cols: parsed.cols ?? 7,
        subjectType: parsed.subjectType,
        anchorStrategy: parsed.anchorStrategy,
        directions: parsed.directions,
        viewpoint: parsed.viewpoint,
        seamlessLoop: parsed.seamlessLoop ?? seamlessLoop,
        inputGenerationId: refIds[0],
      },
    };
  }

  // ── 2. [mask: id] → inpaint ────────────────────────────────────────────────
  if (hasMask && maskId) {
    return {
      tool: "inpaint_image",
      args: {
        prompt: adjustPrompt(naturalText) || naturalText,
        inputGenerationId: refIds[0],
        maskGenerationId: maskId,
        extractObject: hasExtract || undefined,
      },
    };
  }

  // ── 3. [extract] 단독 (마스크 없음) → inpaint extractObject ─────────────────
  if (hasExtract) {
    return {
      tool: "inpaint_image",
      args: {
        prompt: naturalText,
        inputGenerationId: refIds[0],
        extractObject: true,
      },
    };
  }

  // ── 4. [reference: id] 존재 + 키워드 → 도구 선택 ────────────────────────────
  if (refIds.length > 0) {
    const inputId = refIds[0];

    // 리스킨 / 색 팔레트 / 캐릭터 오버레이
    if (/리스킨|reskin|restyle|이 화풍|다른 색|다른 재질|색만|팔레트만|스킨 변경|캐릭터 오버레이/.test(lower)) {
      const paletteOnly = /색만|팔레트만|색상만/.test(lower);
      return {
        tool: "reskin_image",
        args: {
          inputGenerationId: inputId,
          styleReferenceId: refIds[1],
          paletteOnly: paletteOnly || undefined,
          prompt: naturalText || undefined,
        },
      };
    }

    // 업스케일 (명시 px 크기 없을 때만 — px 있으면 아래 resize 로직 우선이 아니라
    // 여기선 reference 가 있으므로 px 가 있어도 upscale 대신 resize 가 맞지만, 스펙대로
    // "px 없으면 upscale" → px 있으면 키워드가 upscale 이어도 resize 로 폴백)
    if (/업스케일|upscale|더 크게|고해상도/.test(lower)) {
      const target = parseTargetSize(naturalText);
      if (target) {
        return { tool: "resize_image", args: { inputGenerationId: inputId, targetSize: target } };
      }
      return { tool: "upscale_image", args: { inputGenerationId: inputId } };
    }

    // 표정 시트
    if (/표정 시트|emote sheet|이모트|expression sheet|여러 표정/.test(lower)) {
      return { tool: "make_emote_sheet", args: { inputGenerationId: inputId, prompt: naturalText || undefined } };
    }

    // 노멀맵
    if (/노멀맵|normal map|법선맵|라이팅용/.test(lower)) {
      return { tool: "generate_normal_map", args: { inputGenerationId: inputId } };
    }

    // 애니메이션/시트 → spritesheet (기본 6×7)
    if (/애니메이션|동작|모션|프레임|sprite sheet|시트|sheet/.test(lower)) {
      return {
        tool: "make_spritesheet",
        args: {
          prompt: adjustPrompt(naturalText),
          rows: 6,
          cols: 7,
          seamlessLoop,
          inputGenerationId: inputId,
        },
      };
    }

    // 명시 px 리사이즈 (reference 있고 위 키워드 없을 때)
    const target = parseTargetSize(naturalText);
    if (target || /리사이즈|resize/.test(lower)) {
      return {
        tool: "resize_image",
        args: { inputGenerationId: inputId, targetSize: target ?? 512 },
      };
    }

    // 배경 제거
    if (/배경 제거|remove background|투명 배경으로|배경.*없애/.test(lower)) {
      return { tool: "remove_background", args: { inputGenerationId: inputId } };
    }

    // 기본 → edit
    return {
      tool: "edit_image",
      args: { prompt: naturalText, inputGenerationId: inputId },
    };
  }

  // ── 5. 키워드 단독 (reference 없음) ─────────────────────────────────────────
  const target = parseTargetSize(naturalText);
  if (target || /리사이즈|resize/.test(lower)) {
    // 입력 이미지가 없으므로 resize 는 실행 단계에서 "참조 필요" 안내. 의도만 분류.
    return { tool: "resize_image", args: { targetSize: target ?? 512 } };
  }
  if (/배경 제거|remove background|투명 배경으로|배경.*없애/.test(lower)) {
    return { tool: "remove_background", args: {} };
  }
  if (/표정 시트|emote sheet|이모트/.test(lower)) {
    return { tool: "make_emote_sheet", args: { prompt: naturalText || undefined } };
  }
  if (/타일셋|tileset|타일 세트|심리스 타일|tileable/.test(lower)) {
    return { tool: "make_tileset", args: { prompt: naturalText } };
  }
  if (/노멀맵|normal map|법선맵/.test(lower)) {
    return { tool: "generate_normal_map", args: {} };
  }

  // 기본 → generate_image
  return { tool: "generate_image", args: { prompt: adjustPrompt(naturalText) } };
}
