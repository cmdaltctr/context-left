export type Fill = { tokens: number; window: number; percent: number } | null

declare module 'claude-code' {
  interface PluginState {
    'context-left': { fill: Fill }
  }
}
