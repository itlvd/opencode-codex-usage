import test from 'node:test'
import assert from 'node:assert/strict'
import { accountID, clockText, durationText, jsonSafe, normalize, fetchUsage, report, usageText, UsageError, windowLabel, windowTitle } from '../core.ts'
import plugin from '../index.ts'

test('missing/null windows are unknown, not zero', () => {
  assert.deepEqual(normalize({rate_limit: {primary_window:null}}).windows, [])
  assert.equal(normalize({}).status, 'no-quota-data')
})
test('preserves zero, durations, additional limits and reset units', () => {
  const result = normalize({plan_type:'team',rate_limit:{primary_window:{used_percent:0,limit_window_seconds:18000,reset_at:2000000000}},additional_rate_limits:[{limit_name:'review',rate_limit:{primary_window:{used_percent:80,reset_after_seconds:60}}}]},1000)
  assert.equal(result.windows.length,2)
  assert.equal(result.windows[0].resetAt,2000000000000)
  assert.equal(result.windows[1].resetAt,61000)
  assert.match(report({rows:[{id:'1',label:'work',active:true,status:'ok',...result}],updatedAt:1000}),/[░]{12}\] 0% used/)
})
test('rejects invalid percentages and recognizes spend block', () => {
  assert.deepEqual(normalize({rate_limit:{primary_window:{used_percent:'20'},secondary_window:{used_percent:-1}}}).windows,[])
  assert.equal(normalize({spend_control:{reached:true}}).status,'limited')
})
test('account identity uses metadata or JWT, never guesses', () => {
  const token = 'x.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'work-id'}})).toString('base64url')+'.x'
  assert.equal(accountID(token),'work-id')
  assert.equal(accountID(token,{accountId:'explicit'}),'explicit')
  assert.equal(accountID('malformed'),undefined)
})
test('fixed endpoint, correct headers and redirects forbidden', async () => {
  await fetchUsage('fake-access','account-a',new AbortController().signal,async(url,options)=>{
    assert.equal(url,'https://chatgpt.com/backend-api/wham/usage')
    assert.equal(options.redirect,'error')
    assert.equal(options.headers['ChatGPT-Account-Id'],'account-a')
    return new Response(JSON.stringify({rate_limit:{primary_window:{used_percent:42}}}))
  })
})
test('429 respects Retry-After; response body cannot leak into error', async () => {
  await assert.rejects(fetchUsage('fake','a',new AbortController().signal,async()=>new Response('secret body',{status:429,headers:{'retry-after':'120'}})), e=>e instanceof UsageError && e.retryMs===120000 && !e.message.includes('secret'))
})
test('all native accounts resolved separately, API key skipped, sanitized snapshot', async () => {
  const original = globalThis.fetch
  const calls=[]; let handlers; let cleanup
  globalThis.fetch = async(_url,options)=>{calls.push(options.headers['ChatGPT-Account-Id']);return new Response(JSON.stringify({plan_type:'plus',rate_limit:{primary_window:{used_percent:25}}}))}
  const connections=[{type:'credential',id:'1',label:'personal',method:'oauth'},{type:'credential',id:'2',label:'work',method:'oauth'},{type:'credential',id:'3',label:'API',method:'key'}]
  try {
    cleanup=await plugin.setup({options:{},rpc:{register:async(_definition,h)=>{handlers=h}},integration:{get:async()=>({data:{connections}}),connection:{active:async()=>connections[1],resolve:async c=>({type:'oauth',access:'fake-secret-'+c.id,refresh:'never-expose',metadata:{accountId:'account-'+c.id}})}}})
    const s=await handlers.snapshot({refresh:true})
    assert.deepEqual(calls,['account-1','account-2'])
    assert.equal(s.rows.length,3)
    assert.equal(s.rows[1].active,true)
    assert.match(s.rows[2].status,/unsupported/)
    assert.ok(!JSON.stringify(s).includes('fake-secret'))
    assert.ok(!JSON.stringify(s).includes('never-expose'))
    await handlers.snapshot({refresh:true})
    assert.equal(calls.length,2,'refresh requests are throttled')
  } finally {cleanup?.();globalThis.fetch=original}
})
test('one failed account does not hide other accounts', async () => {
  const original=globalThis.fetch; let handlers;let cleanup
  globalThis.fetch=async(_url,options)=>options.headers['ChatGPT-Account-Id']==='a' ? new Response('private',{status:401}) : new Response(JSON.stringify({rate_limit:{primary_window:{used_percent:50}}}))
  try {
    cleanup=await plugin.setup({options:{},rpc:{register:async(_,h)=>{handlers=h}},integration:{get:async()=>({data:{connections:['a','b'].map(id=>({type:'credential',id,label:id,method:'oauth'}))}}),connection:{active:async()=>undefined,resolve:async c=>({type:'oauth',access:'fake',metadata:{accountId:c.id}})}}})
    const s=await handlers.snapshot({refresh:true});assert.equal(s.rows[0].status,'error');assert.equal(s.rows[1].status,'ok')
  } finally {cleanup?.();globalThis.fetch=original}
})
test('failed refresh retains marked stale data; deleted accounts disappear', async () => {
  const originalFetch=globalThis.fetch, originalNow=Date.now
  let clock=100000,fail=false,connections=[{type:'credential',id:'a',label:'a',method:'oauth'}],handlers,cleanup
  Date.now=()=>clock
  globalThis.fetch=async()=>fail ? new Response('private',{status:503}) : new Response(JSON.stringify({rate_limit:{primary_window:{used_percent:32}}}))
  try {
    cleanup=await plugin.setup({options:{},rpc:{register:async(_,h)=>{handlers=h}},integration:{get:async()=>({data:{connections}}),connection:{active:async()=>undefined,resolve:async()=>({type:'oauth',access:'fake',metadata:{accountId:'a'}})}}})
    await handlers.snapshot({refresh:true});clock+=6000;fail=true
    const stale=await handlers.snapshot({refresh:true})
    assert.equal(stale.rows[0].status,'stale');assert.equal(stale.rows[0].windows[0].used,32)
    assert.match(report(stale),/Last success/)
    clock+=6000;connections=[]
    assert.equal((await handlers.snapshot({refresh:true})).rows.length,0)
  } finally {cleanup?.();globalThis.fetch=originalFetch;Date.now=originalNow}
})

const assertJsonValue = (value, path = '$') => {
  assert.ok(value !== undefined, `undefined at ${path}`)
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `non-finite number at ${path}`)
  if (Array.isArray(value)) return value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`))
  if (value && typeof value === 'object') return Object.entries(value).forEach(([key, item]) => assertJsonValue(item, `${path}.${key}`))
  assert.ok(['string', 'number', 'boolean'].includes(typeof value) || value === null, `non-JSON value at ${path}`)
}
test('jsonSafe removes undefined-valued keys and keeps everything else', () => {
  assert.deepEqual(jsonSafe({ a: 1, b: undefined, c: '', d: 0, e: false, f: null, g: { h: undefined, i: [1] } }), { a: 1, c: '', d: 0, e: false, f: null, g: { i: [1] } })
})
test('a failed first refresh still returns an RPC-safe JSON value', async () => {
  const original = globalThis.fetch; let handlers, cleanup
  globalThis.fetch = async () => new Response('private', { status: 503 })
  try {
    cleanup = await plugin.setup({ options: {}, rpc: { register: async (_, h) => { handlers = h } }, integration: { get: async () => ({ data: { connections: [{ type: 'credential', id: 'a', label: 'a', method: 'oauth' }] } }), connection: { active: async () => undefined, resolve: async () => ({ type: 'oauth', access: 'fake', metadata: { accountId: 'a' } }) } } })
    const s = await handlers.snapshot({ refresh: true })
    assert.equal(s.rows[0].status, 'error')
    assertJsonValue(s)
  } finally { cleanup?.(); globalThis.fetch = original }
})

test('durations collapse to the nearest one or two units', () => {
  assert.equal(durationText(7480), '5d 4h')
  assert.equal(durationText(315), '5h 15m')
  assert.equal(durationText(34), '34m')
  assert.equal(durationText(90), '1h 30m')
  assert.equal(durationText(1440), '1d')
  assert.equal(durationText(60), '1h')
  assert.equal(durationText(0), '0m')
})
test('window blocks render label, countdown, clock and usage bar', () => {
  const now = 1_000_000
  const fiveHour = {name:'primary',used:0,seconds:18000,resetAt:now+(3*60+3)*60000}
  const weekly = {name:'secondary',used:5,seconds:604800,resetAt:now+(3*1440+22*60)*60000}
  assert.match(windowTitle(fiveHour,now),/^5h · 3h 3m \d{2}:\d{2}$/)
  assert.match(windowTitle(weekly,now),/^weekly · 3d 22h \d{2}:\d{2}$/)
  assert.equal(usageText(fiveHour),'[░░░░░░░░░░░░] 0% used')
  assert.equal(usageText(weekly),'[█░░░░░░░░░░░] 5% used')
  assert.equal(windowLabel(604800),'weekly')
  assert.equal(windowLabel(18120),'5h 2m')
  assert.equal(windowLabel(undefined),'')
  assert.equal(windowTitle({name:'review:primary',used:0,seconds:900},now),'review:15m')
  assert.equal(windowTitle({name:'primary',used:0,seconds:18000,resetAt:now-1},now),'5h · reset pending')
  assert.match(clockText(now),/^\d{2}:\d{2}$/)
})
test('dialog lays out account header, window blocks and footer', () => {
  const now = Date.now()
  const lines = report({rows:[{id:'1',label:'Codex',active:true,status:'ok',plan:'plus',windows:[
    {name:'primary',used:0,seconds:18000,resetAt:now+(3*60+3)*60000},
    {name:'secondary',used:5,seconds:604800,resetAt:now+(3*1440+22*60)*60000}]}],updatedAt:now}).split('\n')
  assert.equal(lines[0],'● Codex [plus]')
  assert.match(lines[1],/^  5h · 3h 3m \d{2}:\d{2}$/)
  assert.equal(lines[2],'  [░░░░░░░░░░░░] 0% used')
  assert.match(lines[3],/^  weekly · 3d 22h \d{2}:\d{2}$/)
  assert.equal(lines[4],'  [█░░░░░░░░░░░] 5% used')
  assert.match(lines[5],/^Updated \d{2}:\d{2}$/)
  assert.equal(lines[7],'Account-wide subscription quota; not an OpenCode-only token counter.')
})
