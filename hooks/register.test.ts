import { describe, expect, test } from 'claude-code/testing'

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
