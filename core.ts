export type Window = { name: string; used: number; seconds?: number; resetAt?: number }
export type Row = { id: string; label: string; active: boolean; status: string; plan?: string; windows: Window[]; checkedAt?: number; error?: string }
export type Snapshot = { rows: Row[]; updatedAt: number; error?: string }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const number = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined
export const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 100)

/** Drops `undefined`-valued keys so a snapshot is a JSON value; the server RPC rejects anything else with `rpc.invalid_output`. */
export function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item)) as unknown as T
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = jsonSafe(item)
    return result as T
  }
  return value
}
export function accountID(access: string, metadata?: Record<string, unknown>): string | undefined {
  if (typeof metadata?.accountId === 'string') return metadata.accountId
  try {
    const payload = object(JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()))
    const auth = object(payload['https://api.openai.com/auth'])
    return typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined
  } catch { return undefined }
}
export function normalize(raw: unknown, now = Date.now()): Pick<Row, 'windows' | 'plan' | 'status'> {
  const data = object(raw)
  const windows: Window[] = []
  const group = (prefix: string, rawLimit: unknown) => {
    const limit = object(rawLimit)
    for (const key of ['primary_window', 'secondary_window']) {
      const w = object(limit[key]); const used = number(w.used_percent)
      if (used === undefined || used < 0 || used > 100) continue
      const seconds = number(w.limit_window_seconds)
      const at = number(w.reset_at); const after = number(w.reset_after_seconds)
      windows.push({ name: prefix + (key === 'primary_window' ? 'primary' : 'secondary'), used,
        ...(seconds && seconds > 0 ? { seconds } : {}),
        ...(at && at > 0 ? { resetAt: at * 1000 } : after !== undefined && after >= 0 ? { resetAt: now + after * 1000 } : {}) })
    }
  }
  group('', data.rate_limit)
  if (Array.isArray(data.additional_rate_limits)) for (const item of data.additional_rate_limits) {
    const limit = object(item); group(clean(String(limit.limit_name ?? limit.metered_feature ?? 'additional')) + ':', limit.rate_limit)
  }
  const blocked = object(data.rate_limit).allowed === false || object(data.rate_limit).limit_reached === true || object(data.spend_control).reached === true
  return { windows, ...(typeof data.plan_type === 'string' ? { plan: clean(data.plan_type) } : {}), status: blocked ? 'limited' : windows.length ? 'ok' : 'no-quota-data' }
}
export class UsageError extends Error {
  code: string
  retryMs: number
  constructor(code: string, retryMs = 60_000) { super(code); this.code = code; this.retryMs = retryMs }
}
export async function fetchUsage(access: string, id: string, signal: AbortSignal, request: typeof fetch = fetch) {
  // Never follow a redirect with credentials; fixed destination, no configurable proxy URL.
  const response = await request('https://chatgpt.com/backend-api/wham/usage', {
    headers: { Authorization: `Bearer ${access}`, 'ChatGPT-Account-Id': id, Accept: 'application/json' },
    redirect: 'error', signal,
  })
  if (!response.ok) {
    const retry = response.headers.get('retry-after')
    const seconds = retry ? Number(retry) : NaN
    const delay = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 60_000
    throw new UsageError(`HTTP ${response.status}`, Math.min(3_600_000, Math.max(60_000, delay || 60_000)))
  }
  try { return normalize(await response.json()) } catch { throw new UsageError('invalid-response') }
}
export function durationText(minutes: number) {
  const total = Math.max(0, Math.round(minutes))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const rest = total % 60
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`
  if (hours) return rest ? `${hours}h ${rest}m` : `${hours}h`
  return `${rest}m`
}
/** Local 24h clock, used for reset time and snapshot age. */
export function clockText(ms: number) {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
/** Window length as reported by the API; the 7 day window reads better by name. */
export function windowLabel(seconds?: number) {
  if (!seconds) return ''
  return seconds === 604800 ? 'weekly' : durationText(seconds / 60)
}
export function usageBar(used: number, cells = 12) {
  const filled = Math.min(cells, Math.max(0, Math.round(used * cells / 100)))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}
/** Window header line: `weekly · 3d 22h 07:30`. */
export function windowTitle(w: Window, now = Date.now()) {
  const prefix = w.name.includes(':') ? w.name.slice(0, w.name.lastIndexOf(':') + 1) : ''
  const label = prefix + (windowLabel(w.seconds) || w.name)
  if (!w.resetAt) return label
  if (w.resetAt <= now) return `${label} · reset pending`
  return `${label} · ${durationText(Math.ceil((w.resetAt - now) / 60000))} ${clockText(w.resetAt)}`
}
/** Window usage line: `[█░░░░░░░░░░░] 5% used`. */
export function usageText(w: Window) {
  return `[${usageBar(w.used)}] ${w.used}% used`
}
export function report(snapshot: Snapshot) {
  const lines: string[] = []
  if (snapshot.error) lines.push(snapshot.error)
  for (const row of snapshot.rows) {
    lines.push(`${row.active ? '● ' : ''}${row.label}${row.plan ? ` [${row.plan}]` : ''}${row.status === 'ok' ? '' : ` [${row.status}]`}`)
    for (const w of row.windows) lines.push(`  ${windowTitle(w)}`, `  ${usageText(w)}`)
    if (row.error) lines.push(`  ${row.error}`)
    if (row.status === 'stale' && row.checkedAt) lines.push(`  Last success: ${new Date(row.checkedAt).toLocaleString()}`)
  }
  if (!snapshot.rows.length && !snapshot.error) lines.push('No saved OpenAI accounts found.')
  lines.push(snapshot.updatedAt ? `Updated ${clockText(snapshot.updatedAt)}` : 'Loading…')
  return `${lines.join('\n')}\n\nAccount-wide subscription quota; not an OpenCode-only token counter.`
}
