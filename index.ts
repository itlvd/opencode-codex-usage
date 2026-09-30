import { Plugin } from '@opencode/plugin'
import { Usage } from './rpc.ts'
import { accountID, clean, fetchUsage, jsonSafe, UsageError, type Row, type Snapshot } from './core.ts'

export default Plugin.define({
  id: 'codex-usage.server',
  async setup(ctx) {
    const seconds = typeof ctx.options.intervalSeconds === 'number' && Number.isFinite(ctx.options.intervalSeconds) ? Math.max(30, ctx.options.intervalSeconds) : 60
    let snapshot: Snapshot = { rows: [], updatedAt: 0 }
    let inflight: Promise<Snapshot> | undefined
    let disposed = false
    let attempted = 0
    const lifetime = new AbortController()
    const backoff = new Map<string, number>()
    async function collect(): Promise<Snapshot> {
      try {
        const integration = (await ctx.integration.get({ integrationID: 'openai' })).data
        const active = await ctx.integration.connection.active('openai')
        const rows: Row[] = []
        const connections = integration.connections.filter(c => c.type === 'credential')
        // Sequential requests avoid refresh-token races and bursts for many accounts.
        for (const connection of connections) {
          if (disposed) break
          if (connection.type !== 'credential') continue
          const base: Row = { id: connection.id, label: clean(connection.label), active: active?.type === 'credential' && active.id === connection.id, status: 'pending', windows: [] }
          const old = snapshot.rows.find(r => r.id === base.id)
          if (connection.method !== 'oauth') { rows.push({ ...base, status: 'API-key: quota unsupported' }); continue }
          if ((backoff.get(base.id) ?? 0) > Date.now()) {
            rows.push({ ...old, ...base, windows: old?.windows ?? [], status: old?.windows.length ? 'stale' : 'error', error: old?.error ?? 'Waiting before retry' }); continue
          }
          try {
            // Native resolver owns OAuth refresh and persistence; never edit the DB.
            const credential = await ctx.integration.connection.resolve(connection)
            if (!credential || credential.type !== 'oauth') throw new UsageError('OAuth unavailable; reconnect in /connect')
            const id = accountID(credential.access, credential.metadata)
            if (!id) throw new UsageError('Account identity unavailable; reconnect in /connect')
            const result = await fetchUsage(credential.access, id, AbortSignal.any([lifetime.signal, AbortSignal.timeout(12_000)]))
            rows.push({ ...base, ...result, checkedAt: Date.now() })
            backoff.delete(base.id)
          } catch (error) {
            const reason = error instanceof UsageError ? error.code : 'Credential refresh or network request failed'
            backoff.set(base.id, Date.now() + (error instanceof UsageError ? error.retryMs : 60_000))
            rows.push({ ...old, ...base, windows: old?.windows ?? [], status: old?.windows.length ? 'stale' : 'error', error: reason })
          }
        }
        const ids = new Set(rows.map(r => r.id))
        for (const key of backoff.keys()) if (!ids.has(key)) backoff.delete(key)
        if (!disposed) snapshot = { rows, updatedAt: Date.now() }
      } catch {
        if (!disposed) snapshot = { ...snapshot, error: 'Cannot list OpenAI connections. Check /connect and OpenCode version.' }
      }
      return snapshot
    }
    function refresh() {
      if (inflight) return inflight
      if (disposed || Date.now() - attempted < 5000) return Promise.resolve(snapshot)
      attempted = Date.now()
      inflight = collect().finally(() => { inflight = undefined })
      return inflight
    }
    await ctx.rpc.register(Usage, { snapshot: async input => jsonSafe((input as { refresh?: boolean })?.refresh ? await refresh() : snapshot) })
    const timer = setInterval(() => { void refresh() }, seconds * 1000)
    timer.unref?.()
    void refresh()
    return () => { disposed = true; clearInterval(timer); lifetime.abort() }
  },
})
