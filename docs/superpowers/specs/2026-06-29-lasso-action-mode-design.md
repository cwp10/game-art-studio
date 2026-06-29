# 올가미 통합 액션 모드 설계

날짜: 2026-06-29  
상태: 승인됨  
대상 파일: `src/components/editor/CanvasEditor.tsx` (단일 파일)

---

## 개요

올가미 커밋 후 하단 바가 "드로잉 모드 → 액션 선택 모드"로 전환된다.  
사용자는 **누끼 따기 / 복제 / 이동** 중 하나를 선택해 실행한다.  
백엔드 신규 엔드포인트 없음. 이미지 편집은 브라우저 Canvas API(클라이언트 우선).

---

## UX 상태 흐름

```
[드로잉 모드]
  자유 / 다각형 / 자석 | 전체지우기 | 완료(Enter)
         ↓ 커밋 완료 (파란 선택 영역 확정)
[액션 선택 모드]
  누끼 따기 | 복제 | 이동 | 다시 그리기
      │          │       │
  [즉시 실행]  [즉시]  [이동 모드 진입]
  [AI 토글]           선택 영역 드래그 가능
                      [확정] [취소] [AI 복원 ON/OFF]
                            ↓ 확정
                      원본 픽셀 제거 + 새 레이어 배치
                      (AI 복원 ON → inpaint 호출)
```

**다시 그리기**: 액션 선택 모드 → 드로잉 모드 복귀. `clearLassoState()` 재사용.

---

## 신규 State / Ref

| 이름 | 타입 | 초기값 | 설명 |
|------|------|--------|------|
| `lassoMoveOffset` | `{dx:number,dy:number} \| null` | `null` | 이동 모드 드래그 누적값 |
| `lassoDraggingMove` | `boolean` | `false` | 이동 모드 드래그 중 플래그 |
| `lassoAiCutout` | `boolean` | `false` | 누끼 AI 토글 (기본: 로컬 픽셀 크롭) |
| `lassoAiRestore` | `boolean` | `false` | 이동 후 원래 자리 AI 복원 토글 |

기존 `lassoCommittedRef`로 액션 선택 모드 진입 여부를 판별 — 별도 state 불필요.

---

## 신규 핸들러

| 핸들러 | 설명 |
|--------|------|
| `handleLassoCutout()` | 누끼 따기. `lassoAiCutout` OFF → 픽셀 크롭, ON → `handleExtractBrush` 재사용 |
| `handleLassoDuplicate()` | 복제. 픽셀 크롭 후 원본 레이어 유지, 새 레이어 동일 위치 추가 |
| `handleLassoMoveStart()` | 이동 모드 진입. 오버레이를 드래그 가능 상태로 전환 |
| `handleLassoMoveConfirm()` | 이동 확정. 원본 구멍 → 새 레이어 배치 → 선택적 AI 복원 |
| `handleLassoMoveCancel()` | 이동 취소. `lassoMoveOffset = null`, 커밋 상태 유지 |
| `onMoveDown/Move/Up` | 이동 모드 드래그 핸들러 (lassoOverlayRef 재사용) |

---

## 각 액션 처리 경로

### 누끼 따기 — 로컬 픽셀 크롭 (기본)

```
lassoClientPtsRef 정점
  → screenToSource() 로 원본 픽셀 좌표 변환
  → OffscreenCanvas(originalW × originalH) 에 <img> draw
  → ctx.beginPath() + 폴리곤 + clip()
  → ctx.globalCompositeOperation = "destination-in" + fill
  → canvas.toBlob("image/png")
  → uploadImage(dataUrl) → generationId  (src/lib/api/client.ts:84)
  → addLayer(newGenerationId, {x:0, y:0})
```

### 누끼 따기 — AI (lassoAiCutout ON)

```
기존 handleExtractBrush() 그대로 재사용
(brushCanvasRef 빨강 마스크 → /api/extract → 새 레이어)
```

### 복제

```
누끼(로컬) 와 동일
단, 원본 레이어 제거 없음 — 새 레이어가 원본 위에 동일 위치로 추가됨
```

### 이동

**이동 모드 중:**
```
lassoOverlayRef onPointerDown → lassoDraggingMove = true, 기준점 기록
onPointerMove → lassoMoveOffset += {dx, dy}
               오버레이 CSS translate(dx, dy) 로 파란 선택 영역 미리보기
onPointerUp   → lassoDraggingMove = false
```

**확정 시:**
```
Step 1 — 원본 구멍 내기
  OffscreenCanvas 에 원본 이미지 draw
  폴리곤 clip + destination-out (구멍)
  → toBlob → uploadImage(dataUrl)
  → 현재 레이어 generationId 교체 (patchLayer)

Step 2 — 이동된 픽셀 새 레이어
  OffscreenCanvas 에 원본 이미지 draw + clip (누끼와 동일)
  → toBlob → uploadImage(dataUrl)
  → addLayer(id, { x: layer.x + dx, y: layer.y + dy })

Step 3 — AI 복원 (lassoAiRestore ON)
  brushCanvasRef 에 구멍 마스크 빨강으로 fill
  → handleInpaintSubmit() 호출 (빈 프롬프트 = 배경 복원)
```

---

## 하단 바 렌더링 분기

```
레이어 분리(tool === "extract") + 올가미 모드(extractMode === "lasso"):

  lassoCommittedRef.current === false:
    기존 드로잉 컨트롤 유지 (타입 선택 / 전체지우기 / 완료)

  lassoCommittedRef.current === true:
    ┌────────────────────────────────────────────────────┐
    │  [누끼 따기] [AI토글]  [복제]  [이동]  [다시 그리기]  │
    └────────────────────────────────────────────────────┘
    이동 모드 진입 후:
    ┌──────────────────────────────────────────────────────────┐
    │  드래그로 이동하세요  [확정] [취소]  [AI 복원 ON/OFF]  │
    └──────────────────────────────────────────────────────────┘
```

영역편집(`tool === "inpaint"`) 도 동일한 `lassoCommittedRef` 를 공유하므로  
이 분기는 `extractMode === "lasso"` 에만 적용.

---

## 재사용하는 기존 코드

| 기존 코드 | 재사용 방식 |
|-----------|------------|
| `lassoCommittedRef` | 액션 선택 모드 진입 트리거 |
| `lassoClientPtsRef` | 정점 좌표 → 픽셀 변환 소스 |
| `screenToSource()` | 정점 → 원본 픽셀 좌표 변환 |
| `handleExtractBrush()` | AI 누끼 경로 |
| `handleInpaintSubmit()` | AI 복원 경로 |
| `lassoOverlayRef` | 이동 모드 드래그 이벤트 수신 |
| `clearLassoState()` | 다시 그리기 / 취소 |

---

## 범위 밖 (이번 구현 제외)

- 영역편집(inpaint) 모드의 올가미 → 동일 액션 모드 추가 (후속)
- 이동 후 두 레이어(구멍 + 이동 픽셀) 자동 병합 (후속)
- 자기교차 폴리곤 처리 (기존 한계 그대로)
