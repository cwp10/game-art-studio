# 올가미 통합 액션 모드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 올가미 커밋 후 하단 바가 액션 선택 모드로 전환되어 누끼 따기 / 복제 / 이동 세 가지 작업을 제공한다.

**Architecture:** 단일 파일 `src/components/editor/CanvasEditor.tsx` 변경. 백엔드 신규 엔드포인트 없음. 이미지 편집은 브라우저 Canvas API로 클라이언트에서 처리 후 `uploadImage()`로 업로드. AI 경로는 기존 `handleExtractBrush`, `onInpaint` 재사용.

**Tech Stack:** React, TypeScript, Browser Canvas API, 기존 `uploadImage` (src/lib/api/client.ts:84)

## Global Constraints

- 변경 파일: `src/components/editor/CanvasEditor.tsx` 단일 파일
- 신규 API 엔드포인트 없음
- TypeScript strict 통과 필수 (`pnpm tsc --noEmit`)
- 빌드 게이트: `pnpm build` 에러·경고 0
- `lassoCommittedRef.current === true` 분기는 `tool === "extract" && extractMode === "lasso"` 에만 적용
- `makeLayer(generationId)` 는 x:0, y:0, scale:1 기본값 — 원본 레이어 transform 상속 시 별도 spread 필요
- `uploadImage({ dataUrl, sessionId })` → `{ generationId, width, height }` (client.ts:84)
- `onInpaint(generationId, maskDataUrl, prompt, referenceId?)` → `{ generationId } | null` (Props:135)

---

### Task 1: State/Ref 추가 + commitLassoPoints에 imagePts 저장

**Files:**
- Modify: `src/components/editor/CanvasEditor.tsx:297–308` (기존 ref 블록 직후에 추가)
- Modify: `src/components/editor/CanvasEditor.tsx:1008–1051` (commitLassoPoints)
- Modify: `src/components/editor/CanvasEditor.tsx:635–646` (clearLassoState)

**Interfaces:**
- Produces:
  - `lassoImagePtsRef: React.MutableRefObject<{x:number,y:number}[]>` — 커밋된 원본 픽셀 좌표
  - `lassoMoveOffset: {dx:number,dy:number} | null` — 이동 모드 드래그 누적값 (state)
  - `lassoDraggingMove: boolean` — 이동 모드 드래그 중 플래그 (state)
  - `lassoAiCutout: boolean` — 누끼 AI 토글 (state, 기본 false)
  - `lassoAiRestore: boolean` — 이동 후 AI 복원 토글 (state, 기본 false)

- [ ] **Step 1: 기존 ref 블록(line ~306) 직후에 신규 ref/state 추가**

`lassoMagLastClientRef` 선언 직후 아래 코드를 삽입:

```typescript
  const lassoEdgeSizeRef = useRef<{ w: number; h: number } | null>(null); // 기존 라인
  const lassoCommittedRef = useRef(false); // 기존 라인
  // --- 신규 추가 ---
  const lassoImagePtsRef = useRef<{ x: number; y: number }[]>([]); // 커밋된 원본 픽셀 좌표(SSOT)
```

그리고 `useState<number>(0)` 블록들 근처에 state 4개 추가 (`lassoPtCount` 선언 직후):

```typescript
  const [lassoPtCount, setLassoPtCount] = useState(0); // 기존 라인
  // --- 신규 추가 ---
  const [lassoMoveOffset, setLassoMoveOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [lassoDraggingMove, setLassoDraggingMove] = useState(false);
  const [lassoAiCutout, setLassoAiCutout] = useState(false);
  const [lassoAiRestore, setLassoAiRestore] = useState(false);
```

- [ ] **Step 2: commitLassoPoints에서 imagePts를 lassoImagePtsRef에 저장**

`commitLassoPoints` 내부 `const imagePts = pts.map(...)` 직후, `ctx.clearRect` 전에:

```typescript
    // LOCAL(lx/ly) → 현재 줌의 client 좌표 복원(overlay rect 기준) → screenToSource. 줌 변경 후에도 정합.
    const overlayRect = lassoOverlayRef.current?.getBoundingClientRect();
    if (!overlayRect) return;
    const imagePts = pts.map(p =>
      screenToSource(
        canvas,
        p.lx * zp.zoom + overlayRect.left,
        p.ly * zp.zoom + overlayRect.top,
        layer,
      ),
    );
    lassoImagePtsRef.current = imagePts; // ← 이 한 줄 추가
    const ctx = canvas.getContext("2d");
```

- [ ] **Step 3: clearLassoState에서 신규 ref/state 리셋**

`clearLassoState` 콜백에 아래 줄 추가 (기존 리셋 코드 마지막 부분):

```typescript
  const clearLassoState = useCallback(() => {
    lassoClientPtsRef.current = [];
    lassoRubberBandRef.current = null;
    lassoDrawingRef.current = false;
    lassoCommittedRef.current = false;
    lassoMagPrevSnapRef.current = null;
    lassoMagAccDistRef.current = 0;
    lassoMagLastClientRef.current = null;
    lassoImagePtsRef.current = [];      // ← 추가
    setLassoPtCount(0);
    setLassoMoveOffset(null);           // ← 추가
    setLassoDraggingMove(false);        // ← 추가
    const overlay = lassoOverlayRef.current;
    overlay?.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
  }, []);
```

- [ ] **Step 4: 타입 체크 통과 확인**

```bash
cd /Users/wonpyoung/Developer/workspace/game-art-studio
pnpm tsc --noEmit
```
Expected: 에러 0

- [ ] **Step 5: 커밋**

```bash
git add src/components/editor/CanvasEditor.tsx
git commit -m "feat(lasso): state/ref 추가 — lassoImagePtsRef + move/ai 상태"
```

---

### Task 2: 하단 바 — 액션 선택 모드 UI

**Files:**
- Modify: `src/components/editor/CanvasEditor.tsx` — `tool === "extract"` 하단 바 섹션 (~line 2800–2820)

**Interfaces:**
- Consumes: `lassoCommittedRef`, `lassoDraggingMove`, `lassoAiCutout`, `lassoAiRestore`, `lassoMoveOffset`
- Produces: 버튼 onClick에 연결될 `handleLassoCutout`, `handleLassoDuplicate`, `handleLassoMoveStart`, `handleLassoMoveConfirm`, `handleLassoMoveCancel` (Task 3–6에서 구현)

기존 `extractMode === "lasso"` 컨트롤 블록 (line ~2801–2820):

```tsx
{extractMode === "lasso" && (
  <>
    <div className="flex gap-0.5 rounded-md border border-border bg-bg-panel p-0.5">
      {(["free", "poly", "magnetic"] as const).map(t => (...))}
    </div>
    <button onClick={clearBrush}>전체지우기</button>
    {lassoType !== "free" && lassoPtCount >= 3 && (
      <button onClick={commitLassoPoints}>완료 (Enter)</button>
    )}
  </>
)}
```

이 블록 전체를 아래로 교체:

- [ ] **Step 1: 액션 선택 모드 UI 분기 작성**

```tsx
{extractMode === "lasso" && (
  <>
    {!lassoCommittedRef.current ? (
      /* ── 드로잉 모드 ── */
      <>
        <div className="flex gap-0.5 rounded-md border border-border bg-bg-panel p-0.5">
          {(["free", "poly", "magnetic"] as const).map(t => (
            <button
              key={t}
              onClick={() => { setLassoType(t); clearLassoState(); }}
              className={`flex h-6 items-center rounded px-2 text-[11px] ${lassoType === t ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
              title={t === "free" ? "자유 — 드래그로 그리고 떼면 자동으로 닫힘" : t === "poly" ? "다각형 — 클릭으로 꼭짓점, 더블클릭/시작점 클릭으로 닫기" : "자석 — 이미지 경계선에 자동 스냅"}
            >
              {t === "free" ? "자유" : t === "poly" ? "다각형" : "자석"}
            </button>
          ))}
        </div>
        <button onClick={clearBrush} className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary">전체지우기</button>
        {lassoType !== "free" && lassoPtCount >= 3 && (
          <button onClick={commitLassoPoints} className="rounded-md border border-[color:var(--accent)] px-2 py-1 text-[11px] text-text-primary">완료 (Enter)</button>
        )}
      </>
    ) : lassoDraggingMove || lassoMoveOffset ? (
      /* ── 이동 모드 ── */
      <>
        <span className="text-[11px] text-text-muted">드래그로 이동하세요</span>
        <button
          onClick={handleLassoMoveConfirm}
          disabled={extracting}
          className="flex h-6 items-center gap-1 rounded-lg bg-[color:var(--accent)] px-3 text-[11px] font-medium text-white disabled:opacity-40"
        >
          {extracting ? <><Loader2 size={12} className="animate-spin" /> 처리 중…</> : "확정"}
        </button>
        <button
          onClick={handleLassoMoveCancel}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
        >
          취소
        </button>
        <button
          onClick={() => setLassoAiRestore(v => !v)}
          className={`flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] ${lassoAiRestore ? "border-[color:var(--accent)] bg-[color:var(--accent)]/15 text-text-primary" : "border-border text-text-muted hover:text-text-primary"}`}
        >
          AI 복원 {lassoAiRestore ? "ON" : "OFF"}
        </button>
      </>
    ) : (
      /* ── 액션 선택 모드 ── */
      <>
        <span className="text-[11px] text-text-muted">영역이 선택됐습니다</span>
        <button
          onClick={handleLassoCutout}
          disabled={extracting}
          className="flex h-6 items-center rounded-lg border border-border px-2 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
        >
          {extracting ? <><Loader2 size={12} className="animate-spin" /></> : "누끼 따기"}
        </button>
        <button
          onClick={() => setLassoAiCutout(v => !v)}
          className={`flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] ${lassoAiCutout ? "border-[color:var(--accent)] bg-[color:var(--accent)]/15 text-text-primary" : "border-border text-text-muted hover:text-text-primary"}`}
          title="누끼 방식: OFF=즉시 픽셀 크롭, ON=AI 부드러운 누끼"
        >
          AI {lassoAiCutout ? "ON" : "OFF"}
        </button>
        <button
          onClick={handleLassoDuplicate}
          disabled={extracting}
          className="flex h-6 items-center rounded-lg border border-border px-2 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
        >
          복제
        </button>
        <button
          onClick={handleLassoMoveStart}
          className="flex h-6 items-center rounded-lg border border-border px-2 text-[11px] text-text-muted hover:text-text-primary"
        >
          이동
        </button>
        <button
          onClick={() => { clearLassoState(); setBrushPainted(false); }}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
        >
          다시 그리기
        </button>
      </>
    )}
  </>
)}
```

- [ ] **Step 2: 임시 stub 함수 선언 (Task 3–6 전 빌드 통과용)**

Task 3–6 핸들러를 구현하기 전, 컴포넌트 내부에 임시 stub을 추가:

```typescript
  // TODO: Task 3
  const handleLassoCutout = useCallback(async () => {}, []);
  // TODO: Task 4
  const handleLassoDuplicate = useCallback(async () => {}, []);
  // TODO: Task 5
  const handleLassoMoveStart = useCallback(() => {}, []);
  // TODO: Task 6
  const handleLassoMoveConfirm = useCallback(async () => {}, []);
  const handleLassoMoveCancel = useCallback(() => { setLassoMoveOffset(null); }, []);
```

- [ ] **Step 3: 타입 체크 + 빌드**

```bash
pnpm tsc --noEmit && pnpm build
```
Expected: 에러 0. UI 버튼은 noop이므로 클릭해도 아무 일 없음 — 정상.

- [ ] **Step 4: 커밋**

```bash
git add src/components/editor/CanvasEditor.tsx
git commit -m "feat(lasso): 액션 선택 모드 UI — 누끼/복제/이동/다시그리기 버튼"
```

---

### Task 3: handleLassoCutout — 픽셀 크롭 + AI 토글

**Files:**
- Modify: `src/components/editor/CanvasEditor.tsx` — Task 2에서 추가한 stub 교체

**Interfaces:**
- Consumes: `lassoImagePtsRef`, `inpaintNat`, `lassoAiCutout`, `layers`, `selectedLayerId`, `sessionId`, `extracting`, `handleExtractBrush`, `uploadImage`, `makeLayer`, `pushUndo`, `setLayers`, `setSelectedLayerId`, `closeTool`, `setExtracting`, `setError`
- Produces: `handleLassoCutout(): Promise<void>`

- [ ] **Step 1: stub 교체**

`// TODO: Task 3` stub을 아래로 교체:

```typescript
  const handleLassoCutout = useCallback(async () => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer || !inpaintNat || extracting) return;
    const imagePts = lassoImagePtsRef.current;
    if (imagePts.length < 3) return;

    if (lassoAiCutout) {
      // AI 경로 — 기존 handleExtractBrush 재사용 (brushCanvasRef 빨강 마스크 이미 있음)
      await handleExtractBrush();
      return;
    }

    setExtracting(true);
    setError(null);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("이미지 로드 실패"));
        img.src = `/api/images/${layer.generationId}`;
      });

      const { w, h } = inpaintNat;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(imagePts[0].x, imagePts[0].y);
      imagePts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();

      const dataUrl = canvas.toDataURL("image/png");
      const r = await uploadImage({ dataUrl, sessionId });
      pushUndo();
      const nl: Layer = {
        ...makeLayer(r.generationId),
        x: layer.x,
        y: layer.y,
        scale: layer.scale,
        stretchW: layer.stretchW,
        stretchH: layer.stretchH,
        rotation: layer.rotation,
        flipH: layer.flipH,
      };
      setLayers(prev => [...prev, nl]);
      setSelectedLayerId(nl.id);
      closeTool();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [layers, selectedLayerId, inpaintNat, extracting, lassoAiCutout, handleExtractBrush,
      sessionId, pushUndo, setLayers, setSelectedLayerId, closeTool, setExtracting, setError]);
```

- [ ] **Step 2: 타입 체크**

```bash
pnpm tsc --noEmit
```
Expected: 에러 0

- [ ] **Step 3: 수동 검증**

1. CanvasEditor 열기 → 레이어 선택 → 레이어 분리 → 올가미
2. 자유 올가미로 피사체 외곽 드래그 → 커밋 확인 (파란 영역)
3. "누끼 따기" 클릭 → 잠시 후 새 레이어 추가됨
4. 새 레이어가 폴리곤 형태로 투명 배경 누끼인지 확인
5. AI ON 토글 후 "누끼 따기" → AI 경로로 부드러운 누끼 생성 확인

- [ ] **Step 4: 커밋**

```bash
git add src/components/editor/CanvasEditor.tsx
git commit -m "feat(lasso): handleLassoCutout — 픽셀 크롭 + AI 누끼 토글"
```

---

### Task 4: handleLassoDuplicate — 원본 유지 복제

**Files:**
- Modify: `src/components/editor/CanvasEditor.tsx` — Task 2 stub 교체

**Interfaces:**
- Consumes: `lassoImagePtsRef`, `inpaintNat`, `layers`, `selectedLayerId`, `sessionId`, `extracting`, `uploadImage`, `makeLayer`, `pushUndo`, `setLayers`, `setSelectedLayerId`, `closeTool`, `setExtracting`, `setError`
- Produces: `handleLassoDuplicate(): Promise<void>`

- [ ] **Step 1: stub 교체**

`// TODO: Task 4` stub을 아래로 교체 (handleLassoCutout 픽셀 경로와 동일하되 원본 레이어 제거 없음):

```typescript
  const handleLassoDuplicate = useCallback(async () => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer || !inpaintNat || extracting) return;
    const imagePts = lassoImagePtsRef.current;
    if (imagePts.length < 3) return;

    setExtracting(true);
    setError(null);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("이미지 로드 실패"));
        img.src = `/api/images/${layer.generationId}`;
      });

      const { w, h } = inpaintNat;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(imagePts[0].x, imagePts[0].y);
      imagePts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();

      const dataUrl = canvas.toDataURL("image/png");
      const r = await uploadImage({ dataUrl, sessionId });
      pushUndo();
      // 원본 레이어 transform 상속, 원본은 유지
      const nl: Layer = {
        ...makeLayer(r.generationId),
        x: layer.x,
        y: layer.y,
        scale: layer.scale,
        stretchW: layer.stretchW,
        stretchH: layer.stretchH,
        rotation: layer.rotation,
        flipH: layer.flipH,
      };
      setLayers(prev => [...prev, nl]);
      setSelectedLayerId(nl.id);
      closeTool();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [layers, selectedLayerId, inpaintNat, extracting,
      sessionId, pushUndo, setLayers, setSelectedLayerId, closeTool, setExtracting, setError]);
```

- [ ] **Step 2: 타입 체크**

```bash
pnpm tsc --noEmit
```
Expected: 에러 0

- [ ] **Step 3: 수동 검증**

1. 올가미로 영역 선택 후 커밋
2. "복제" 클릭 → 원본 레이어 그대로 + 새 레이어가 동일 위치에 추가됨 확인
3. 새 레이어 이동(x,y 드래그)으로 복제 레이어가 분리됨 확인

- [ ] **Step 4: 커밋**

```bash
git add src/components/editor/CanvasEditor.tsx
git commit -m "feat(lasso): handleLassoDuplicate — 원본 유지 픽셀 복제"
```

---

### Task 5: 이동 모드 드래그 + 오버레이 시각화

**Files:**
- Modify: `src/components/editor/CanvasEditor.tsx`
  - `redrawLassoOverlay` 함수에 `moveOff` 파라미터 추가
  - `handleLassoMoveStart`, 이동 드래그 핸들러, 오버레이 이벤트 연결

**Interfaces:**
- Consumes: `lassoClientPtsRef`, `clientToOverlay`, `lassoCommittedRef`, `lassoMoveOffset`, `setLassoMoveOffset`, `setLassoDraggingMove`, `clientToLocal`
- Produces:
  - `handleLassoMoveStart(): void`
  - `handleLassoMoveCancel(): void` (Task 2 stub 재사용 가능)
  - `onMoveDown(e): void`, `onMoveMove(e): void`, `onMoveUp(e): void`
  - `redrawLassoOverlay` — `moveOff?` 3번째 파라미터 추가

- [ ] **Step 1: redrawLassoOverlay에 moveOff 파라미터 추가**

현재 시그니처:
```typescript
const redrawLassoOverlay = useCallback(
  (extraPt?: { lx: number; ly: number }, closedFill?: boolean) => {
```

`moveOff` 파라미터 추가:
```typescript
const redrawLassoOverlay = useCallback(
  (extraPt?: { lx: number; ly: number }, closedFill?: boolean, moveOff?: { dx: number; dy: number }) => {
```

커밋 완료 상태(`lassoCommittedRef.current === true`) 분기에서 pts를 오프셋 적용:
```typescript
      if (lassoCommittedRef.current && pts.length >= 3) {
        const off = moveOff ?? { dx: 0, dy: 0 };
        const all = pts.map(p => clientToOverlay(p.lx + off.dx, p.ly + off.dy));
        // 이하 기존 파란 fill 그리기 코드 동일
```

> 주의: `redrawLassoOverlay` 기존 호출부는 모두 3번째 인자 없이 호출 중이므로 변경 없음.

- [ ] **Step 2: 이동 시작 핸들러 + 드래그 핸들러 추가**

`handleLassoMoveStart` stub을 실제 구현으로 교체:

```typescript
  const lassoDragStartRef = useRef<{ lx: number; ly: number } | null>(null);

  const handleLassoMoveStart = useCallback(() => {
    setLassoMoveOffset({ dx: 0, dy: 0 });
    // 드래그 대기 상태 — onMoveDown 에서 실제 드래그 시작
  }, []);

  const onMoveDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!lassoCommittedRef.current || lassoMoveOffset === null) return;
      e.preventDefault();
      e.stopPropagation();
      lassoDragStartRef.current = clientToLocal(e.clientX, e.clientY);
      setLassoDraggingMove(true);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    },
    [clientToLocal, lassoMoveOffset],
  );

  const onMoveMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!lassoDragStartRef.current) return;
      const cur = clientToLocal(e.clientX, e.clientY);
      const dx = cur.lx - lassoDragStartRef.current.lx;
      const dy = cur.ly - lassoDragStartRef.current.ly;
      setLassoMoveOffset({ dx, dy });
      redrawLassoOverlay(undefined, true, { dx, dy });
    },
    [clientToLocal, redrawLassoOverlay],
  );

  const onMoveUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      setLassoDraggingMove(false);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
      lassoDragStartRef.current = null;
    },
    [],
  );
```

`handleLassoMoveCancel` stub도 교체:
```typescript
  const handleLassoMoveCancel = useCallback(() => {
    setLassoMoveOffset(null);
    setLassoDraggingMove(false);
    lassoDragStartRef.current = null;
    redrawLassoOverlay(undefined, true); // offset 없이 원위치 파란 선택 영역 복원
  }, [redrawLassoOverlay]);
```

- [ ] **Step 3: 오버레이 캔버스에 이동 모드 이벤트 연결**

`isLassoActive && (...)` 로 렌더링되는 `lassoOverlayRef` 캔버스 (`~line 2154`):

```tsx
<canvas
  ref={lassoOverlayRef}
  className="absolute inset-0 z-10"
  style={{
    width: "100%",
    height: "100%",
    pointerEvents: lassoType === "free" ? "none" : "auto",
    cursor: lassoMoveOffset !== null ? "move" : "crosshair", // ← 이동 모드 커서
    touchAction: "none",
  }}
  onPointerDown={lassoType !== "free"
    ? e => { if (lassoMoveOffset !== null) { onMoveDown(e); } else { e.stopPropagation(); } }
    : lassoMoveOffset !== null ? onMoveDown : undefined
  }
  onPointerMove={e => { onLassoOverlayMove(e); if (lassoDraggingMove) onMoveMove(e); }}
  onPointerUp={e => { if (lassoDraggingMove) onMoveUp(e); }}
  onClick={lassoType !== "free" && lassoMoveOffset === null ? onLassoOverlayClick : undefined}
  onDoubleClick={onLassoOverlayDblClick}
/>
```

free 모드에서도 이동 드래그를 받을 수 있도록 `brushCanvasRef` 쪽 이벤트에도 추가 (`~line 2138`):

```tsx
onPointerDown={e => {
  if (lassoMoveOffset !== null) { onMoveDown(e); return; }
  isLassoActive ? onLassoDown(e) : onBrushDown(e, layer);
}}
onPointerMove={e => {
  if (lassoDraggingMove) { onMoveMove(e); return; }
  isLassoActive ? onLassoMove(e) : onBrushMove(e, layer);
}}
onPointerUp={e => {
  if (lassoDraggingMove) { onMoveUp(e); return; }
  isLassoActive ? onLassoUp(e) : onBrushUp(e);
}}
```

- [ ] **Step 4: 타입 체크**

```bash
pnpm tsc --noEmit
```
Expected: 에러 0

- [ ] **Step 5: 수동 검증**

1. 올가미 커밋 후 "이동" 클릭 → 커서가 move로 바뀜
2. 선택 영역 위 드래그 → 파란 폴리곤 아웃라인이 드래그에 따라 이동
3. "취소" 클릭 → 파란 선택 영역 원위치 복귀, 액션 선택 모드로 돌아옴

- [ ] **Step 6: 커밋**

```bash
git add src/components/editor/CanvasEditor.tsx
git commit -m "feat(lasso): 이동 모드 드래그 + overlay 시각화"
```

---

### Task 6: handleLassoMoveConfirm — 확정 + AI 복원

**Files:**
- Modify: `src/components/editor/CanvasEditor.tsx` — Task 2 stub 교체

**Interfaces:**
- Consumes: `lassoImagePtsRef`, `lassoMoveOffset`, `lassoAiRestore`, `inpaintNat`, `layers`, `selectedLayerId`, `sessionId`, `brushCanvasRef`, `onInpaint`, `uploadImage`, `makeLayer`, `pushUndo`, `patchLayer`, `setLayers`, `setSelectedLayerId`, `closeTool`, `setExtracting`, `setError`
- Produces: `handleLassoMoveConfirm(): Promise<void>`

- [ ] **Step 1: stub 교체**

`// TODO: Task 6` stub을 아래로 교체:

```typescript
  const handleLassoMoveConfirm = useCallback(async () => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer || !inpaintNat || !lassoMoveOffset || extracting) return;
    const imagePts = lassoImagePtsRef.current;
    if (imagePts.length < 3) return;

    setExtracting(true);
    setError(null);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("이미지 로드 실패"));
        img.src = `/api/images/${layer.generationId}`;
      });

      const { w, h } = inpaintNat;

      // Step 1 — 원본 구멍 내기 (선택 영역 투명화)
      const holeCanvas = document.createElement("canvas");
      holeCanvas.width = w; holeCanvas.height = h;
      const hctx = holeCanvas.getContext("2d")!;
      hctx.drawImage(img, 0, 0, w, h);
      hctx.globalCompositeOperation = "destination-out";
      hctx.fillStyle = "#000";
      hctx.beginPath();
      hctx.moveTo(imagePts[0].x, imagePts[0].y);
      imagePts.slice(1).forEach(p => hctx.lineTo(p.x, p.y));
      hctx.closePath();
      hctx.fill();
      const holeResult = await uploadImage({ dataUrl: holeCanvas.toDataURL("image/png"), sessionId });

      // Step 2 — 이동된 픽셀 새 레이어
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = w; cropCanvas.height = h;
      const cctx = cropCanvas.getContext("2d")!;
      cctx.drawImage(img, 0, 0, w, h);
      cctx.globalCompositeOperation = "destination-in";
      cctx.fillStyle = "#000";
      cctx.beginPath();
      cctx.moveTo(imagePts[0].x, imagePts[0].y);
      imagePts.slice(1).forEach(p => cctx.lineTo(p.x, p.y));
      cctx.closePath();
      cctx.fill();
      const cropResult = await uploadImage({ dataUrl: cropCanvas.toDataURL("image/png"), sessionId });

      pushUndo();
      patchLayer(layer.id, { generationId: holeResult.generationId });
      const nl: Layer = {
        ...makeLayer(cropResult.generationId),
        x: layer.x + lassoMoveOffset.dx,
        y: layer.y + lassoMoveOffset.dy,
        scale: layer.scale,
        stretchW: layer.stretchW,
        stretchH: layer.stretchH,
        rotation: layer.rotation,
        flipH: layer.flipH,
      };
      setLayers(prev => [...prev, nl]);
      setSelectedLayerId(nl.id);

      // Step 3 — AI 복원 (선택적): 구멍을 inpaint로 채움
      if (lassoAiRestore) {
        const bc = brushCanvasRef.current;
        if (bc) {
          const out = document.createElement("canvas");
          out.width = bc.width; out.height = bc.height;
          const octx = out.getContext("2d")!;
          octx.fillStyle = "#000";
          octx.fillRect(0, 0, out.width, out.height);
          octx.drawImage(bc, 0, 0);
          const maskDataUrl = out.toDataURL("image/png");
          const restoreResult = await onInpaint(holeResult.generationId, maskDataUrl, "background fill");
          if (restoreResult) {
            patchLayer(layer.id, { generationId: restoreResult.generationId });
          }
        }
      }

      closeTool();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [layers, selectedLayerId, inpaintNat, lassoMoveOffset, extracting, lassoAiRestore,
      sessionId, brushCanvasRef, onInpaint, pushUndo, patchLayer,
      setLayers, setSelectedLayerId, closeTool, setExtracting, setError]);
```

- [ ] **Step 2: 타입 체크 + 빌드**

```bash
pnpm tsc --noEmit && pnpm build
```
Expected: 에러·경고 0

- [ ] **Step 3: 수동 검증**

**시나리오 A — 이동 (AI 복원 OFF)**
1. 올가미로 캐릭터 일부 선택 → 커밋
2. "이동" → 다른 위치로 드래그 → "확정"
3. 원본 레이어에 구멍(투명)이 생기고, 이동된 픽셀이 새 레이어로 추가됨 확인

**시나리오 B — 이동 (AI 복원 ON)**
1. 동일하게 이동 후 확정 전 "AI 복원 ON"
2. 확정 → 원본 구멍이 배경으로 채워짐 확인 (속도 느릴 수 있음)

**시나리오 C — 전체 흐름 회귀**
1. 누끼 따기 정상 동작 확인
2. 복제 정상 동작 확인
3. 다시 그리기 → 드로잉 모드 복귀 확인
4. closeTool(×) 후 다시 열면 상태 초기화 확인

- [ ] **Step 4: 최종 커밋**

```bash
git add src/components/editor/CanvasEditor.tsx
git commit -m "feat(lasso): handleLassoMoveConfirm — 이동 확정 + AI 복원 옵션"
```

---

## 자체 검토

### 스펙 커버리지
- ✅ 누끼 따기 (픽셀 로컬 + AI 토글) — Task 3
- ✅ 복제 → 새 레이어 — Task 4
- ✅ 이동 (cut & move) + AI 복원 토글 — Task 5, 6
- ✅ 커밋 후 하단 바 액션 선택 모드 전환 — Task 2
- ✅ 다시 그리기 → 드로잉 모드 복귀 — Task 2 (clearLassoState 재사용)
- ✅ 이동 모드 드래그 오버레이 시각화 — Task 5

### 타입 일관성
- `lassoImagePtsRef.current: {x:number,y:number}[]` — Task 1 정의, Task 3/4/5/6 소비
- `lassoMoveOffset: {dx:number,dy:number}|null` — Task 1 정의, Task 5 쓰기, Task 6 읽기
- `Layer` 타입 spread — Task 3/4/6 모두 `...makeLayer(id), x, y, scale, ...` 동일 패턴
- `uploadImage({ dataUrl, sessionId })` — 모든 Task에서 동일 시그니처 사용
- `onInpaint(generationId, maskDataUrl, prompt, referenceId?)` — Task 6에서 4번째 인자 생략(선택)
