import type { ModelEffort, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

// Compaction at a context threshold. Pure helpers plus one network call: Jev
// (TypeSafe) judges which old tool outputs the model will not need again, and
// those are cleared before the summary is written. Every failure leaves the
// conversation as it was, so pruning never blocks a compaction.

export const CLEARED = '[tool output cleared by context-left: judged not needed again]'

/** Results shorter than this (about 500 tokens) are not worth a judgment. */
const MIN_CHARS = 2000
const EXCERPT_CHARS = 1500
/** Questions in one request; the model answers them in parallel. */
const CHUNK = 15
/** Tries per request, the first included. */
const JEV_ATTEMPTS = 3
const BACKOFF_MS = 500
const DEFAULT_JEV_MODEL = 'jev-latest'
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

export type CompactSettings = {
  enabled: boolean
  atPercent: number
  model: string
  effort: string
  apiKey: string
  jevModel: string
  keepRecent: number
  dropConfidence: number
  jevTimeoutMs: number
}

/**
 * The mod's options (`userConfig` values), with the defaults of `plugin.json`.
 * The config menu shows a default only for a toggle or a picker, so the numbers
 * are pickers and arrive as text. `resetToDefaults` drops every value but the
 * key and the master switch.
 */
export function readSettings(given: Record<string, unknown>): CompactSettings {
  const options = given.resetToDefaults === true ? {} : given
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback
  const number = (key: string, fallback: number) => {
    const value = options[key]
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    enabled: given.compactEnabled === true,
    atPercent: number('compactAtPercent', 60),
    model: text('compactModel', 'sonnet'),
    effort: text('compactEffort', 'medium'),
    apiKey: typeof given.typesafeApiKey === 'string' ? given.typesafeApiKey : '',
    jevModel: text('typesafeModel', DEFAULT_JEV_MODEL),
    keepRecent: number('keepRecentToolResults', 3),
    dropConfidence: number('dropConfidence', 0.8),
    jevTimeoutMs: number('jevTimeoutMs', 5000),
  }
}

/** Whether a turn that ended at `percent` used should start a compaction. */
export function shouldFire(settings: CompactSettings, percent: number, armed: boolean): boolean {
  return settings.enabled && armed && percent >= settings.atPercent
}

export type Candidate = { id: string; tool: string; excerpt: string }

/**
 * The tool results Jev is asked about: all but the newest `keepRecent`, and
 * never an error or a short output.
 */
export function pickCandidates(messages: readonly SessionMessage[], keepRecent: number): Candidate[] {
  const tools = new Map<string, string>()
  const results: { id: string; text: string; isError: boolean }[] = []
  for (const message of messages) {
    for (const use of message.toolUses) tools.set(use.tool_use_id, use.tool)
    for (const result of message.toolResults ?? []) {
      results.push({ id: result.tool_use_id, text: result.text, isError: result.isError })
    }
  }
  return results
    .slice(0, Math.max(0, results.length - keepRecent))
    .filter(result => !result.isError && result.text.length >= MIN_CHARS)
    .map(result => ({
      id: result.id,
      tool: tools.get(result.id) ?? 'unknown',
      excerpt: result.text.slice(0, EXCERPT_CHARS),
    }))
}

/** The newest thing the person typed; what the old outputs are weighed against. */
export function lastRequest(messages: readonly SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'user' && message.text.trim()) return message.text
  }
  return ''
}

/** One Noul per result, each naming its own excerpt in the shared state. */
export function jevBody(model: string, request: string, candidates: readonly Candidate[]): string {
  const questions = Object.fromEntries(
    candidates.map((_, i) => [
      `r${i}`,
      {
        type: 'noul',
        instructions: `Does the assistant still need the output in \`results[${i}].excerpt\` to finish \`request\`, or to answer a likely follow-up? Answer no when the output was only searched through, appears again later, or its useful facts were already used.`,
      },
    ]),
  )
  const state = { request, results: candidates.map(({ tool, excerpt }) => ({ tool, excerpt })) }
  return JSON.stringify({ model, state, questions })
}

/** The ids Jev is at least `dropConfidence` sure are not needed again. */
export function readDrops(
  responseText: string,
  candidates: readonly Candidate[],
  dropConfidence: number,
): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    return []
  }
  const answers = (parsed as { answers?: Record<string, { noul?: unknown }> }).answers ?? {}
  const drops: string[] = []
  candidates.forEach((candidate, i) => {
    const needed = answers[`r${i}`]?.noul
    // The small epsilon keeps 0.2 needed and 0.8 confidence on the same side.
    if (typeof needed === 'number' && needed + dropConfidence <= 1 + 1e-9) drops.push(candidate.id)
  })
  return drops
}

/** What `judge` needs from the engine: `$.http.fetch`, `$.clock.sleep`, `$.ui.log`. */
export type Net = {
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; status: number; text: string }>
  sleep: (ms: number) => Promise<unknown>
  log: (line: string) => void
}

async function askChunk(
  net: Net,
  settings: CompactSettings,
  request: string,
  chunk: readonly Candidate[],
): Promise<string[]> {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
    body: jevBody(settings.jevModel, request, chunk),
  }
  for (let attempt = 1; attempt <= JEV_ATTEMPTS; attempt++) {
    try {
      const reply = await Promise.race([
        net.fetch(JEV_URL, init),
        net.sleep(settings.jevTimeoutMs).then(() => null),
      ])
      if (reply?.ok) return readDrops(reply.text, chunk, settings.dropConfidence)
      if (reply && reply.status !== 429 && reply.status < 500) {
        net.log(`[context-left] Jev answered ${reply.status}; no retry`)
        return []
      }
      net.log(`[context-left] Jev attempt ${attempt} failed: ${reply ? reply.status : 'timeout'}`)
    } catch (error) {
      net.log(`[context-left] Jev attempt ${attempt} failed: ${String(error)}`)
    }
    if (attempt < JEV_ATTEMPTS) await net.sleep(BACKOFF_MS * attempt)
  }
  return []
}

/** Ids of old tool outputs to clear; empty with no key or on any failure. */
export async function judge(
  net: Net,
  settings: CompactSettings,
  messages: readonly SessionMessage[],
): Promise<string[]> {
  if (!settings.apiKey) return []
  const candidates = pickCandidates(messages, settings.keepRecent)
  if (candidates.length === 0) return []
  const request = lastRequest(messages)
  const cleared: string[] = []
  for (let i = 0; i < candidates.length; i += CHUNK) {
    cleared.push(...(await askChunk(net, settings, request, candidates.slice(i, i + CHUNK))))
  }
  return cleared
}

/**
 * The same messages with the named results' text swapped for a short note. A
 * changed message loses its `handle`, so the engine builds it from the blocks
 * given; every other message stays the engine's own.
 */
export function clearResults(
  messages: readonly SessionMessage[],
  ids: readonly string[],
): SessionMessage[] {
  const gone = new Set(ids)
  return messages.map(message => {
    if (!message.toolResults?.some(result => gone.has(result.tool_use_id))) return message
    return {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses,
      toolResults: message.toolResults.map(result =>
        gone.has(result.tool_use_id) ? { ...result, text: CLEARED } : result,
      ),
    }
  })
}

/** What the engine's own summariser is told to protect, when it writes the summary. */
export const PIN_INSTRUCTIONS =
  'Keep the goal and every constraint the person stated, in their words. Keep decisions with the reason for each, errors not yet fixed, approaches that failed and why, and the paths of files changed or still in play. Drop raw tool output.'

const SUMMARY_SYSTEM = `You write the summary that replaces a long coding-agent conversation. The agent continues from your summary alone, so it must be complete. Reply with the summary text only. Do not call tools.

Use these sections:
1. Task: the request and its success criteria.
2. Latest request: the person's newest message, verbatim.
3. State: what is done, with the paths of files created or changed.
4. Discoveries: constraints, decisions and the reason for each, errors and their fixes, approaches that failed and why.
5. Next steps: what to do next, blockers, open questions.
6. Keep: the person's preferences and rules, in their words, and any promise made.

Leave out raw tool output and resolved dead ends.`

/** A transcript longer than this (about 125k tokens) goes to the engine's summariser. */
const MAX_TRANSCRIPT_CHARS = 500_000
const RESULT_CHARS = 1200
const INPUT_CHARS = 200

/** The conversation as plain text, for the summariser. Results are cut short. */
export function transcript(messages: readonly SessionMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.text.trim()) lines.push(`${message.role === 'user' ? 'PERSON' : 'ASSISTANT'}: ${message.text}`)
    for (const use of message.toolUses) {
      lines.push(`CALL ${use.tool}: ${JSON.stringify(use.input).slice(0, INPUT_CHARS)}`)
    }
    for (const result of message.toolResults ?? []) {
      lines.push(`${result.isError ? 'ERROR' : 'RESULT'}: ${result.text.slice(0, RESULT_CHARS)}`)
    }
  }
  return lines.join('\n')
}

/** What `handleCompact` needs from the engine, apart from the network. */
export type Env = {
  net: Net
  complete: (request: {
    model: string
    effort: ModelEffort
    system: string
    prompt: string
    maxTokens: number
    timeoutMs: number
  }) => Promise<{ isAnswered: boolean; text?: string }>
}

async function summarise(
  env: Env,
  settings: CompactSettings,
  messages: readonly SessionMessage[],
  focus: string | undefined,
): Promise<string | null> {
  const body = transcript(messages)
  if (body.length > MAX_TRANSCRIPT_CHARS) return null
  try {
    const reply = await env.complete({
      model: settings.model,
      effort: settings.effort as ModelEffort,
      system: SUMMARY_SYSTEM,
      prompt: focus ? `${body}\n\nThe person asks the summary to stress: ${focus}` : body,
      maxTokens: 6000,
      timeoutMs: 180_000,
    })
    return reply.isAnswered && reply.text?.trim() ? reply.text.trim() : null
  } catch (error) {
    env.net.log(`[context-left] summary call failed: ${String(error)}`)
    return null
  }
}

/**
 * The `session.compact` hook. Jev clears old tool outputs, then the chosen
 * model writes the summary. Where either step fails the engine compacts as it
 * would have, so a failure here never stops a compaction.
 */
export async function handleCompact(
  env: Env,
  settings: CompactSettings,
  e: SessionCompactInput,
  next: (e: SessionCompactInput) => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> {
  if (!settings.enabled || e.trigger === 'precompute' || e.agentId) return next(e)
  const cleared = await judge(env.net, settings, e.messages)
  const messages = cleared.length > 0 ? clearResults(e.messages, cleared) : e.messages
  const summary = await summarise(env, settings, messages, e.instructions)
  if (summary) {
    const text = `This session continues an earlier conversation. Its summary:\n\n${summary}`
    return { messages: [{ role: 'user', text, toolUses: [] }] }
  }
  const instructions = [e.instructions, PIN_INSTRUCTIONS].filter(Boolean).join('\n\n')
  return next({ ...e, messages, instructions })
}
