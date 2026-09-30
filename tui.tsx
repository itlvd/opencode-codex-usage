import { Plugin } from '@opencode/plugin/tui'
import type { Context, KeymapLayer } from '@opencode/plugin/tui/context'
import { createSignal, For, Show } from 'solid-js'
import { Usage } from './rpc.ts'
import { clockText, report, usageText, windowTitle, type Snapshot } from './core.ts'

// `context.keymap.layer` creates a reactive layer owned by the calling component, so the
// registration has to happen in a render scope under the host keymap provider. Calling it
// from `setup()` throws "Keymap.Provider is missing" because the host runs plugin setup
// outside any reactive owner, which previously aborted every later registration here.
function KeymapCommands(props: { context: Context; layer: () => KeymapLayer }) {
  try {
    props.context.keymap.layer(props.layer)
  } catch {
    // No keymap layer means no slash command; sidebar and RPC keep working.
  }
  return null
}

export default Plugin.define({
  id: 'codex-usage.tui',
  setup(ctx) {
    const [state, setState] = createSignal<Snapshot>({ rows: [], updatedAt: 0 })
    const api = ctx.client.rpc(Usage)
    const location = ctx.location ?? ctx.data.location.default()
    let disposed = false
    let pending: Promise<void> | undefined
    const sync = (refresh = false) => {
      if (pending) return pending
      pending = (async () => {
        try {
          const result = await api.snapshot({ refresh }, { location })
          if (!disposed) setState(result as Snapshot)
        } catch {
          if (!disposed) setState(s => ({ ...s, error: 'Usage plugin unavailable on this server.' }))
        }
      })().finally(() => { pending = undefined })
      return pending
    }
    const layer = (): KeymapLayer => ({ mode: 'global', commands: [{
      id: 'codex-usage.show', title: 'Codex usage — all accounts', group: 'Codex', palette: true,
      slash: { name: 'codex-usage' },
      run: async () => {
        await sync(true)
        await ctx.ui.dialog.alert({ title: 'Codex usage · all saved OpenAI accounts', message: report(state()) })
      },
    }, {
        id: 'codex-usage.refresh', title: 'Refresh Codex usage', group: 'Codex', palette: true,
        slash: { name: 'codex-usage-refresh' }, run: async () => { await sync(true) },
      }] })
    const tone = (status: string, used: number) => status === 'stale' ? '#f59e0b' : used >= 90 ? '#ef4444' : used >= 70 ? '#f59e0b' : ctx.theme.text.base
    const unmountCommands = ctx.ui.slot({ append: 'app', render: () => <KeymapCommands context={ctx} layer={layer} /> })
    const unmount = ctx.ui.slot({ append: 'sidebar.content', render: () => (
      <box flexDirection="column" gap={1}>
        <text fg={ctx.theme.text.base}>Codex usage · /codex-usage</text>
        <Show when={state().error}><text fg="#f59e0b">{state().error}</text></Show>
        <For each={state().rows}>{row => (
          <box flexDirection="column">
            <text fg={row.status === 'ok' ? '#22c55e' : '#f59e0b'}>{`${row.active ? '● ' : ''}${row.label}${row.plan ? ` [${row.plan}]` : ''}${row.status === 'ok' ? '' : ` [${row.status}]`}`}</text>
            <For each={row.windows}>{w => (
              <box flexDirection="column">
                <text fg={tone(row.status, w.used)}>{`  ${windowTitle(w)}`}</text>
                <text fg={tone(row.status, w.used)}>{`  ${usageText(w)}`}</text>
              </box>
            )}</For>
            <Show when={row.error}><text fg="#f59e0b">{row.error}</text></Show>
          </box>
        )}</For>
        <Show when={state().updatedAt}><text fg={ctx.theme.text.muted}>{`Updated ${clockText(state().updatedAt)}`}</text></Show>
      </box>
    ) })
    let debounce: ReturnType<typeof setTimeout> | undefined
    const completed = () => { clearTimeout(debounce); debounce = setTimeout(() => { void sync(true) }, 1500) }
    const stop = ctx.data.on('session.execution.succeeded', completed)
    const failed = ctx.data.on('session.execution.failed', completed)
    const switched = ctx.data.on('credential.switched', completed)
    const updated = ctx.data.on('credential.updated', completed)
    const timer = setInterval(() => { void sync() }, 5000)
    void sync()
    return () => { disposed = true; clearInterval(timer); clearTimeout(debounce); stop(); failed(); switched(); updated(); unmountCommands(); unmount() }
  },
})
