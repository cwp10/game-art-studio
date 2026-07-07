# 씬 프리뷰어 구현 계약 (Phase 1)

## 목표
갤러리 이미지들을 레이어로 쌓아 게임 화면처럼 미리보고, PNG로 병합 내보내기.

---

## 경계면 계약

### POST /api/composite
```
Request:  { layers: [{generationId: string, opacity: number}], sessionId?: string, outputWidth?: number, outputHeight?: number }
Response: { generationId: string, imagePath: string, width: number, height: number }
```
- opacity: 0~100 (정수)
- outputWidth/outputHeight: 없으면 첫 레이어 크기 기준
- 결과 kind = 'composite', backend = 'direct'

### mergeImages (composite-layers.ts)
```typescript
export async function mergeImages(params: {
  layers: { imagePath: string; opacity: number }[]  // opacity 0~100
  outputWidth: number
  outputHeight: number
  outPath: string
}): Promise<{ width: number; height: number }>
```
- 각 레이어를 outputWidth×outputHeight로 contain-fit 리사이즈 후 투명 캔버스에 composite
- sharp({ create: { width, height, channels:4, background:{r:0,g:0,b:0,alpha:0} } }).composite([...]).png().toFile(outPath)
- blend: 'over', opacity: layer.opacity/100

### SceneComposer Props
```typescript
type Props = {
  seedGenerationId?: string    // 첫 레이어로 추가할 이미지 (옵션)
  sessionId: string | null     // 갤러리 에셋 피커용
  onClose: () => void
  onComposited?: (result: { generationId: string; width: number; height: number }) => void
}
```

---

## pipeline-engineer 담당

### 1. src/lib/image-backend/composite-layers.ts (신규)
```typescript
import sharp from "sharp"
import fs from "node:fs/promises"

export async function mergeImages(params: {
  layers: { imagePath: string; opacity: number }[]
  outputWidth: number
  outputHeight: number
  outPath: string
}): Promise<{ width: number; height: number }>
```
- sharp로 각 레이어를 outputWidth×outputHeight contain-fit 리사이즈 (fit:'inside', background투명)
- 최종 캔버스: `sharp({ create: { width:outputWidth, height:outputHeight, channels:4, background:{r:0,g:0,b:0,alpha:0} } })`
- composite 입력: `{ input: resizedBuffer, blend: 'over' }` — sharp의 opacity는 composite에서 직접 지원 안 됨. 
  opacity < 100인 경우 각 레이어 PNG 픽셀의 alpha를 sharp로 곱해서 처리 (linear multiply on alpha channel)

### 2. src/app/api/composite/route.ts (신규)
- POST 핸들러
- `resolveImagePath(gen.image_path)` 로 절대 경로 획득
- 출력: `imagePath(newId)` 저장, `createGeneration({ kind:'composite', backend:'direct', ... })`
- input_image_ids: layers의 generationId 배열 (JSON)
- params: { layers: [{generationId, opacity}], outputWidth, outputHeight }
- 썸네일은 lazy(/api/thumbnails/[id]) — 저장 안 함

### 3. src/lib/db/migrate.ts — migrateV7 추가
```typescript
// v7: 'composite' kind 추가
function migrateV7(db: Database.Database): void { ... }
```
- 기존 v1~v6 패턴 그대로: 테이블 재생성 방식
- CHECK(kind IN ('text2img','img2img','upscale','remove_bg','inpaint','spritesheet','mask','layer','layer_extract','external','reskin','resize','emote_sheet','tileset','normal_map','composite'))

### 4. src/lib/db/schema.sql
- kind CHECK에 'composite' 추가

### 5. src/types/db.ts
- GenerationKind 타입에 'composite' 추가

---

## fullstack-engineer 담당

### 1. src/components/editor/SceneComposer.tsx (신규)
레이아웃: LayerCanvas.tsx 패턴 (aside + header + scrollable body + footer)

```
aside
├── header: "씬 합성" + 해상도 select + X 버튼
├── body (overflow-y-auto):
│   ├── 프리뷰 영역: useZoomPan + CSS transform으로 레이어 스택 img 렌더
│   ├── 에셋 피커: listGenerations({sessionId}) → 썸네일 그리드
│   └── 레이어 패널: 선택된 레이어 목록 + 위아래 버튼 + opacity 슬라이더 + 제거 버튼
└── footer: [취소] [씬 병합 PNG]
```

**해상도 프리셋:**
```typescript
const PRESETS = [
  { label: "자유", w: 0, h: 0 },
  { label: "HD (1280×720)", w: 1280, h: 720 },
  { label: "Full HD (1920×1080)", w: 1920, h: 1080 },
  { label: "2K (2560×1440)", w: 2560, h: 1440 },
  { label: "모바일 (390×844)", w: 390, h: 844 },
]
```

**에셋 피커:**
- `listGenerations({ sessionId, limit: 50 })` 로 로드 (import from "@/lib/api/client")
- kind 필터 없음 (composite 제외 — 합성 결과를 또 합성하지 않도록)
- 썸네일: `/api/thumbnails/{generationId}` URL
- 클릭 시 레이어 목록에 추가

**레이어 패널 아이템:**
```
[썸네일 24x24] [prompt 텍스트 truncate] [위▲] [아래▽] [opacity 0-100] [X제거]
```

**병합 버튼 클릭:**
- POST /api/composite with layers + outputWidth/outputHeight
- 응답 generationId → onComposited 콜백

**import:**
```typescript
import { ZoomPanControls, useZoomPan } from "./useZoomPan"
import { listGenerations } from "@/lib/api/client"
```

### 2. src/components/chat/ChatLayout.tsx 수정
- `SceneComposer` import 추가
- 상태 추가: `const [sceneOpen, setSceneOpen] = useState<{ seedGenerationId?: string } | null>(null)`
- `const closeScene = useCallback(() => setSceneOpen(null), [])`
- `renderEditPanel()` 아래에 추가 (spriteGen 패턴 동일):
  ```tsx
  {sceneOpen && (
    <div className="fixed inset-y-0 right-0 z-40 w-1/2">
      <SceneComposer
        seedGenerationId={sceneOpen.seedGenerationId}
        sessionId={state.activeSessionId}
        onClose={closeScene}
        onComposited={(res) => {
          dispatch({
            type: "add_result_card",
            tempId: nanoid(),   // 임시 id — chatLayout 의 nanoid import 확인
            userText: "🎬 씬 합성",
            generationId: res.generationId,
            width: res.width,
            height: res.height,
            kind: "composite",
          });
          closeScene();
        }}
      />
    </div>
  )}
  ```

### 3. src/components/chat/ImageResultCard.tsx 수정
- Action 타입에 `"add_to_scene"` 추가
- 버튼 추가: "씬에 추가" (기존 "레이어 분리" 버튼 패턴)

### 4. ChatLayout.tsx — ImageResultCard onAction 핸들러
- `"add_to_scene"` 케이스: `setSceneOpen({ seedGenerationId: card.generationId })`

---

## 기존 패턴 레퍼런스

```typescript
// API route 패턴 (layers/route.ts)
import { createGeneration, getGeneration } from "@/lib/db/repo/generations"
import { newGenerationId } from "@/lib/util/ids"
import { IMAGES_DIR, ensureDataDirs, imagePath as imagePathFor, toRelative, resolveImagePath } from "@/lib/util/paths"

// DB kind 타입 위치: src/types/db.ts → GenerationKind
// 에셋 피커 API: listGenerations({ sessionId, limit }) in @/lib/api/client
// 썸네일 URL: /api/thumbnails/{id}
// 이미지 URL: /api/images/{id}
```

## 주의사항
- SpriteCanvas 건드리지 않음
- 드래그 배치(x,y 자유 배치) Phase 2 — 지금은 레이어 스택(순서+opacity)만
- 씬 저장/재편집 Phase 2 — flatten-only PNG
- add_result_card dispatch에서 nanoid import 필요한지 ChatLayout 확인 후 사용 (tempId는 `Date.now().toString()` 등으로도 가능)
