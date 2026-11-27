import { describe, expect, test } from 'claude-code/testing'

import {
  clearResults,
  CLEARED,
  handleCompact,
  judge,
  jevBody,
  lastRequest,
  pickCandidates,
  readDrops,
  PIN_INSTRUCTIONS,
  readSettings,
  shouldFire,
} from './compact'

const BIG = 'x'.repeat(2500)
const TIMEOUT = 5000

let n = 0
const ask = (text: string) => ({ role: 'user', text, toolUses: [], handle: `h${n++}` }) as any
const call = (id: string, tool = 'Read') =>
  ({
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: id, tool, input: {} }],
    handle: `h${n++}`,
  }) as any
const back = (id: string, text = BIG, isError = false) =>
  ({
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: id, text, isError }],
    handle: `h${n++}`,
  }) as any

const SETTINGS = readSettings({ compactEnabled: true, typesafeApiKey: 'k' })

/** Answers Jev's questions: `noul` per result index. */
const answer = (noul: number[]) =>
  JSON.stringify({
    answers: Object.fromEntries(noul.map((p, i) => [`r${i}`, { noul: p, confidence: 0.9 }])),
  })

type Reply = { ok: boolean; status: number; text: string } | 'throw' | 'hang'

/** A fake network: replies in order; `hang` never answers, as a timeout needs. */
function net(replies: Reply[]) {
  const sent: string[] = []
  let hanging = false
  return {
    sent,
    log: () => {},
    // The timeout fires only while a request hangs; backoff sleeps return at once.
    sleep: (ms: number) => (ms === TIMEOUT && !hanging ? new Promise(() => {}) : Promise.resolve()),
    fetch: async (_url: string, init: { body: string }) => {
      sent.push(init.body)
      const next = replies.shift() ?? { ok: false, status: 500, text: '' }
      hanging = next === 'hang'
      if (next === 'throw') throw new Error('down')
      if (next === 'hang') return new Promise<never>(() => {})
      return next
    },
  }
}
const ok = (text: string): Reply => ({ ok: true, status: 200, text })
const status = (code: number): Reply => ({ ok: false, status: code, text: '' })

describe('settings', () => {
  test('off by default, 60% trigger, 0.8 confidence, newest three kept', () => {
    const s = readSettings({})
    expect(s.enabled).toBe(false)
    expect(s.atPercent).toBe(60)
    expect(s.dropConfidence).toBe(0.8)
    expect(s.keepRecent).toBe(3)
  })
})

describe('settings from the config menu', () => {
  test('pickers store text, which is read as numbers', () => {
    const s = readSettings({
      compactAtPercent: '80',
      keepRecentToolResults: '5',
      dropConfidence: '0.9',
      jevTimeoutMs: '10000',
    })
    expect(s.atPercent).toBe(80)
    expect(s.keepRecent).toBe(5)
    expect(s.dropConfidence).toBe(0.9)
    expect(s.jevTimeoutMs).toBe(10000)
  })

  test('text that is not a number falls back to the default', () => {
    expect(readSettings({ compactAtPercent: 'soon' }).atPercent).toBe(60)
  })

  test('reset to defaults ignores the values but keeps the key and the switch', () => {
    const s = readSettings({
      resetToDefaults: true,
      compactEnabled: true,
      typesafeApiKey: 'k',
      compactAtPercent: '80',
      dropConfidence: '0.9',
    })
    expect(s.enabled).toBe(true)
    expect(s.apiKey).toBe('k')
    expect(s.atPercent).toBe(60)
    expect(s.dropConfidence).toBe(0.8)
  })
})

describe('trigger', () => {
  test('fires only when enabled, at or above the threshold, and armed', () => {
    expect(shouldFire(SETTINGS, 60, true)).toBe(true)
    expect(shouldFire(SETTINGS, 59, true)).toBe(false)
    expect(shouldFire(SETTINGS, 80, false)).toBe(false)
    expect(shouldFire(readSettings({}), 90, true)).toBe(false)
  })
})

describe('candidates', () => {
  test('skips the newest results, errors and short outputs', () => {
    const messages = [
      ask('fix the bug'),
      call('a'), back('a'),
      call('b'), back('b', BIG, true),
      call('c'), back('c', 'short'),
      call('d'), back('d'),
      call('e'), back('e'),
      call('f'), back('f'),
    ]
    const ids = pickCandidates(messages, 3).map((c: { id: string }) => c.id)
    expect(ids).toEqual(['a'])
  })

  test('names the tool and cuts the excerpt', () => {
    const messages = [ask('go'), call('a', 'Grep'), back('a'), call('b'), back('b'), call('c'), back('c'), call('d'), back('d')]
    const [first] = pickCandidates(messages, 3)
    expect(first?.tool).toBe('Grep')
    expect(first?.excerpt.length).toBe(1500)
  })
})

describe('Jev answers', () => {
  const candidates = [
    { id: 'a', tool: 'Read', excerpt: 'x' },
    { id: 'b', tool: 'Read', excerpt: 'x' },
    { id: 'c', tool: 'Read', excerpt: 'x' },
  ]

  test('drops only results Jev is at least 80% sure are not needed', () => {
    const text = answer([0.05, 0.5, 0.2])
    expect(readDrops(text, candidates, 0.8)).toEqual(['a', 'c'])
  })

  test('an unreadable or missing answer drops nothing', () => {
    expect(readDrops('not json', candidates, 0.8)).toEqual([])
    expect(readDrops(JSON.stringify({ answers: {} }), candidates, 0.8)).toEqual([])
  })

  test('one question per result, each pointing at its own excerpt', () => {
    const body = JSON.parse(jevBody('jev-latest', 'fix it', candidates))
    expect(Object.keys(body.questions)).toEqual(['r0', 'r1', 'r2'])
    expect(body.questions.r1.type).toBe('noul')
    expect(body.questions.r1.instructions).toContain('results[1]')
    expect(body.state.request).toBe('fix it')
  })
})

describe('the request Jev weighs outputs against', () => {
  test('is the person\'s newest message, not a background event or command record', () => {
    const messages = [
      ask('deploy the pod and watch the run'),
      call('a'), back('a'),
      ask('<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: tick 3</summary>\n</task-notification>'),
      ask('<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>'),
      ask('<local-command-caveat>Caveat: run directly</local-command-caveat>'),
    ]
    expect(lastRequest(messages)).toBe('deploy the pod and watch the run')
  })

  test('a person\'s message that starts with other markup still counts', () => {
    expect(lastRequest([ask('<div> is not centred, fix it')])).toBe('<div> is not centred, fix it')
  })
})

describe('asking Jev', () => {
  const messages = [ask('fix'), call('a'), back('a'), call('b'), back('b'), call('c'), back('c'), call('d'), back('d')]

  test('returns the ids Jev says to clear', async () => {
    const world = net([ok(answer([0.05]))])
    expect(await judge(world as any, SETTINGS, messages)).toEqual(['a'])
  })

  test('tries three times on a server error, then clears nothing', async () => {
    const world = net([status(500), status(503), 'throw'])
    expect(await judge(world as any, SETTINGS, messages)).toEqual([])
    expect(world.sent.length).toBe(3)
  })

  test('succeeds on the third attempt', async () => {
    const world = net([status(500), 'throw', ok(answer([0.05]))])
    expect(await judge(world as any, SETTINGS, messages)).toEqual(['a'])
    expect(world.sent.length).toBe(3)
  })

  test('a timeout counts as a failed attempt', async () => {
    const world = net(['hang', 'hang', 'hang'])
    expect(await judge(world as any, SETTINGS, messages)).toEqual([])
    expect(world.sent.length).toBe(3)
  })

  test('a rejected key is not retried', async () => {
    const world = net([status(401), ok(answer([0.05]))])
    expect(await judge(world as any, SETTINGS, messages)).toEqual([])
    expect(world.sent.length).toBe(1)
  })

  test('logs how many old outputs it cleared', async () => {
    const lines: string[] = []
    const world = { ...net([ok(answer([0.05]))]), log: (line: string) => lines.push(line) }
    await judge(world as any, SETTINGS, messages)
    expect(lines).toContain('[context-left] Jev cleared 1 of 1 old tool outputs')
  })

  test('no key, no request', async () => {
    const world = net([ok(answer([0.05]))])
    expect(await judge(world as any, readSettings({ compactEnabled: true }), messages)).toEqual([])
    expect(world.sent.length).toBe(0)
  })
})

describe('clearing results', () => {
  test('swaps the text for a note and keeps the call ids paired', () => {
    const messages = [ask('go'), call('a'), back('a'), call('b'), back('b')]
    const out = clearResults(messages, ['a'])
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'a', text: CLEARED })
    expect(out[1]?.toolUses[0]?.tool_use_id).toBe('a')
  })

  test('a message with nothing cleared stays the engine\'s own, handle and all', () => {
    const messages = [ask('go'), call('a'), back('a'), call('b'), back('b')]
    const out = clearResults(messages, ['a'])
    expect(out[0]).toBe(messages[0])
    expect(out[4]).toBe(messages[4])
    expect(out[2]?.handle).toBeUndefined()
  })
})

describe('compaction hook', () => {
  const OPTIONS = { compactEnabled: true, typesafeApiKey: 'k' }
  const history = () => [
    ask('fix the bug'),
    call('a'), back('a'),
    call('b'), back('b'),
    call('c'), back('c'),
    call('d'), back('d'),
  ]
  const hookInput = (over: Record<string, unknown> = {}) =>
    ({ trigger: 'auto', messages: history(), ...over }) as any

  function passDown() {
    const seen: any[] = []
    return { seen, next: async (e: any) => (seen.push(e), { messages: e.messages }) }
  }

  test('off: the compaction goes down untouched and Jev is not asked', async () => {
    const world = net([])
    const down = passDown()
    const e = hookInput()
    await handleCompact(world as any, readSettings({ typesafeApiKey: 'k' }), e, down.next as any)
    expect(down.seen[0]).toBe(e)
    expect(world.sent.length).toBe(0)
  })

  test('precompute and subagent compactions are left alone', async () => {
    const world = net([])
    const down = passDown()
    const settings = readSettings(OPTIONS)
    const pre = hookInput({ trigger: 'precompute' })
    const sub = hookInput({ agentId: 'a1' })
    await handleCompact(world as any, settings, pre, down.next as any)
    await handleCompact(world as any, settings, sub, down.next as any)
    expect(down.seen).toEqual([pre, sub])
    expect(world.sent.length).toBe(0)
  })

  test('clears what Jev says, then the engine writes the summary with the pin', async () => {
    const world = net([ok(answer([0.05]))])
    const down = passDown()
    const out: any = await handleCompact(
      world as any,
      readSettings(OPTIONS),
      hookInput({ instructions: 'keep the plan' }),
      down.next as any,
    )
    const sent = down.seen[0]
    expect(sent.messages[2].toolResults[0].text).toBe(CLEARED)
    expect(sent.messages[4].toolResults[0].text).toBe(BIG)
    expect(sent.instructions).toContain('keep the plan')
    expect(sent.instructions).toContain(PIN_INSTRUCTIONS)
    expect(out.messages).toBe(sent.messages)
  })

  test('Jev down: nothing is cleared, the engine still compacts with the pin', async () => {
    const world = net([status(500), status(500), status(500)])
    const down = passDown()
    await handleCompact(world as any, readSettings(OPTIONS), hookInput(), down.next as any)
    const sent = down.seen[0]
    expect(sent.messages[2].toolResults[0].text).toBe(BIG)
    expect(sent.instructions).toBe(PIN_INSTRUCTIONS)
  })
})
