import { describe, expect, mock, test } from 'claude-code/testing'

import { PIN_INSTRUCTIONS } from './compact'

const SESSION = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

type Part = { text: string; color?: string; dimColor?: boolean }

function parts(node: any, inherited: Omit<Part, 'text'> = {}): Part[] {
  if (typeof node === 'string') return node ? [{ text: node, ...inherited }] : []
  if (!node || !Array.isArray(node.children)) return []
  const style =
    node.type === 'Text'
      ? { ...inherited, color: node.props?.color, dimColor: node.props?.dimColor }
      : inherited
  return node.children.flatMap((child: any) => parts(child, style))
}

/** Stands in for the engine: its footer labels and the usage op. */
function world(on: any, context: { tokens?: number; window: number; percent?: number }) {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits: [] } }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('ui.render', { component: 'SessionMode' }, (_$: any, e: any) => ({
    type: 'Text',
    props: { dimColor: true },
    children: [e.props.modes.join(' & ')],
  }))
}

async function label($: any, modes: string[] = []) {
  const mounted = await $.ui.mount({
    plugin: 'context-left',
    surface: 'terminal',
    component: 'SessionMode',
    props: { modes },
  })
  return async () => {
    const runs = parts(await mounted.drawn())
    const run = runs.find(part => part.text.includes('ctx:'))
    return { text: runs.map(part => part.text).join(''), colour: run?.color }
  }
}

describe('context left', () => {
  test('green below 50% used', async ($, on) => {
    world(on, { tokens: 40_000, window: 200_000, percent: 20 })
    const draw = await label($)
    await $.session.start(SESSION)
    const { text, colour } = await draw()
    expect(text).toContain('ctx: 40k/200k (20%)')
    expect(colour).toBe('success')
  })

  test('orange from 50% to 80% used', async ($, on) => {
    world(on, { tokens: 140_000, window: 200_000, percent: 70 })
    const draw = await label($)
    await $.session.start(SESSION)
    const { text, colour } = await draw()
    expect(text).toContain('ctx: 140k/200k (70%)')
    expect(colour).toBe('#ff8700')
  })

  test('red above 80% used, updated by a measurement', async ($, on) => {
    world(on, { tokens: 40_000, window: 200_000, percent: 20 })
    const draw = await label($)
    await $.session.start(SESSION)
    await $.session.measure({
      context: { tokens: 180_000, window: 200_000, percent: 90 },
      rateLimits: [],
      changed: ['context'],
    })
    const { text, colour } = await draw()
    expect(text).toContain('ctx: 180k/200k (90%)')
    expect(colour).toBe('error')
  })

  test('dim placeholder before the first response', async ($, on) => {
    world(on, { window: 200_000 })
    const draw = await label($)
    await $.session.start(SESSION)
    const { text, colour } = await draw()
    expect(text).toContain('ctx: –')
    expect(colour).toBeUndefined()
  })

  test('keeps the engine labels and separates them', async ($, on) => {
    world(on, { tokens: 40_000, window: 200_000, percent: 20 })
    const draw = await label($, ['plan mode'])
    await $.session.start(SESSION)
    expect((await draw()).text).toContain('plan mode · ctx: 40k/200k')
  })
})

describe('compaction trigger', () => {
  const ON = { compactEnabled: true, compactAtPercent: '60' }

  /** The engine's side: usage at a settable percent, and a record of each compaction. */
  function engine(on: any, state: { percent?: number; reject?: boolean }) {
    const compacts: any[] = []
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('session.usage', () => ({
      value: { startedAt: 0, context: { tokens: 1, window: 200_000, percent: state.percent }, rateLimits: [] },
    }))
    on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
    on('turn.complete', (_$: any, e: any) => ({ text: e.answer ?? '' }) as any)
    on('ui.log', () => ({ value: undefined }) as any)
    on('session.compact', (_$: any, e: any) => {
      compacts.push(e)
      if (state.reject) throw new Error('a turn is running')
      return { skip: 'test' }
    })
    return compacts
  }

  const ended = ($: any, extra: Record<string, unknown> = {}) =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra })
  const measured = ($: any, percent: number) =>
    $.session.measure({
      context: { tokens: 1, window: 200_000, percent },
      rateLimits: [],
      changed: ['context'],
    })

  test('compacts after the turn that crosses the threshold, with the pin', { options: ON }, async ($, on) => {
    const clock = mock.clock(on)
    const compacts = engine(on, { percent: 65 })
    await $.session.start(SESSION)
    await ended($)
    await clock.advance(1000)
    expect(compacts.length).toBe(1)
    expect(compacts[0].instructions).toBe(PIN_INSTRUCTIONS)
  })

  test('starts the compaction as the turn ends, before a queued turn can begin', { options: ON }, async ($, on) => {
    mock.clock(on)
    const compacts = engine(on, { percent: 65 })
    await $.session.start(SESSION)
    await ended($)
    expect(compacts.length).toBe(1)
  })

  test('below the threshold, nothing happens', { options: ON }, async ($, on) => {
    const clock = mock.clock(on)
    const compacts = engine(on, { percent: 59 })
    await $.session.start(SESSION)
    await ended($)
    await clock.advance(1000)
    expect(compacts.length).toBe(0)
  })

  test('off by default', async ($, on) => {
    const clock = mock.clock(on)
    const compacts = engine(on, { percent: 95 })
    await $.session.start(SESSION)
    await ended($)
    await clock.advance(1000)
    expect(compacts.length).toBe(0)
  })

  test('the threshold is a setting', { options: { compactEnabled: true, compactAtPercent: '80' } }, async ($, on) => {
    const clock = mock.clock(on)
    const compacts = engine(on, { percent: 70 })
    await $.session.start(SESSION)
    await ended($)
    await clock.advance(1000)
    expect(compacts.length).toBe(0)
  })

  test('an interrupted turn and a subagent turn do not trigger it', { options: ON }, async ($, on) => {
    const clock = mock.clock(on)
    const compacts = engine(on, { percent: 90 })
    await $.session.start(SESSION)
    await ended($, { reason: 'aborted', isAborted: true })
    await ended($, { agentId: 'a1' })
    await clock.advance(1000)
    expect(compacts.length).toBe(0)
  })

  test('once per crossing: the next turn waits until usage falls below the threshold', { options: ON }, async ($, on) => {
    const clock = mock.clock(on)
    const compacts = engine(on, { percent: 65 })
    await $.session.start(SESSION)
    await ended($)
    await clock.advance(1000)
    await ended($)
    await clock.advance(1000)
    expect(compacts.length).toBe(1)
    await measured($, 20)
    await measured($, 65)
    await ended($)
    await clock.advance(1000)
    expect(compacts.length).toBe(2)
  })

  test('a compaction the engine refuses is tried again at the next turn', { options: ON }, async ($, on) => {
    const clock = mock.clock(on)
    const state = { percent: 65, reject: true }
    const compacts = engine(on, state)
    await $.session.start(SESSION)
    await ended($)
    await clock.advance(1000)
    state.reject = false
    await ended($)
    await clock.advance(1000)
    expect(compacts.length).toBe(2)
  })
})
