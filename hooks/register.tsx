import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage } from 'claude-code'

import type { Fill } from '../types'

// Context window used, drawn in the prompt footer next to the OMMS label:
// `ctx: 76k/200k (38%)`. Green below 50% used, orange from 50% to 80%,
// red above 80%. The engine pushes the figures after each turn
// (`session.measure`), so there is no polling.

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const { context } = await $.session.usage()
    await update($, fill, () => toFill(context))
    return started
  })

  on('session.measure', async ($, e, next) => {
    // After a compaction the fill is absent until the next response.
    if (e.changed.includes('context')) await update($, fill, () => toFill(e.context))
    return next(e)
  })

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
