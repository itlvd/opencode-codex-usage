import { Rpc } from '@opencode/plugin/rpc'
export const Usage = Rpc.define({
  id: 'codex-usage',
  events: {},
  methods: {
    snapshot: { input: { type: 'object', properties: { refresh: { type: 'boolean' } }, additionalProperties: false }, output: { type: 'object' } },
  },
})
