// SpriteForge Electron 셸 — launch.sh 의 오케스트레이션을 네이티브 창으로 옮긴 것.
// Next 프로덕션 서버를 시스템 node 자식 프로세스로 띄우고(=네이티브 모듈 재빌드 불필요),
// 포트가 열리면 BrowserWindow 로 전환한다. 우리가 띄운 서버는 종료 시 함께 정리한다.
const { app, BrowserWindow, ipcMain, Menu, shell, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PROJECT_DIR = path.resolve(__dirname, "..");
const PORT = 3000;
const URL = `http://127.0.0.1:${PORT}`;
const STATE_FILE = path.join(PROJECT_DIR, "data", "window-state.json");

// Finder 의 .app 에서 실행되면 PATH 가 최소화되므로(node/pnpm/codex/claude 못 찾음)
// 도구 위치를 직접 넣는다. 이 PATH 는 spawn 한 Next 서버 → codex/claude 로 그대로 상속된다.
process.env.PATH = `/opt/homebrew/bin:${process.env.HOME}/.local/bin:/usr/bin:/usr/sbin:/bin:${process.env.PATH || ""}`;

app.setName("Sprite Forge");

let win = null;
let serverProc = null; // 우리가 띄운 서버(이미 떠 있으면 null → 건드리지 않음)

function isUp() {
  return new Promise((resolve) => {
    const req = http.get(URL, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    await wait(500);
  }
  return false;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: PROJECT_DIR, stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// 서버 기동 책임: 이미 떠 있으면 그대로 사용, 없으면 (필요 시 빌드 후) 우리가 띄운다.
async function ensureServer() {
  if (await isUp()) return; // 외부에서 이미 떠 있음 → 종료 책임 없음
  if (!fs.existsSync(path.join(PROJECT_DIR, ".next", "BUILD_ID"))) {
    await run("pnpm", ["build"]); // 프로덕션 빌드 최초 1회
  }
  fs.mkdirSync(path.join(PROJECT_DIR, "data", "logs"), { recursive: true });
  const log = fs.openSync(path.join(PROJECT_DIR, "data", "logs", "app.log"), "a");
  // detached:true → 자체 프로세스 그룹. 종료 시 그룹 통째로 kill 해 next-server 까지 정리.
  serverProc = spawn("pnpm", ["start"], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ["ignore", log, log],
  });
  serverProc.unref();
  if (!(await waitForServer())) throw new Error("Next 서버가 시간 내에 응답하지 않음");
}

function stopServer() {
  if (!serverProc) return;
  try {
    process.kill(-serverProc.pid, "SIGTERM"); // 프로세스 그룹 종료
  } catch {
    try {
      serverProc.kill("SIGTERM");
    } catch {
      /* 이미 종료됨 */
    }
  }
  serverProc = null;
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* 첫 실행 */
  }
  return { width: 1280, height: 860 };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(b));
  } catch {
    /* 무시 */
  }
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    ...state,
    minWidth: 960,
    minHeight: 640,
    title: "Sprite Forge",
    // 표준 macOS 타이틀바 — 트래픽 라이트가 네이티브 바에 위치해 어떤 페이지/풀스크린 모달과도
    // 겹치지 않는다(hiddenInset 은 콘텐츠 위에 오버레이돼 fixed inset-0 패널과 충돌). 드래그도 기본 지원.
    titleBarStyle: "default",
    backgroundColor: "#0b0b0c",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "splash.html"));
  win.once("ready-to-show", () => win.show());

  // 외부 링크는 시스템 브라우저로.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.on("close", saveWindowState);
  win.on("closed", () => {
    win = null;
  });
}

function buildMenu() {
  const template = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("open-images-folder", () => {
  shell.openPath(path.join(PROJECT_DIR, "data", "images"));
});

app.whenReady().then(async () => {
  buildMenu();
  createWindow();
  try {
    await ensureServer();
    if (win) await win.loadURL(URL);
  } catch (err) {
    if (win) {
      await win.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            `<body style="background:#0b0b0c;color:#eee;font:14px -apple-system;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div>서버 기동 실패: ${String(err.message)}</div></body>`
          )
      );
    }
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 창을 닫으면(= 마지막 창) 앱 종료 → 우리가 띄운 서버 정리.
app.on("window-all-closed", () => app.quit());
app.on("before-quit", stopServer);
app.on("will-quit", stopServer);
