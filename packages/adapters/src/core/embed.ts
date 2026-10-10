import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'pathe'
import { CORE_WASM_FILE } from '@mpf/core'
import type { CoreHandoff } from '../types.ts'

/** Files a target scaffold adds when it embeds the shared core. */
export interface CoreEmbed {
  /** Text files, workspace-relative. */
  files: Record<string, string>
  /** Workspace-relative destinations of the module copies. */
  wasmCopies: string[]
  /** Workspace-relative directories that receive a copy of every vector file. */
  vectorDirs: string[]
  /** Workspace-relative path of a newline-separated index of vector file names, if the host needs one. */
  vectorIndex?: string
}

/** Write the embed: text files, module copies, and vector copies (plus the optional index). */
export function writeCoreEmbed(workspace: string, core: CoreHandoff, embed: CoreEmbed): string[] {
  const written: string[] = []
  for (const [rel, content] of Object.entries(embed.files)) {
    const abs = join(workspace, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    written.push(rel)
  }
  for (const rel of embed.wasmCopies) {
    const abs = join(workspace, rel)
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(core.wasm, abs)
    written.push(rel)
  }
  const vectorFiles = existsSync(core.vectorsDir)
    ? readdirSync(core.vectorsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : []
  for (const dir of embed.vectorDirs) {
    mkdirSync(join(workspace, dir), { recursive: true })
    for (const f of vectorFiles) {
      copyFileSync(join(core.vectorsDir, f), join(workspace, dir, f))
      written.push(`${dir}/${f}`)
    }
  }
  if (embed.vectorIndex) {
    const abs = join(workspace, embed.vectorIndex)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${vectorFiles.join('\n')}\n`)
    written.push(embed.vectorIndex)
  }
  return written
}

export { CORE_WASM_FILE }

/**
 * Commands a core worker may run to execute the source app's pure logic and record golden
 * vectors with `executed` provenance: the platform's interpreter and, where no script can import
 * the app's files, the compiler for a throwaway harness plus the harness it built inside the
 * workspace. Never package managers, the app's own build, or a shell. Every pattern is anchored
 * at the start of the command and ends at whitespace or the end, so `swift-frontend` does not
 * ride on `swift`.
 */
export function logicRunnerAllow(platform: string): RegExp[] {
  switch (platform) {
    case 'web':
      return [/^node(?:\s|$)/, /^npx tsx(?:\s|$)/]
    case 'ios':
      return [
        /^swift(?:\s|$)/,
        /^xcrun swift(?:\s|$)/,
        // Pure Swift files plus a main.swift compile into a harness binary; the worker runs that
        // binary from the workspace (`./harness`, or under `.build/` when SwiftPM built it). The
        // last path segment carries no extension, so scripts (`./run.sh`) stay out.
        /^swiftc(?:\s|$)/,
        /^xcrun swiftc(?:\s|$)/,
        /^\.\/(?:[\w-][\w.-]*\/)*[\w-]+(?:\s|$)/,
        /^\.build\/(?:[\w-][\w.-]*\/)*[\w-]+(?:\s|$)/,
      ]
    case 'android':
      // `java -jar` and `java -cp` run the harness that kotlinc or javac produced.
      return [
        /^kotlinc(?:-jvm)?(?:\s|$)/,
        /^kotlin(?:\s|$)/,
        /^javac(?:\s|$)/,
        /^java(?:\s|$)/,
        /^jshell(?:\s|$)/,
      ]
    default:
      return []
  }
}
