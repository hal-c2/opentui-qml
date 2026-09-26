// Run by test/shell.test.ts in a subprocess: after destroy() the process must exit on its own
// (no fs.watch handle or debounce timer left behind).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { runShell } from "../../src/index.ts"

const dir = mkdtempSync(join(tmpdir(), "opentui-qml-shell-exit-"))
mkdirSync(join(dir, "config"))
writeFileSync(join(dir, "DefaultShell.qml"), `import OpenTUI\nWindow { Text { text: "exit test" } }\n`)
writeFileSync(join(dir, "config", "shell.qml"), `import OpenTUI\nWindow { Text { text: "user" } }\n`)
const t = await createTestRenderer({ width: 20, height: 3 })
const shell = await runShell({
  appId: "exit-test",
  defaultShell: join(dir, "DefaultShell.qml"),
  configDir: join(dir, "config"),
  renderer: t.renderer,
  watch: true,
})
// Trigger a pending (debounced) reload, then destroy before it fires.
writeFileSync(join(dir, "config", "shell.qml"), `import OpenTUI\nWindow { Text { text: "user 2" } }\n`)
await new Promise((r) => setTimeout(r, 20))
shell.destroy()
t.renderer.destroy()
rmSync(dir, { recursive: true, force: true })
console.log(`destroyed usingUserShell=${shell.usingUserShell}`)
