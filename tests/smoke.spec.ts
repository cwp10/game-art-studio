import { test, expect } from "playwright/test";

test.describe("앱 기본 동작", () => {
  test("메인 페이지 로드", async ({ page }) => {
    await page.goto("/");
    // ChatLayout 렌더링 확인 — 세션 목록 영역 또는 채팅 영역
    await expect(page.locator("body")).toBeVisible();
    // 에러 페이지가 아닌지 확인
    await expect(page.locator("text=Application error")).not.toBeVisible();
    await expect(page.locator("text=500")).not.toBeVisible();
  });

  test("상태 API 전체 OK", async ({ request }) => {
    const res = await request.get("/api/status");
    const body = await res.json();
    expect(body.claude.ok).toBe(true);
    expect(body.codex.ok).toBe(true);
    expect(body.mcp.ok).toBe(true);
  });

  test("세션 목록 API 응답", async ({ request }) => {
    const res = await request.get("/api/sessions");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test("Config API 응답", async ({ request }) => {
    const res = await request.get("/api/config");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  test("채팅 UI 렌더링", async ({ page }) => {
    await page.goto("/");
    // 메시지 입력 textarea 또는 button 확인
    const composer = page.locator("textarea, [placeholder*='메시지'], [placeholder*='message']").first();
    await expect(composer).toBeVisible({ timeout: 10000 });
  });
});
