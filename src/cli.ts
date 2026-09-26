#!/usr/bin/env bun
/**
 * opentui-qml <file.qml> [--plugins dir]... [--plugin file.qml]... [--context key=value]... [--keymap file.json]
 *             [-I dir]...
 * opentui-qml --shell <DefaultShell.qml> --app-id <id> [--config-dir dir] [--module Uri=dir]... [--no-watch]
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { QmlSyntaxError } from "./parser/ast.ts"
import { runQml, runShell, type RunQmlOptions } from "./index.ts"

const USAGE = `Usage: opentui-qml <file.qml> [options]
       opentui-qml --shell <DefaultShell.qml> --app-id <id> [options]

Options:
  --plugins <dir>        Load every QML plugin (root type Plugin) in <dir>. Repeatable.
  --plugin <file.qml>    Load a single QML plugin file. Repeatable.
  --context key=value    Expose \`key\` to QML (value parsed as JSON when possible). Repeatable.
  --keymap <file.json>   Merge key bindings into the app's Keymaps.
  -I, --import-path <dir>
                         Search <dir> for \`import A.B.C\` modules (as <dir>/A/B/C). Repeatable;
                         the file's directory is always searched last.

Shell host (a user shell.qml in the config directory replaces the root, see docs/SHELL.md):
  --shell <file.qml>     Run <file.qml> as the default shell.
  --app-id <id>          Config directory $XDG_CONFIG_HOME/<id>/shell (default id: opentui-qml).
  --config-dir <dir>     Use <dir> as the config directory (its shell.qml, its qml/ modules).
  --module Uri=dir       Register module Uri from <dir>. Repeatable.
  --no-watch             Don't hot-reload on file changes.
  -h, --help             Show this help.
`

interface CliArgs {
  file?: string
  pluginDirs: string[]
  plugins: string[]
  context: Record<string, unknown>
  keymapFile?: string
  /** `-I` / `--import-path` directories (undefined when none were given). */
  importPaths?: string[]
  /** `--shell`: run this file as the default shell of a shell host. */
  shell?: string
  appId?: string
  configDir?: string
  /** `--module Uri=dir` entries. */
  modules?: Record<string, string>
  /** `--no-watch` (true) */
  noWatch?: boolean
  help: boolean
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { pluginDirs: [], plugins: [], context: {}, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined
    const take = (): string => {
      if (inline !== undefined) return inline
      const v = value(i, flag)
      i++
      return v
    }
    switch (flag) {
      case "-h":
      case "--help":
        args.help = true
        break
      case "--plugins":
      case "--plugin-dir":
        args.pluginDirs.push(take())
        break
      case "--plugin":
        args.plugins.push(take())
        break
      case "--context": {
        const pair = take()
        const at = pair.indexOf("=")
        if (at <= 0) throw new UsageError(`--context expects key=value, got "${pair}"`)
        args.context[pair.slice(0, at)] = parseValue(pair.slice(at + 1))
        break
      }
      case "--keymap":
        args.keymapFile = take()
        break
      case "-I":
      case "--import-path":
        ;(args.importPaths ??= []).push(take())
        break
      case "--shell":
        args.shell = take()
        break
      case "--app-id":
        args.appId = take()
        break
      case "--config-dir":
        args.configDir = take()
        break
      case "--module": {
        const pair = take()
        const at = pair.indexOf("=")
        if (at <= 0 || at === pair.length - 1) throw new UsageError(`--module expects Uri=dir, got "${pair}"`)
        ;(args.modules ??= {})[pair.slice(0, at)] = pair.slice(at + 1)
        break
      }
      case "--no-watch":
        args.noWatch = true
        break
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`)
        if (args.file) throw new UsageError(`unexpected argument "${arg}"`)
        args.file = arg
    }
  }
  return args
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function describeError(err: unknown): string {
  if (err instanceof QmlSyntaxError) return `syntax error: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`opentui-qml: ${describeError(err)}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.shell && args.file) {
    process.stderr.write(`opentui-qml: pass either a file or --shell, not both\n\n${USAGE}`)
    return 2
  }
  if (!args.file && !args.shell) {
    process.stderr.write(USAGE)
    return 2
  }
  const file = resolve((args.file ?? args.shell)!)
  if (!existsSync(file) || !statSync(file).isFile()) {
    process.stderr.write(`opentui-qml: file not found: ${args.file ?? args.shell}\n`)
    return 1
  }
  for (const dir of args.pluginDirs) {
    if (!existsSync(dir)) process.stderr.write(`opentui-qml: warning: plugin directory not found: ${dir}\n`)
  }

  const options: RunQmlOptions = {
    context: args.context,
    plugins: args.plugins,
    pluginDirs: args.pluginDirs.filter((d) => existsSync(d)),
    importPaths: args.importPaths,
  }
  if (args.keymapFile) {
    try {
      options.keymap = JSON.parse(readFileSync(resolve(args.keymapFile), "utf8")) as Record<string, unknown>
    } catch (err) {
      process.stderr.write(`opentui-qml: cannot read keymap "${args.keymapFile}": ${describeError(err)}\n`)
      return 1
    }
  }

  try {
    // runQml destroys the renderer it created if loading fails, so the terminal is restored
    // before we print.
    if (args.shell) {
      await runShell({
        ...options,
        appId: args.appId ?? "opentui-qml",
        defaultShell: file,
        configDir: args.configDir,
        modules: args.modules,
        watch: !args.noWatch,
      })
    } else await runQml(file, options)
    return 0
  } catch (err) {
    process.stderr.write(`opentui-qml: ${describeError(err)}\n`)
    return 1
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  if (code !== 0) process.exitCode = code
}
