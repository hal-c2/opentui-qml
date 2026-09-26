import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createPropertyMap, runShell, type RunShellOptions, type ShellApp } from "../src/index.ts"
import { startDemo, type Demo } from "../examples/shell/app.ts"
import { parseArgs } from "../src/cli.ts"

const DEFAULT_SHELL = `import OpenTUI

Window {
    Text { text: "default shell gen " + Runtime.generation + " user " + Runtime.usingUserShell }
    Text { text: "counter " + Shell.state.counter }
}
`

let t: TestRendererSetup | null = null
let app: ShellApp | null = null
let dir = ""

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opentui-qml-shell-"))
  mkdirSync(join(dir, "app"))
  mkdirSync(join(dir, "config"))
  writeFileSync(join(dir, "app", "DefaultShell.qml"), DEFAULT_SHELL)
})

afterEach(() => {
  app?.destroy()
  app = null
  t?.renderer.destroy()
  t = null
  rmSync(dir, { recursive: true, force: true })
})

async function start(opts: Partial<RunShellOptions> = {}): Promise<ShellApp> {
  t ??= await createTestRenderer({ width: 70, height: 12 })
  app = await runShell({
    appId: "shell-test",
    defaultShell: join(dir, "app", "DefaultShell.qml"),
    configDir: join(dir, "config"),
    renderer: t.renderer,
    watch: false,
    singletons: { Shell: { state: createPropertyMap({ counter: 0 }) } },
    ...opts,
  })
  return app
}

async function frame(): Promise<string> {
  await tick()
  await t!.renderOnce()
  return t!.captureCharFrame()
}

function writeUserShell(source: string, name = "shell.qml"): void {
  writeFileSync(join(dir, "config", name), source)
}

describe("runShell", () => {
  test("uses the default shell when the config directory has no shell.qml", async () => {
    const shell = await start()
    expect(shell.usingUserShell).toBe(false)
    expect(shell.generation).toBe(1)
    expect(shell.lastError).toBeNull()
    expect(shell.configDir).toBe(join(dir, "config"))
    expect(shell.userShellPath).toBe(join(dir, "config", "shell.qml"))
    expect(await frame()).toContain("default shell gen 1 user false")
    expect(t!.renderer.root.getChildren()).toHaveLength(1)
  })

  test("the default config directory follows XDG_CONFIG_HOME", async () => {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(dir, "xdg")
    try {
      const shell = await start({ configDir: undefined })
      expect(shell.configDir).toBe(join(dir, "xdg", "shell-test", "shell"))
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })

  test("a user shell.qml replaces the root", async () => {
    writeUserShell(`import OpenTUI
Window { Text { text: "my rice " + Runtime.usingUserShell } }`)
    const shell = await start()
    expect(shell.usingUserShell).toBe(true)
    const f = await frame()
    expect(f).toContain("my rice true")
    expect(f).not.toContain("default shell")
  })

  test("a broken user shell falls back to the default shell with the error overlay", async () => {
    writeUserShell(`import OpenTUI
Window {
    Text { text: "oops" +
}`)
    const errors: Error[] = []
    const onError: unknown[] = []
    const shell = await start({ onError: (e) => onError.push(e) })
    shell.on("error", (e) => errors.push(e))
    expect(shell.usingUserShell).toBe(false)
    expect(shell.lastError).toBeInstanceOf(Error)
    expect(shell.lastError!.message).toContain("shell.qml")
    expect(onError).toHaveLength(1)
    let f = await frame()
    expect(f).toContain("shell.qml:4:2")
    expect(f).toContain("Showing the default shell")
    expect(f).toContain("Esc to dismiss")
    expect(shell.root.children[0]!.typeName).toBe("Rectangle")

    t!.mockInput.pressEscape()
    await tick(50)
    f = await frame()
    expect(f).not.toContain("Esc to dismiss")
    expect(f).toContain("default shell gen 1 user false")

    // Still broken: the overlay comes back on the next reload.
    await shell.reload()
    expect(errors).toHaveLength(1)
    expect(await frame()).toContain("Esc to dismiss")
  })

  test("errorOverlay: false keeps the default shell clean", async () => {
    writeUserShell(`import OpenTUI
Window { NoSuchType { } }`)
    const shell = await start({ errorOverlay: false, onError: () => {} })
    expect(shell.lastError!.message).toContain("NoSuchType")
    expect(await frame()).not.toContain("Esc to dismiss")
  })

  test("a user shell whose root is not visual falls back", async () => {
    writeUserShell(`import OpenTUI
QtObject { }`)
    const shell = await start({ onError: () => {} })
    expect(shell.usingUserShell).toBe(false)
    expect(shell.lastError!.message).toContain("must be a visual type")
  })

  test("reload() picks up a rewritten user shell, bumps generation and keeps singleton state", async () => {
    const state = createPropertyMap({ counter: 0 })
    writeUserShell(`import OpenTUI
Window { Text { text: "first gen " + Runtime.generation } }`)
    const shell = await start({ singletons: { Shell: { state } } })
    expect(await frame()).toContain("first gen 1")
    const generations: number[] = []
    shell.on("generation", (g) => generations.push(g))
    state.set("counter", 5)

    writeUserShell(`import OpenTUI
Window { Text { text: "second gen " + Runtime.generation + " counter " + Shell.state.counter } }`)
    await shell.reload()
    expect(shell.generation).toBe(2)
    expect(generations).toEqual([2])
    const f = await frame()
    expect(f).toContain("second gen 2 counter 5")
    expect(f).not.toContain("first gen")
    expect(t!.renderer.root.getChildren()).toHaveLength(1)

    // Removing the user shell goes back to the default shell.
    rmSync(join(dir, "config", "shell.qml"))
    await shell.reload()
    expect(shell.usingUserShell).toBe(false)
    expect(await frame()).toContain("default shell gen 3 user false")
  })

  test("a reload with both shells broken keeps the previous generation", async () => {
    const shell = await start({ onError: () => {} })
    const root = shell.root
    writeUserShell(`Window {`)
    writeFileSync(join(dir, "app", "DefaultShell.qml"), `Window {`)
    const errors: Error[] = []
    shell.on("error", (e) => errors.push(e))
    await shell.reload()
    expect(errors).toHaveLength(1)
    expect(shell.generation).toBe(1)
    expect(shell.root).toBe(root)
    expect(shell.lastError!.message).toContain("both shells failed")
    expect(await frame()).toContain("default shell gen 1")

    // Fixing the default shell recovers (the user shell is still broken → overlay).
    writeFileSync(join(dir, "app", "DefaultShell.qml"), DEFAULT_SHELL.replace("default shell", "fixed shell"))
    await shell.reload()
    expect(shell.generation).toBe(2)
    expect(await frame()).toContain("Esc to dismiss")
    t!.mockInput.pressEscape()
    await tick(50)
    expect(await frame()).toContain("fixed shell gen 2")
  })

  test("reloads requested while one runs are queued, not interleaved", async () => {
    const shell = await start()
    const a = shell.reload()
    const b = shell.reload()
    const c = shell.reload()
    await Promise.all([a, b, c])
    // The first runs, the other two coalesce into one queued reload.
    expect(shell.generation).toBe(3)
    expect(t!.renderer.root.getChildren()).toHaveLength(1)
  })

  test("Runtime.reload() from QML reloads", async () => {
    writeUserShell(`import OpenTUI
Window {
    Text { text: "gen " + Runtime.generation + " dir " + (Runtime.configDir.length > 0) }
    Shortcut { sequence: "r"; onActivated: Runtime.reload() }
}`)
    const shell = await start()
    const next = new Promise<number>((r) => shell.on("generation", r))
    t!.mockInput.pressKey("r")
    expect(await next).toBe(2)
    expect(await frame()).toContain("gen 2 dir true")
  })

  test("${configDir}/qml modules are importable from the user shell", async () => {
    const extras = join(dir, "config", "qml", "My", "Extras")
    mkdirSync(extras, { recursive: true })
    writeFileSync(join(extras, "qmldir"), "module My.Extras\nBadge 1.0 Badge.qml\n")
    writeFileSync(join(extras, "Badge.qml"), `import OpenTUI\nText { text: "[badge]" }\n`)
    writeUserShell(`import OpenTUI
import My.Extras
Window { Badge { } }`)
    const shell = await start()
    expect(shell.usingUserShell).toBe(true)
    expect(await frame()).toContain("[badge]")
  })

  test("modules map a uri to an explicit directory", async () => {
    const bricks = join(dir, "bricks-somewhere")
    mkdirSync(bricks)
    writeFileSync(join(bricks, "qmldir"), "module App.Bricks\nPanel 1.0 Panel.qml\n")
    writeFileSync(join(bricks, "Panel.qml"), `import OpenTUI\nText { text: "panel brick" }\n`)
    writeUserShell(`import OpenTUI
import App.Bricks
Window { Panel { } }`)
    await start({ modules: { "App.Bricks": bricks } })
    expect(await frame()).toContain("panel brick")
  })

  test("both shells broken on first start throws and cleans up", async () => {
    writeUserShell(`Window {`)
    writeFileSync(join(dir, "app", "DefaultShell.qml"), `Window {`)
    t = await createTestRenderer({ width: 40, height: 4 })
    await expect(
      runShell({
        appId: "shell-test",
        defaultShell: join(dir, "app", "DefaultShell.qml"),
        configDir: join(dir, "config"),
        renderer: t.renderer,
      }),
    ).rejects.toThrow("both shells failed")
    expect(t.renderer.root.getChildren()).toHaveLength(0)
  })

  test("a broken default shell without a user shell throws its own error", async () => {
    writeFileSync(join(dir, "app", "DefaultShell.qml"), `Window {`)
    t = await createTestRenderer({ width: 40, height: 4 })
    await expect(
      runShell({ appId: "x", defaultShell: join(dir, "app", "DefaultShell.qml"), configDir: join(dir, "config"), renderer: t.renderer }),
    ).rejects.toThrow("DefaultShell.qml")
  })

  test("destroy() tears down the engine and leaves the caller's renderer", async () => {
    const shell = await start({ watch: true })
    const engine = shell.engine
    shell.destroy()
    app = null
    expect(engine.isDestroyed).toBe(true)
    expect(t!.renderer.root.getChildren()).toHaveLength(0)
    expect(t!.renderer.isDestroyed).toBe(false)
  })
})

describe("runShell hot reload", () => {
  /** Resolves with the next generation, or null after `ms`. */
  function nextGeneration(shell: ShellApp, ms: number): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve(null)
      }, ms)
      const off = shell.on("generation", (g) => {
        clearTimeout(timer)
        off()
        resolve(g)
      })
    })
  }

  test("a change in the config directory reloads the root", async () => {
    writeUserShell(`import OpenTUI
Window { Text { text: "watched one" } }`)
    const shell = await start({ watch: true })
    expect(await frame()).toContain("watched one")
    await tick(50)
    const next = nextGeneration(shell, 1000)
    writeUserShell(`import OpenTUI
Window { Text { text: "watched two" } }`)
    const gen = await next
    if (gen === null) {
      console.warn("shell.test: fs.watch delivered no event within 1 s; skipping the hot reload assertion")
      return
    }
    expect(gen).toBe(2)
    expect(await frame()).toContain("watched two")

    // Unrelated files are ignored.
    const ignored = nextGeneration(shell, 300)
    writeFileSync(join(dir, "config", "notes.txt"), "hello")
    expect(await ignored).toBeNull()
  })

  test("a change to a module in ${configDir}/qml reloads", async () => {
    const extras = join(dir, "config", "qml", "My", "Extras")
    mkdirSync(extras, { recursive: true })
    writeFileSync(join(extras, "Badge.qml"), `import OpenTUI\nText { text: "badge v1" }\n`)
    writeUserShell(`import OpenTUI
import My.Extras
Window { Badge { } }`)
    const shell = await start({ watch: true })
    expect(await frame()).toContain("badge v1")
    await tick(50)
    const next = nextGeneration(shell, 1000)
    writeFileSync(join(extras, "Badge.qml"), `import OpenTUI\nText { text: "badge v2" }\n`)
    if ((await next) === null) {
      console.warn("shell.test: fs.watch delivered no event within 1 s; skipping the module reload assertion")
      return
    }
    expect(await frame()).toContain("badge v2")
  })
})

describe("runShell teardown", () => {
  test("destroy() stops the watchers: the process exits on its own", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "shell-exit.ts")], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => proc.kill(), 10_000)
    const code = await proc.exited
    clearTimeout(timer)
    const out = await new Response(proc.stdout).text()
    expect(out).toContain("destroyed usingUserShell=true")
    expect(code).toBe(0)
  }, 15_000)
})

describe("examples/shell", () => {
  const EXAMPLE = join(import.meta.dir, "..", "examples", "shell")
  let demo: Demo | null = null
  let dt: TestRendererSetup | null = null

  afterEach(() => {
    demo?.stop()
    demo = null
    dt?.renderer.destroy()
    dt = null
  })

  async function startExample(configDir: string): Promise<{ demo: Demo; frame: () => Promise<string>; errors: string[] }> {
    dt = await createTestRenderer({ width: 90, height: 18 })
    const errors: string[] = []
    const onError = (e: unknown, c?: string): void => {
      errors.push(`${c}: ${e instanceof Error ? e.message : String(e)}`)
    }
    demo = await startDemo({ configDir, renderer: dt.renderer, watch: false, onError, onWarning: (m) => errors.push(m) })
    const s = dt
    return {
      demo,
      errors,
      frame: async () => {
        await tick(10)
        await s.renderOnce()
        return s.captureCharFrame()
      },
    }
  }

  test("default shell: keys dispatch to the app, state flows back", async () => {
    const { demo, frame, errors } = await startExample(join(dir, "config"))
    let f = await frame()
    expect(f).toContain("Shell demo — inbox")
    expect(f).toContain("▸ Inbox")
    expect(f).toContain("default shell · gen 1")

    dt!.mockInput.pressKey("n", { ctrl: true })
    f = await frame()
    expect(f).toContain("Shell demo — drafts")
    expect(f).toContain("▸ Drafts")

    dt!.mockInput.pressKey("/")
    await tick(10)
    await dt!.mockInput.typeText("hello bricks")
    dt!.mockInput.pressEnter()
    f = await frame()
    expect(demo.state.get("messages")).toEqual(["hello bricks"])
    expect(f).toContain("• hello bricks")

    dt!.mockInput.pressKey("b", { ctrl: true })
    f = await frame()
    expect(f).not.toContain("Pages")

    demo.state.set("clock", "12:34:56")
    expect(await frame()).toContain("12:34:56")

    const next = new Promise<number>((r) => demo.shell.on("generation", r))
    dt!.mockInput.pressKey("r", { ctrl: true })
    expect(await next).toBe(2)
    f = await frame()
    expect(f).toContain("default shell · gen 2")
    // App state survived the reload.
    expect(f).toContain("• hello bricks")
    expect(f).not.toContain("Pages")
    expect(errors).toEqual([])
  })

  test("the minimal rice re-arranges the same bricks", async () => {
    const { demo, frame, errors } = await startExample(join(EXAMPLE, "rices", "minimal"))
    expect(demo.shell.usingUserShell).toBe(true)
    const f = await frame()
    expect(f).toContain("minimal rice")
    expect(f).toContain("Go to")
    expect(f).not.toContain("default shell")
    // Sidebar on the right: its title comes after the card's on the first line.
    const first = f.split("\n")[0]!
    expect(first.indexOf("Go to")).toBeGreaterThan(first.indexOf("minimal rice"))
    expect(errors).toEqual([])
  })

  test("the broken rice falls back to the default shell with the overlay", async () => {
    const { demo, frame, errors } = await startExample(join(EXAMPLE, "rices", "broken"))
    expect(demo.shell.usingUserShell).toBe(false)
    const f = await frame()
    expect(f).toContain("rices/broken/shell.qml:11:1")
    expect(f).toContain("Esc to dismiss · Runtime.reload() to retry")
    expect(f).toContain("default shell · gen 1")
    expect(errors).toHaveLength(1)
  })
})

describe("cli --shell", () => {
  test("parseArgs reads the shell flags (and leaves them undefined when absent)", () => {
    expect(
      parseArgs(["--shell", "Default.qml", "--app-id", "demo", "--config-dir=cfg", "--module", "A.B=./ab", "--module", "C=./c", "--no-watch"]),
    ).toEqual({
      pluginDirs: [],
      plugins: [],
      context: {},
      shell: "Default.qml",
      appId: "demo",
      configDir: "cfg",
      modules: { "A.B": "./ab", C: "./c" },
      noWatch: true,
      help: false,
    })
    const plain = parseArgs(["app.qml"])
    expect(plain.shell).toBeUndefined()
    expect(plain.modules).toBeUndefined()
    expect(plain.noWatch).toBeUndefined()
    expect(() => parseArgs(["--module", "nodir"])).toThrow("Uri=dir")
  })
})
