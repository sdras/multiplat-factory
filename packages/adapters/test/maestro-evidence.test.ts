import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TestCase } from '@mpf/core'
import {
  MAESTRO_DEBUG_DIR,
  attachFlowEvidence,
  collectFlowEvidence,
  findNamedScreenshot,
  summarizeHierarchy,
} from '../src/target/maestro-evidence.ts'

/** Trimmed from a real Maestro dump: an edge-to-edge header under the status bar. */
const HIERARCHY = JSON.stringify({
  attributes: { 'resource-id': '', text: '', bounds: '[0,0][1080,2400]' },
  children: [
    {
      attributes: { 'resource-id': 'android:id/content', bounds: '[0,0][1080,2400]' },
      children: [
        {
          attributes: { 'resource-id': 'mpf-root', bounds: '[0,0][1080,2400]' },
          children: [
            {
              attributes: {
                'resource-id': 'app-title',
                text: 'Counter',
                bounds: '[63,83][334,170]',
              },
            },
            {
              attributes: {
                'resource-id': 'nav-settings',
                text: 'Settings',
                bounds: '[818,64][1017,190]',
                clickable: 'true',
              },
            },
            {
              attributes: { 'resource-id': 'screen-counter', bounds: '[63,204][1017,632]' },
              children: [
                {
                  attributes: {
                    'resource-id': 'count-value',
                    text: '0',
                    bounds: '[63,204][1017,401]',
                  },
                },
                {
                  attributes: {
                    'resource-id': 'increment',
                    bounds: '[416,507][597,633]',
                    clickable: 'true',
                  },
                  children: [{ attributes: { text: '+1', bounds: '[479,541][534,598]' } }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      attributes: {
        'resource-id': 'com.android.systemui:id/status_bar_container',
        bounds: '[0,0][1080,136]',
      },
      children: [
        {
          attributes: {
            'resource-id': 'com.android.systemui:id/status_bar',
            bounds: '[0,0][1080,136]',
          },
          children: [
            {
              attributes: {
                'resource-id': 'com.android.systemui:id/clock',
                text: '9:51',
                bounds: '[47,1][230,136]',
              },
            },
          ],
        },
      ],
    },
  ],
})

/**
 * Trimmed from the observe run where a "Digital Wellbeing isn't responding" dialog sat over the
 * emulator: UiAutomator reported only the status bar and the dialog, not the app under it.
 */
const ANR_HIERARCHY = JSON.stringify({
  attributes: {},
  children: [
    {
      attributes: {},
      children: [
        {
          attributes: {
            'resource-id': 'com.android.systemui:id/status_bar_container',
            bounds: '[0,0][1080,136]',
          },
          children: [
            {
              attributes: {
                'resource-id': 'com.android.systemui:id/status_bar',
                bounds: '[0,0][1080,136]',
              },
              children: [
                {
                  attributes: {
                    'resource-id': 'com.android.systemui:id/clock',
                    text: '8:46',
                    bounds: '[47,47][151,90]',
                  },
                },
              ],
            },
          ],
        },
        {
          attributes: { 'resource-id': 'android:id/content', bounds: '[70,1025][1010,1447]' },
          children: [
            {
              attributes: {
                'resource-id': 'android:id/parentPanel',
                bounds: '[70,1025][1010,1447]',
              },
              children: [
                {
                  attributes: {
                    'resource-id': 'android:id/topPanel',
                    bounds: '[70,1025][1010,1135]',
                  },
                  children: [
                    {
                      attributes: {
                        'resource-id': 'android:id/title_template',
                        bounds: '[70,1025][1010,1135]',
                      },
                      children: [
                        {
                          attributes: {
                            'resource-id': 'android:id/alertTitle',
                            text: "Digital Wellbeing isn't responding",
                            bounds: '[133,1072][947,1135]',
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  attributes: {
                    'resource-id': 'android:id/customPanel',
                    bounds: '[70,1135][1010,1447]',
                  },
                  children: [
                    {
                      attributes: {
                        'resource-id': 'android:id/custom',
                        bounds: '[70,1135][1010,1447]',
                      },
                      children: [
                        {
                          attributes: { bounds: '[70,1135][1010,1447]' },
                          children: [
                            {
                              attributes: {
                                'resource-id': 'android:id/aerr_close',
                                text: 'Close app',
                                clickable: 'true',
                                bounds: '[70,1174][1010,1300]',
                              },
                            },
                            {
                              attributes: {
                                'resource-id': 'android:id/aerr_wait',
                                text: 'Wait',
                                clickable: 'true',
                                bounds: '[70,1300][1010,1426]',
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
})

/** The "Open with" resolver that a scheme-only deep-link filter puts in front of every flow. */
const CHOOSER_HIERARCHY = JSON.stringify({
  attributes: {},
  children: [
    {
      attributes: { 'resource-id': 'android:id/content', bounds: '[0,1200][1080,2400]' },
      children: [
        {
          attributes: {
            'resource-id': 'com.android.intentresolver:id/title',
            text: 'Open with',
            bounds: '[48,1250][1032,1320]',
          },
        },
        {
          attributes: {
            'resource-id': 'com.android.intentresolver:id/button_once',
            text: 'Just once',
            clickable: 'true',
            bounds: '[48,2200][520,2320]',
          },
        },
        {
          attributes: {
            'resource-id': 'com.android.intentresolver:id/button_always',
            text: 'Always',
            clickable: 'true',
            bounds: '[560,2200][1032,2320]',
          },
        },
      ],
    },
  ],
})

/** The app's own AlertDialog uses the same framework ids; its wording is not a system dialog's. */
const APP_DIALOG_HIERARCHY = JSON.stringify({
  attributes: {},
  children: [
    {
      attributes: { 'resource-id': 'android:id/content', bounds: '[70,1025][1010,1447]' },
      children: [
        {
          attributes: {
            'resource-id': 'android:id/alertTitle',
            text: 'Discard changes?',
            bounds: '[133,1072][947,1135]',
          },
        },
        {
          attributes: {
            'resource-id': 'android:id/button2',
            text: 'Keep editing',
            clickable: 'true',
            bounds: '[70,1174][540,1300]',
          },
        },
        {
          attributes: {
            'resource-id': 'android:id/button1',
            text: 'Discard',
            clickable: 'true',
            bounds: '[540,1174][1010,1300]',
          },
        },
      ],
    },
  ],
})

describe('summarizeHierarchy', () => {
  it('opens with the system dialog that covers the app, naming its title and buttons', () => {
    const s = summarizeHierarchy(ANR_HIERARCHY)
    const lines = s.split('\n')
    expect(lines[0]).toBe(
      'A system dialog covers the app: "Digital Wellbeing isn\'t responding" (buttons: Close app, Wait)',
    )
    expect(lines[1]).toBe(
      'On screen (3 tagged or text nodes): #android:id/alertTitle "Digital Wellbeing isn\'t responding" [133,1072][947,1135]; #android:id/aerr_close "Close app" [70,1174][1010,1300] clickable; #android:id/aerr_wait "Wait" [70,1300][1010,1426] clickable',
    )
    expect(lines[2]).toContain(
      'System windows over the app: #com.android.systemui:id/status_bar_container [0,0][1080,136]; #com.android.systemui:id/status_bar [0,0][1080,136]',
    )
    expect(s).not.toContain('clock')
    expect(s).not.toContain('android:id/content')
    expect(s).not.toContain('nothing tagged')
  })

  it('names the "Open with" chooser and its buttons', () => {
    const s = summarizeHierarchy(CHOOSER_HIERARCHY)
    expect(s.split('\n')[0]).toBe(
      'A system dialog covers the app: "Open with" (buttons: Just once, Always)',
    )
  })

  it('does not mistake an app dialog built on the framework ids for a system dialog', () => {
    const s = summarizeHierarchy(APP_DIALOG_HIERARCHY)
    expect(s).not.toContain('A system dialog covers the app')
    expect(s.split('\n')[0]).toContain('#android:id/alertTitle "Discard changes?"')
    expect(s).toContain('#android:id/button1 "Discard" [540,1174][1010,1300] clickable')
  })

  it('lists app nodes with bounds and flags system windows over the app', () => {
    const s = summarizeHierarchy(HIERARCHY)
    expect(s).toContain('#nav-settings "Settings" [818,64][1017,190] clickable')
    expect(s).toContain('#count-value "0" [63,204][1017,401]')
    expect(s).toContain('"+1" [479,541][534,598]')
    expect(s).toContain(
      'System windows over the app: #com.android.systemui:id/status_bar_container [0,0][1080,136]; #com.android.systemui:id/status_bar [0,0][1080,136]',
    )
    expect(s).not.toContain('clock')
    expect(s).not.toContain('android:id/content')
    expect(s).not.toContain('A system dialog covers the app')
  })
})

describe('collectFlowEvidence', () => {
  it('finds the flow directory by name or behavior id and returns the screenshot, hierarchy, and a summary', () => {
    const ws = mkdtempSync(join(tmpdir(), 'mpf-evidence-'))
    const flow = join(
      ws,
      MAESTRO_DEBUG_DIR,
      'B-006 Nav links move between the Counter and Settings screens',
    )
    mkdirSync(join(flow, 'screen-hierarchy'), { recursive: true })
    mkdirSync(join(flow, 'screenshots'), { recursive: true })
    mkdirSync(join(flow, 'logs'), { recursive: true })
    writeFileSync(
      join(flow, 'screen-hierarchy', 'step-007-assertCondition-screen-settings.json'),
      HIERARCHY,
    )
    writeFileSync(join(flow, 'screenshots', 'screenshot-❌-1234-(B-006).png'), 'png')
    writeFileSync(
      join(flow, 'logs', 'maestro.log'),
      '09:52:05 [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Assertion is false: id: screen-settings is visible\n',
    )
    const byName = collectFlowEvidence(
      ws,
      'B-006 Nav links move between the Counter and Settings screens',
    )!
    expect(byName.files[0]).toMatch(/screenshots\/screenshot.*\.png$/)
    expect(byName.files[1]).toBe(
      'maestro-debug/B-006 Nav links move between the Counter and Settings screens/screen-hierarchy/step-007-assertCondition-screen-settings.json',
    )
    expect(byName.summary).toContain('Failing step: assertCondition-screen-settings.')
    expect(byName.summary).toContain('System windows over the app')
    expect(byName.summary).toContain(
      'Maestro: CommandFailed: Assertion is false: id: screen-settings is visible',
    )
    expect(collectFlowEvidence(ws, 'B-006')?.files).toEqual(byName.files)
    expect(collectFlowEvidence(ws, 'B-999')).toBeUndefined()

    const c: TestCase = {
      id: 'B-006',
      name: 'B-006 Nav links move between the Counter and Settings screens',
      behaviorId: 'B-006',
      status: 'fail',
      durationMs: 1,
      message: 'Assertion is false',
      artifacts: [],
    }
    attachFlowEvidence(ws, c)
    expect(c.evidence).toEqual(byName.files)
    expect(c.message).toContain('Assertion is false\nFailing step')
  })
})

describe('nested Maestro layout', () => {
  it('finds flow evidence and named screenshots under <pass>/.maestro/tests/<timestamp>/<flow>', () => {
    const ws = mkdtempSync(join(tmpdir(), 'mpf-evidence-nested-'))
    const flow = join(
      ws,
      MAESTRO_DEBUG_DIR,
      '2026-09-26T10-00-00-000Z',
      '.maestro',
      'tests',
      '2026-09-26_100001',
      'B-006 Nav links move between the Counter and Settings screens',
    )
    mkdirSync(join(flow, 'screen-hierarchy'), { recursive: true })
    mkdirSync(join(flow, 'takeScreenshot'), { recursive: true })
    writeFileSync(
      join(flow, 'screen-hierarchy', 'step-007-assertCondition-screen-settings.json'),
      HIERARCHY,
    )
    writeFileSync(join(flow, 'takeScreenshot', 'B-006.png'), 'png')
    const evidence = collectFlowEvidence(ws, 'B-006')!
    expect(
      evidence.files.some((f) => f.endsWith('step-007-assertCondition-screen-settings.json')),
    ).toBe(true)
    expect(evidence.summary).toContain('System windows over the app')
    expect(findNamedScreenshot(join(ws, MAESTRO_DEBUG_DIR), 'B-006')).toBe(
      join(flow, 'takeScreenshot', 'B-006.png'),
    )
    expect(findNamedScreenshot(join(ws, MAESTRO_DEBUG_DIR), 'B-999')).toBeUndefined()
  })
})
