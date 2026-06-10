# 편집/레이어 캔버스 16:10 뷰박스 + 줌/팬 (CSS transform)

## 신규/변경 파일

- **신규** `src/components/editor/useZoomPan.tsx`
  - `useZoomPan()` 훅 (zoom/pan/panMode 상태 + zoomIn/zoomOut/setZoom/resetView/togglePanMode + 팬 포인터 핸들러). clamp 0.5~4, step 0.25.
  - `fitBox(availW, availH, imgW, imgH)` → `{viewW, viewH, fitScale, displayW, displayH}` (16:10 박스 + contain-fit).
  - `rectRatioPoint(e)` → getBoundingClientRect 비율 역산 포인터 매핑.
  - `<ZoomPanControls zp>` 우하단 오버레이 `[−] {zoom%} [+] [✋이동/✏️편집]` (lucide ZoomIn/ZoomOut/Hand/Pencil, 기존 토큰).
  - `.tsx` 인 이유: JSX 컨트롤 컴포넌트 포함.
- **변경** `src/components/editor/MaskCanvas.tsx`
  - import 추가 (3행).
  - scale/display 계산을 fitBox 기반 16:10 contain-fit 으로 교체 (구 ~127~129 → `const zp=useZoomPan(); const {viewW,viewH,fitScale,displayW,displayH}=fitBox(...); const scale=fitScale;`).
  - `pointerPos = rectRatioPoint` (구 ~213~216).
  - 캔버스 영역(구 ~291~330)을 viewport(viewW×viewH, overflow-hidden) > transform stack(displayW×displayH) > base/mask 캔버스 구조로 교체. panMode 분기 추가, `<ZoomPanControls>` 우하단.
- **변경** `src/components/editor/LayerCanvas.tsx`
  - import 추가 (4행).
  - cap/scale 계산을 fitBox 기반으로 교체 (구 ~164~167). `scale=fitScale`.
  - `pointerPos = rectRatioPoint` (구 ~274~277).
  - draw phase 캔버스 stack(구 ~487~517)만 viewport+transform 구조로 교체. **result phase 재합성 미리보기(recompRef)는 무변경** — 줌/팬 대상 아님.

## 16:10 박스 + contain-fit 산출식

```
viewW = floor(min(avail.w, avail.h * 16/10))
viewH = round(viewW * 10/16)
fitScale = min(viewW/imgW, viewH/imgH)   // 종횡비 유지, 레터박스 허용
displayW = round(imgW * fitScale); displayH = round(imgH * fitScale)
```
- 박스는 `mx-auto` 로 가용영역 중앙. 이미지는 stack 의 `translate(-50%,-50%)` 로 박스 중앙.
- 기존 width-only(Mask) / cap·max변(Layer) scale 을 이 contain 식으로 통일.

## 줌/팬 transform 구조

```
<div viewport {width:viewW,height:viewH, overflow:hidden, position:relative, bg-bg-app}>
  <div stack {width:displayW,height:displayH, position:absolute, left/top:50%,
       transform: translate(-50%,-50%) translate(pan.x,pan.y) scale(zoom),
       transformOrigin:center}>
     <canvas base bg-bg-card/> <canvas mask/>
  </div>
  <ZoomPanControls/>   // stack 밖 → 줌에 안 딸려감
  {busy && overlay}    // Mask 만, stack 밖
</div>
```
- 레터박스 영역은 viewport 의 `bg-bg-app`, 이미지 영역은 base 캔버스 `bg-bg-card` 로 구분.

## 포인터 rect-ratio 매핑

```
rect = canvasEl.getBoundingClientRect();   // transform(zoom/pan) 반영됨
x = (clientX - rect.left) * (canvasEl.width / rect.width);
y = (clientY - rect.top)  * (canvasEl.height / rect.height);
```
- `canvasEl.width` = displayW (내부 픽셀, transform 무관). rect.width = 화면 실측(zoom 곱해짐). 비율로 역산 → zoom/pan 무관하게 display-px 정확.

## export 무변경 근거

- export 는 `inv = 1/scale` 로 display-px → 원본해상도 복원. `scale` 을 `fitScale` 로 통일했을 뿐 수식·흐름은 동일 (MaskCanvas exportMaskDataUrl, LayerCanvas buildColorMask).
- stroke 좌표는 rect-ratio 매핑이 항상 display-px 로 정규화 → CSS transform 은 시각 변환일 뿐 stroke 값·캔버스 내부 픽셀을 안 바꿈. 따라서 줌 상태에서 그려도 export 좌표 정확.
- 마스크/레이어 제출 args shape, onSubmit 시그니처, 브러시/색칠/지우개/undo 로직 무변경.

## 회귀 체크 (zoom=1, pan=0 기본 상태)

- fitScale 은 박스 안 contain 비율 — 기존 Mask 의 width-only scale, Layer 의 cap scale 과 동일 다운스케일 계열(레터박스 차이만). 16:10 박스가 가용폭보다 좁아질 수 있어 동일 픽셀은 아니나, export 가 fitScale 역산이라 원본 해상도 매핑은 정확.
- LayerCanvas avail 측정은 mount 1회(기존과 동일), MaskCanvas 는 strokes>0 freeze 가드 유지 → 좌표 정합성 보존.
- result phase(Layer) recomp 미리보기 무변경.

## 경계면 영향

- **순수 클라이언트 캔버스 변경.** API/MCP/DB/SSE shape 무변경. lib/api/client.ts 무변경. onSubmit args(maskDataUrl/prompt/resizeTarget/removeBg, layers[]) 무변경 → ImageResultCard·chat-state·layers/upload 라우트 영향 없음.
- 새 npm 의존 없음 (lucide-react 기존).

## visual-qa 포인트

1. **줌 상태 그리기 → export 좌표 정확도(핵심):** zoom>1 + pan 이동 후 이미지 특정 지점을 brush, 제출 → 마스크/레이어 PNG 에서 그 지점이 원본해상도 정위치에 찍히는지. zoom=1 결과와 동일 좌표여야 함.
2. 편집/레이어 진입 시 16:10 박스 표시 + 레터박스(bg-bg-app) 확인.
3. `[+]`/`[−]` 줌, `100%` 클릭 리셋, `✋이동`↔`✏️편집` 토글. 이동 모드 드래그 = 팬(그리기 안 됨, cursor grab), 편집 모드 = 그리기(crosshair).
4. 컨트롤이 줌에 딸려가지 않고 우하단 고정. busy 오버레이 정상.
5. LayerCanvas: 4색 다중 stroke + z-order + crop/inpaint export 가 줌 무관하게 정확. result phase 재합성 미리보기 정상(줌 없음).
6. 게이트: `npx tsc --noEmit` ✓, `pnpm lint` ✓, `pnpm build` ✓ (이미 통과).
