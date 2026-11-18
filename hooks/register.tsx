import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage } from 'claude-code'

import type { Fill } from '../types'
import { handleCompact, PIN_INSTRUCTIONS, readSettings, shouldFire } from './compact'

// Context window used, drawn in the prompt footer next to the OMMS label:
// `ctx: 76k/200k (38%)`. Green below 50% used, orange from 50% to 80%,
// red above 80%. The engine pushes the figures after each turn
// (`session.measure`), so there is no polling.
//
// Optional, off by default (`compactEnabled`): a turn that ends at or above
// `compactAtPercent` used starts a compaction, once per crossing. See compact.ts.

const ORANGE_FROM = 50
const RED_ABOVE = 80
const ORANGE = '#ff8700'

const fill = atom({ plugin: 'context-left', key: 'fill' } as const, null as Fill)

export function toFill(context: SessionContextUsage): Fill {
  if (context.tokens === undefined || context.percent === undefined) return null
  return { tokens: context.tokens, window: context.window, percent: context.percent }
}

export function colourFor(usedPercent: number): string {
  if (usedPercent < ORANGE_FROM) return 'success'
  if (usedPercent <= RED_ABOVE) return ORANGE
  return 'error'
}

function short(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** True when a drawn tree holds any visible text. */
function hasText(node: unknown): boolean {
  if (typeof node === 'string') return node.trim() !== ''
  if (Array.isArray(node)) return node.some(hasText)
  if (node && typeof node === 'object' && 'children' in node) {
    return hasText((node as { children: unknown }).children)
  }
  return false
}

/** The engine may still count the turn as running when `turn.complete` fires. */
const START_DELAY_MS = 1000

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  // Set when a compaction starts; cleared once usage falls below the threshold.
  let armed = true

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const { context } = await $.session.usage()
    await update($, fill, () => toFill(context))
    return started
  })

  on('session.measure', async ($, e, next) => {
    // After a compaction the fill is absent until the next response.
    if (e.changed.includes('context')) await update($, fill, () => toFill(e.context))
    if (e.context.percent === undefined || e.context.percent < settings.atPercent) armed = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!settings.enabled || e.reason !== 'answer' || e.agentId) return done
    const { context } = await $.session.usage()
    if (context.percent === undefined || !shouldFire(settings, context.percent, armed)) return done
    armed = false
    void (async () => {
      await $.clock.sleep(START_DELAY_MS)
      try {
        await $.session.compact({ instructions: PIN_INSTRUCTIONS })
      } catch (error) {
        armed = true
        $.ui.log(`[context-left] compaction not started: ${String(error)}`)
      }
    })()
    return done
  })

  on('session.compact', async ($, e, next) =>
    handleCompact(
      {
        net: {
          fetch: (url, init) => $.http.fetch(url, init),
          sleep: ms => $.clock.sleep(ms),
          log: line => $.ui.log(line),
        },
        complete: request => $.model.complete(request),
      },
      settings,
      e,
      next,
    ),
  )

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const inner = await next(e)
    const now = await read($, fill)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        {inner}
        {hasText(inner) && <Text dimColor> · </Text>}
        {now ? (
          <Text color={colourFor(now.percent)}>
            ctx: {short(now.tokens)}/{short(now.window)} ({now.percent}%)
          </Text>
        ) : (
          <Text dimColor>ctx: –</Text>
        )}
        {/* Keeps a gap when another plugin draws after this one. */}
        <Text> </Text>
      </Box>
    )
  })
}
