/**
 * 스프라이트 시트 이미지 크기에서 rows × cols 를 역산 (gcd 기반).
 * make_spritesheet 는 정사각 셀(cellW=cellH=min(512, floor(2048/max(rows,cols)))) 을 쓰므로
 * gcd(width,height) 의 약수 중 64~512 px 범위에서 rows/cols 가 1~16 정수가 되는 셀 크기를 찾는다.
 *
 * server.ts(MCP 후처리)와 SpriteCanvas.tsx(에디터) 가 공유하는 단일 구현.
 */
export function detectSpriteGrid(
  width: number,
  height: number,
): { rows: number; cols: number } | null {
  if (!width || !height) return null;
  const g = gcd(width, height);
  const divs: number[] = [];
  for (let d = 1; d * d <= g; d++) {
    if (g % d === 0) {
      divs.push(d);
      if (d !== g / d) divs.push(g / d);
    }
  }
  divs.sort((a, b) => b - a);
  for (const d of divs) {
    if (d < 64 || d > 512) continue;
    const c = width / d;
    const r = height / d;
    if (c >= 1 && c <= 16 && r >= 1 && r <= 16 && Number.isInteger(c) && Number.isInteger(r)) {
      if (r === 1 && c === 1) return null; // 단일 이미지 오인 방지
      return { rows: r, cols: c };
    }
  }
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
