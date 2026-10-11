import { describe, expect, it } from 'vitest'
import { decide, defaultPolicy, commandsOf } from '../src/permissions.ts'

const cwd = '/work/run1/workspace/ios'
const source = '/work/run1/source'

describe('worker permission policy', () => {
  const policy = {
    ...defaultPolicy(cwd, [source]),
    bashAllow: [/^xcodebuild\b/, /^xcodegen\b/, /^ls\b/],
  }

  it('allows writes inside the workspace and denies them elsewhere', () => {
    expect(decide(policy, 'Write', { file_path: `${cwd}/App/Main.swift` }).allow).toBe(true)
    expect(decide(policy, 'Edit', { file_path: `${source}/App.tsx` }).allow).toBe(false)
    expect(decide(policy, 'Write', { file_path: '/etc/hosts' }).allow).toBe(false)
  })

  it('allows reads in the workspace and the extra read roots only', () => {
    expect(decide(policy, 'Read', { file_path: `${source}/App.tsx` }).allow).toBe(true)
    expect(decide(policy, 'Read', { file_path: '/Users/someone/.ssh/id_rsa' }).allow).toBe(false)
    expect(decide(policy, 'Grep', { pattern: 'x' }).allow).toBe(true)
  })

  it('gates Bash by allowlist and by path escape', () => {
    expect(decide(policy, 'Bash', { command: 'xcodebuild -scheme App build' }).allow).toBe(true)
    expect(decide(policy, 'Bash', { command: 'rm -rf /' }).allow).toBe(false)
    expect(decide(policy, 'Bash', { command: 'ls /Users/someone/Documents' }).allow).toBe(false)
    expect(decide(policy, 'Bash', { command: `ls ${source}` }).allow).toBe(true)
    expect(decide(defaultPolicy(cwd), 'Bash', { command: 'ls' }).allow).toBe(false)
  })

  it('skips leading variable assignments but still scans their paths', () => {
    expect(decide(policy, 'Bash', { command: `S=${cwd}/scratch; ls $S` }).allow).toBe(true)
    expect(decide(policy, 'Bash', { command: 'FOO=1 ls' }).allow).toBe(true)
    expect(decide(policy, 'Bash', { command: 'S=/Users/someone/secret; ls $S' }).allow).toBe(false)
    expect(decide(policy, 'Bash', { command: 'S=x; rm -rf $S' }).allow).toBe(false)
  })

  it('judges every command in a for loop or a sequence, not just the first', () => {
    expect(
      decide(policy, 'Bash', { command: 'for f in a.swift b.swift; do ls $f; done' }).allow,
    ).toBe(true)
    expect(decide(policy, 'Bash', { command: 'for f in a b; do rm -rf $f; done' }).allow).toBe(
      false,
    )
    expect(decide(policy, 'Bash', { command: 'ls a; ls b' }).allow).toBe(true)
    expect(decide(policy, 'Bash', { command: 'ls a && rm -rf b' }).allow).toBe(false)
    expect(decide(policy, 'Bash', { command: 'ls a || rm -rf b' }).allow).toBe(false)
    expect(commandsOf('for f in x y; do ls $f; wc -l $f; done')).toEqual(['ls $f', 'wc -l $f'])
    expect(commandsOf('for f in vectors/*.json\ndo\n  ls $f\n  wc -l $f\ndone')).toEqual([
      'ls $f',
      'wc -l $f',
    ])
    expect(decide(policy, 'Bash', { command: 'ls a\nrm -rf b' }).allow).toBe(false)
    expect(decide(policy, 'Bash', { command: 'for f in a b\ndo\n  ls $f\ndone' }).allow).toBe(true)
    expect(commandsOf('ls | head -3')).toEqual(['ls | head -3'])
    // A command substitution in the list and `do` on its own line (a fix worker wrote exactly this).
    expect(commandsOf('for f in $(ls | sort)\ndo\n  echo "== $f"; wc -l $f\ndone')).toEqual([
      'echo "== $f"',
      'wc -l $f',
    ])
    // A loop after another statement is still a loop, not a command named `for`.
    expect(commandsOf('ls; for f in $(ls | sort); do cat $f; done').sort()).toEqual([
      'cat $f',
      'ls',
    ])
    expect(decide(policy, 'Bash', { command: 'ls; for f in a b; do rm -rf $f; done' }).allow).toBe(
      false,
    )
  })

  it('judges the command after a cd into the workspace, and refuses cd elsewhere', () => {
    expect(decide(policy, 'Bash', { command: `cd ${cwd} && xcodegen generate` }).allow).toBe(true)
    expect(decide(policy, 'Bash', { command: `cd "${cwd}/App"; ls` }).allow).toBe(true)
    expect(decide(policy, 'Bash', { command: `cd ${cwd} && rm -rf /` }).allow).toBe(false)
    expect(decide(policy, 'Bash', { command: 'cd /Users/someone && ls' }).allow).toBe(false)
    expect(decide(policy, 'Bash', { command: `cd ${cwd}/.. && ls` }).allow).toBe(false)
  })

  it('denies network and fan-out tools by default', () => {
    expect(decide(policy, 'WebFetch', { url: 'https://example.com' }).allow).toBe(false)
    expect(decide(policy, 'WebSearch', { query: 'x' }).allow).toBe(false)
    expect(decide(policy, 'Workflow', { script: 'x' }).allow).toBe(false)
    expect(decide(policy, 'Agent', { prompt: 'x' }).allow).toBe(false)
  })
})

describe('absolute path scanning in Bash commands', () => {
  const policy = {
    ...defaultPolicy('/work/ws', ['/work/source']),
    bashAllow: [/^curl\b/, /^grep\b/, /^cat\b/, /^node\b/],
  }
  it('ignores URLs, query strings, and regex fragments', () => {
    expect(
      decide(policy, 'Bash', { command: 'curl -s http://localhost:5199/?mpf_seed=%7B%7D' }),
    ).toEqual({ allow: true })
    expect(
      decide(policy, 'Bash', { command: "grep -c 'data-testid' src/main.ts | sed 's/x/y/g'" }),
    ).toEqual({ allow: true })
    expect(decide(policy, 'Bash', { command: 'node -e "console.log(/a/g)"' })).toEqual({
      allow: true,
    })
  })
  it('still denies real paths outside the workspace and source', () => {
    expect(decide(policy, 'Bash', { command: 'cat /Users/someone/.ssh/id_rsa' })).toMatchObject({
      allow: false,
    })
    expect(decide(policy, 'Bash', { command: 'cat /work/other/secret.txt' })).toMatchObject({
      allow: false,
    })
    expect(
      decide(policy, 'Bash', { command: 'cat /work/source/index.html /work/ws/src/main.ts' }),
    ).toEqual({ allow: true })
  })
})
