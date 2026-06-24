import { copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:os";

// gif.worker.js 복사 (크로스 플랫폼)
copyFileSync(
  "node_modules/gif.js/dist/gif.worker.js",
  "public/gif.worker.js"
);

// macOS 전용: Electron.app 표시 이름 설정
if (platform() === "darwin") {
  const plist = "node_modules/electron/dist/Electron.app/Contents/Info.plist";
  const pb = "/usr/libexec/PlistBuddy";
  try {
    execSync(`${pb} -c 'Set :CFBundleName Game Art Studio' ${plist}`, { stdio: "ignore" });
    execSync(`${pb} -c 'Set :CFBundleDisplayName Game Art Studio' ${plist}`, { stdio: "ignore" });
  } catch {
    // Electron.app이 없는 환경(CI 등)에서는 무시
  }
}
