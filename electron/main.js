// Game Art Studio Electron 셸 — launch.sh 의 오케스트레이션을 네이티브 창으로 옮긴 것.
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

// 패키징 시 userData(OS 표준 앱 데이터 폴더), 개발 시 프로젝트 내 data/
const DATA_DIR = app.isPackaged
  ? app.getPath("userData")
  : path.join(PROJECT_DIR, "data");

const STATE_FILE = path.join(DATA_DIR, "window-state.json");

// GUI 런처에서 실행되면 PATH 가 최소화되므로(node/pnpm/codex/claude 못 찾음)
// 도구 위치를 직접 넣는다. 이 PATH 는 spawn 한 Next 서버 → codex/claude 로 그대로 상속된다.
if (process.platform === "win32") {
  const home = process.env.USERPROFILE || process.env.HOMEPATH || "";
  process.env.PATH = [
    `${home}\\AppData\\Roaming\\npm`,
    `${home}\\AppData\\Local\\pnpm`,
    process.env.PATH || "",
  ].filter(Boolean).join(";");
} else {
  process.env.PATH = `/opt/homebrew/bin:${process.env.HOME}/.local/bin:/usr/bin:/usr/sbin:/bin:${process.env.PATH || ""}`;
}

app.setName("Game Art Studio");

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

const IS_WIN = process.platform === "win32";
// Windows에서 pnpm/codex 같은 CLI는 .cmd 래퍼를 통해 실행해야 한다.
const PNPM = IS_WIN ? "pnpm.cmd" : "pnpm";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: PROJECT_DIR, stdio: "ignore", shell: IS_WIN, windowsHide: true });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// 서버 기동 책임: 이미 떠 있으면 그대로 사용, 없으면 (필요 시 빌드 후) 우리가 띄운다.
async function ensureServer() {
  if (await isUp()) return; // 외부에서 이미 떠 있음 → 종료 책임 없음

  // 패키징된 앱: Resources/app/ 이 루트. 개발: 프로젝트 루트.
  const appRoot = app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : PROJECT_DIR;

  if (!app.isPackaged && !fs.existsSync(path.join(appRoot, ".next", "BUILD_ID"))) {
    await run(PNPM, ["build"]); // 프로덕션 빌드 최초 1회
  }

  fs.mkdirSync(path.join(DATA_DIR, "logs"), { recursive: true });
  const logPath = path.join(DATA_DIR, "logs", "app.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const spawnEnv = { ...process.env, IMAGEGEN_DATA_DIR: DATA_DIR, PORT: String(PORT) };

  if (app.isPackaged) {
    // 패키징 시 pnpm 없음 → node로 next 직접 실행
    // .bin/ 심볼릭 링크는 패키징 후 소실되므로 실제 경로 직접 지정
    const nextBin = path.join(appRoot, "node_modules", "next", "dist", "bin", "next");
    serverProc = spawn("node", [nextBin, "start", "-H", "127.0.0.1"], {
      cwd: appRoot,
      detached: true,
      shell: false,
      windowsHide: true,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc.stdout.pipe(logStream);
    serverProc.stderr.pipe(logStream);
    serverProc.on("error", (err) => logStream.write(`[spawn error] ${err.message}\n`));
    serverProc.on("exit", (code, sig) => logStream.write(`[exit] code=${code} signal=${sig}\n`));
  } else {
    // detached:true → 자체 프로세스 그룹. 종료 시 그룹 통째로 kill 해 next-server 까지 정리.
    serverProc = spawn(PNPM, ["start"], {
      cwd: appRoot,
      detached: true,
      shell: IS_WIN,
      windowsHide: true,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc.stdout.pipe(logStream);
    serverProc.stderr.pipe(logStream);
    serverProc.on("error", (err) => logStream.write(`[spawn error] ${err.message}\n`));
    serverProc.on("exit", (code, sig) => logStream.write(`[exit] code=${code} signal=${sig}\n`));
  }

  if (!(await waitForServer())) throw new Error("Next 서버가 시간 내에 응답하지 않음");
}

function stopServer() {
  const { execSync } = require("node:child_process");
  if (serverProc) {
    if (IS_WIN) {
      // Windows: taskkill /T 로 자식 프로세스 트리 전체 종료
      try {
        execSync(`taskkill /pid ${serverProc.pid} /T /F`, { stdio: "ignore" });
      } catch {
        /* 이미 종료됨 */
      }
    } else {
      try {
        process.kill(-serverProc.pid, "SIGTERM"); // 프로세스 그룹 종료
      } catch {
        try {
          serverProc.kill("SIGTERM");
        } catch {
          /* 이미 종료됨 */
        }
      }
    }
    serverProc = null;
  }
  // 포트로 직접 정리 (pnpm이 next-server를 별도 그룹으로 띄운 경우 대비)
  if (IS_WIN) {
    try {
      const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
      const pids = [...new Set(out.trim().split("\n").map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))];
      for (const pid of pids) {
        try { execSync(`taskkill /pid ${pid} /F`, { stdio: "ignore" }); } catch { /* 무시 */ }
      }
    } catch {
      /* 포트 미점유 */
    }
  } else {
    try {
      execSync(`lsof -t -i:${PORT} | xargs kill -9`, { stdio: "ignore" });
    } catch {
      /* 이미 종료됐거나 포트 미점유 */
    }
  }
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
    title: "Game Art Studio",
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
  shell.openPath(path.join(DATA_DIR, "images"));
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
