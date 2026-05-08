export interface BotOptions {
  target?:  number
  project?: string
  meta?:    Record<string, any>
}

export interface TickPayload {
  item?: string
  data?: any
  flush?: boolean
}

export interface BotHandle {
  id:      string
  name:    string
  target:  number | null
  tick(payload?: TickPayload): void
  error(msg: string, meta?: any): void
  done(): void
  crashed(msg?: string): void
  isPaused(): boolean
  waitIfPaused(): Promise<void>
}

export function bot(name: string, opts?: BotOptions): Promise<BotHandle>

declare const _default: { bot: typeof bot }
export default _default
