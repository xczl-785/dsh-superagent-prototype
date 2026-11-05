import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { Store } from '../src/app/store.ts'
import { Assistant } from '../src/app/assistant.ts'
import { KV } from '../src/kv.ts'
import { join } from 'node:path'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

async function fixture() {
  host = await startRuntime()
  const { runtime, ctx, agents } = host
  const id = runtime.assistantId
  const message = (messageId: string, text: string, kind = 'user') => {
    ctx.emit('session/event', agents.get(id)!.session as never, { type: 'user/message', data: {
      id: messageId, role: 'user', source: { kind }, content: [{ type: 'text', text }],
    } } as never)
  }
  const create = (messageId = 'u1', requestId = 'export') => host!.runTool(id, 'assistant_create_work', {
    message_id: messageId, request_id: requestId, title: 'Fix export', scope: 'Fix export, preserve the old format',
    worktree_name: 'fix-export', context: 'The user confirmed a small export change.',
  })
  return { ...host, id, message, create }
}

it('creates authorized work once, retaining original user text separately from the handoff', async () => {
  const f = await fixture()
  f.runtime.store.saveSettings({ ...f.runtime.store.settings(), paused: true })
  f.message('u1', 'Please fix export, keep the old format.')
  const result = await f.create()
  expect(result.status).toBe('created')
  expect((await f.create()).ticket_id).toBe(result.ticket_id)
  const ticket = f.runtime.store.tickets.get(String(result.ticket_id))!
  expect(ticket.assignments[0]!.state).toBe('pending')
  expect(ticket.mandate.actor).toEqual({ source: 'assistant', id: 'local-user' })
  expect(f.runtime.store.triggers.get(ticket.origin.triggerId)?.text).toBe('Please fix export, keep the old format.')
  expect(f.runtime.assistant.work().map(item => item.ticket_id)).toContain(ticket.id)
  f.message('u2', 'Now discuss an unrelated UI idea.')
  expect(f.runtime.store.tickets.get(ticket.id)!.inputs).toHaveLength(0)
})

it('rejects plugin-generated messages as human authorization and rolls back invalid work', async () => {
  const f = await fixture()
  f.message('relay', 'Start work', 'dsh-superagent')
  await expect(f.create('relay')).rejects.toThrow('original user message')
  expect(f.runtime.store.tickets.list()).toHaveLength(0)
})

it('returns worker questions and results to the assistant, with directed user replies only', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  const created = await f.create()
  const ticketId = String(created.ticket_id), worker = `worker-${ticketId}`
  await f.runtime.idle()
  expect(f.relays(f.id).some(item => item.kind === 'assignment_dispatched')).toBe(true)
  await f.runTool(worker, 'orchestrator_report', { state: 'progress', summary: 'Need a format decision', human_action: 'Keep old format?' })
  await f.runtime.idle()
  expect(f.relays(f.id).some(item => item.kind === 'worker_attention')).toBe(true)
  expect(f.relays(f.runtime.masterId).some(item => item.kind === 'worker_attention')).toBe(false)
  const question = f.runtime.store.tickets.get(ticketId)!.attention!.id
  f.message('answer', 'Yes, keep it')
  await f.runTool(f.id, 'assistant_update_work', { ticket_id: ticketId, message_id: 'answer', request_id: 'answer',
    context: 'Keep the original format.', question_id: question })
  await f.runtime.idle()
  expect(f.runtime.store.tickets.get(ticketId)!.inputs.some(input => input.kind === 'trigger')).toBe(true)
  f.message('other', 'Discuss UI')
  expect(f.runtime.store.tickets.get(ticketId)!.inputs).toHaveLength(1)
  await f.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Export fixed and checked.' })
  await f.runtime.idle()
  expect(f.relays(f.id).some(item => item.kind === 'worker_report' && item.summary === 'Export fixed and checked.')).toBe(true)
  expect(f.relays(f.runtime.masterId).some(item => item.kind === 'worker_report')).toBe(false)
})

it('persists a recovery checkpoint and makes current work queryable without trusting old conclusions', async () => {
  const f = await fixture()
  await f.runTool(f.id, 'assistant_checkpoint', { text: 'Goal: export. Decided: preserve format. Open: encoding. Sources: docs/export.md.' })
  expect(f.runtime.assistant.recovery()).toContain('preserve format')
  expect(f.runtime.assistant.recovery()).toContain('current project assets')
  const reopened = new Store(join(f.directory, 'orchestrator.sqlite'))
  try {
    const restored = new Assistant({ context: f.ctx, store: reopened, sessions: f.runtime.sessions,
      effects: f.runtime.effects, engine: () => f.runtime.engine, id: f.id, configured: () => true })
    expect(restored.recovery()).toContain('preserve format')
    expect(reopened.get(KV.assistant.checkpoint)).toContain('encoding')
  } finally { reopened.close() }
})

it('rejects changed retry payloads and stale answers without delivering them', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  const created = await f.create()
  await f.runtime.idle()
  await expect(f.runTool(f.id, 'assistant_create_work', { message_id: 'u1', request_id: 'export', title: 'Different work',
    scope: 'Change UI', worktree_name: 'change-ui', context: 'A different task' })).rejects.toThrow('different work')
  f.message('answer', 'Keep it')
  await expect(f.runTool(f.id, 'assistant_update_work', { ticket_id: created.ticket_id, message_id: 'answer', request_id: 'answer',
    context: 'Keep it', question_id: 'obsolete-question' })).rejects.toThrow('no longer current')
  expect(f.runtime.store.tickets.get(String(created.ticket_id))!.inputs).toHaveLength(0)
})

it('stops work on a real user request and rejects later updates and stale worker results', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  const result = await f.create(), ticketId = String(result.ticket_id)
  await f.runtime.idle()
  f.message('stop', 'Stop the export change')
  await f.runTool(f.id, 'assistant_stop_work', { ticket_id: ticketId, message_id: 'stop' })
  f.message('later', 'Change it again')
  await expect(f.runTool(f.id, 'assistant_update_work', { ticket_id: ticketId, message_id: 'later', request_id: 'later', context: 'Change' })).rejects.toThrow()
  await expect(f.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Old result' })).rejects.toThrow('Ticket ended')
  expect(f.runtime.store.tickets.get(ticketId)!.ended?.outcome).toBe('stopped')
})

it('keeps ordinary progress internal and persists feedback on delivery failure', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  const result = await f.create(), ticketId = String(result.ticket_id)
  await f.runtime.idle()
  f.deliveries.mockClear()
  await f.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'progress', summary: 'Reading files' })
  await f.runtime.idle()
  expect(f.relays(f.id)).toEqual([])
  const prompt = vi.spyOn(f.runtime.sessions, 'prompt').mockRejectedValue(new Error('DSH temporarily unavailable'))
  await f.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'blocked', summary: 'Need a decision' })
  await f.runtime.idle()
  expect(f.runtime.effects.pending('assistant-relay')).toBe(true)
  const reopened = new Store(join(f.directory, 'orchestrator.sqlite'))
  try { expect(reopened.db.prepare("SELECT key FROM effect WHERE kind = 'assistant-relay'").all()).not.toHaveLength(0) }
  finally { reopened.close() }
  prompt.mockRestore()
})

it('exposes real work references and persists the router display preference through the management API', async () => {
  const f = await fixture()
  expect((await f.api('GET', 'state')).body).toMatchObject({ assistantId: f.id, showRouter: false })
  await f.api('PUT', 'assistant/display', { show: true })
  expect((await f.api('GET', 'state')).body.showRouter).toBe(true)
  expect((await f.api('POST', 'assistant/focus', { ticket_id: 'missing' })).status).toBe(404)
  f.message('u1', 'Fix export')
  const result = await f.create()
  expect((await f.api('POST', 'assistant/focus', { ticket_id: result.ticket_id })).body).toEqual({ session_id: f.id })
  await f.runtime.idle()
  expect(f.relays(f.id).some(item => item.kind === 'work_reference' && item.ticket_id === result.ticket_id)).toBe(true)
})

it('deduplicates dispatch confirmations for the same assignment', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  const result = await f.create(), ticketId = String(result.ticket_id)
  await f.runtime.idle()
  const assignment = f.runtime.store.tickets.get(ticketId)!.assignments[0]!
  f.runtime.engine.assignmentStarted(ticketId, assignment.id)
  await f.runtime.idle()
  expect(f.relays(f.id).filter(item => item.kind === 'assignment_dispatched')).toHaveLength(1)
})

it('restores original human references by paging persisted conversation history', async () => {
  const f = await fixture()
  const human = { type: 'user/message', data: { id: 'historic-user', source: { kind: 'user' }, role: 'user',
    content: [{ type: 'text', text: 'Preserve the export format' }] } }
  const generated = { type: 'user/message', data: { id: 'historic-relay', source: { kind: 'dsh-superagent', form: 'relay' }, role: 'user',
    content: [{ type: 'text', text: 'Preserve this report' }] } }
  vi.spyOn(f.ctx.sessionPersistence, 'open').mockResolvedValue({ read: async (offset: number) => ({ events: offset === 0 ? [human, generated] : [] }),
    [Symbol.asyncDispose]: async () => {} } as never)
  const page = await f.runTool(f.id, 'assistant_history', { offset: 0, limit: 20, query: 'Preserve' })
  expect(JSON.stringify(page)).toContain('historic-user')
  expect(f.runtime.store.get(KV.assistant.message('historic-user'))?.text).toContain('export format')
  expect(f.runtime.store.get(KV.assistant.message('historic-relay'))).toBeUndefined()
  expect(await f.create('historic-user')).toMatchObject({ status: 'created' })
})

it('rolls back intake and feedback links if admission fails after recording the source', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  vi.spyOn(f.runtime.engine, 'decide').mockImplementationOnce(() => { throw new Error('Admission refused') })
  await expect(f.create()).rejects.toThrow('Admission refused')
  expect(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(0)
  expect(f.runtime.store.tickets.list()).toHaveLength(0)
  expect(f.runtime.store.keys(KV.assistant.work)).toHaveLength(0)
  expect(f.runtime.effects.pending('launch')).toBe(false)
})

it('keeps work links and operation receipts when the database is reopened', async () => {
  const f = await fixture()
  f.runtime.store.saveSettings({ ...f.runtime.store.settings(), paused: true })
  f.message('u1', 'Fix export')
  const created = await f.create()
  const reopened = new Store(join(f.directory, 'orchestrator.sqlite'))
  try {
    const restored = new Assistant({ context: f.ctx, store: reopened, sessions: f.runtime.sessions, effects: f.runtime.effects,
      engine: () => f.runtime.engine, id: f.id, configured: () => true })
    expect(restored.owns(String(created.ticket_id))).toBe(true)
    expect(restored.work()[0]?.ticket_id).toBe(created.ticket_id)
    expect(reopened.keys(KV.assistant.operation)).toHaveLength(1)
  } finally { reopened.close() }
})

it('does not create work when the local source is disabled', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  const settings = f.runtime.store.settings()
  f.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, assistant: { enabled: false, config: {} } } })
  await expect(f.create()).rejects.toThrow('source')
  expect(f.runtime.store.tickets.list()).toHaveLength(0)
})

it('queries the same domain resources as the management panel', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  const created = await f.create()
  const list = await f.runTool(f.id, 'orchestrator_read', { resource: 'tickets' })
  expect(JSON.stringify(list)).toContain(String(created.ticket_id))
  const detail = await f.runTool(f.id, 'orchestrator_read', { resource: `ticket/${created.ticket_id}` })
  expect(JSON.stringify(detail)).toContain('Fix export')
})

it('returns executor failures as well as explicit worker reports to the assistant', async () => {
  const f = await fixture()
  f.message('u1', 'Fix export')
  const result = await f.create(), ticketId = String(result.ticket_id)
  await f.runtime.idle()
  f.ctx.emit('agent/error', { agent: f.agents.get(`worker-${ticketId}`), error: new Error('Permanent fixture failure') } as never)
  await vi.waitFor(() => {
    expect(f.relays(f.id).some(item => item.kind === 'worker_report' && item.state === 'failed')).toBe(true)
  })
  expect(f.relays(f.runtime.masterId).some(item => item.kind === 'worker_report')).toBe(false)
})
