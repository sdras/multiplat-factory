import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { SqliteRunStore } from '../src/store/sqlite.ts'

describe('SqliteRunStore shared between processes', () => {
  it('opens a store another connection already holds, as the daemon and a CLI driver do', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mpf-store-')), 'mpf.sqlite')
    const first = new SqliteRunStore(file)
    // A second connection while the first is open: the WAL switch must not throw "database is locked".
    const second = new SqliteRunStore(file)
    expect(second.listRuns()).toEqual([])
    first.close()
    second.close()
  })
})
