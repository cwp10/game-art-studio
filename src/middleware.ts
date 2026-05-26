import { NextRequest, NextResponse } from "next/server";

/**
 * 개인용 로컬 도구 가드.
 *
 * dev/start 스크립트는 `-H 127.0.0.1` 로 binding 되어 외부 노출 없어야 하지만, 사용자가
 * 우연히 `next dev -H 0.0.0.0` 으로 띄우거나 reverse proxy 뒤에 두는 경우를 위한
 * second-line guard:
 *
 *   1. /api/* 요청만 검사 (UI 페이지는 손쉬운 데모 의도로 통과)
 *   2. Host 헤더가 localhost / 127.0.0.1 / [::1] 이 아니면 403
 *   3. Origin 헤더가 있으면 같은 host 만 허용 (CSRF 1차 가드)
 */

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const host = req.headers.get("host")?.split(":")[0]?.toLowerCase();
  if (!host || !ALLOWED_HOSTS.has(host)) {
    return new NextResponse("forbidden: local only", { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const oh = new URL(origin).hostname.toLowerCase();
      if (!ALLOWED_HOSTS.has(oh)) {
        return new NextResponse("forbidden: cross-origin", { status: 403 });
      }
    } catch {
      return new NextResponse("forbidden: invalid origin", { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
