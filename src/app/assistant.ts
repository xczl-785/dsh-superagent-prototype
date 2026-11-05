/** Project collaboration, explicit handoffs, and durable recovery context for the local DSH user. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { key, reasonText, type DomainEvent, type Engine, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { WorktreeNameSchema } from './assessment.ts'
import { ticketCard } from './cards.ts'
import { transcriptEntry } from './context.ts'
import { promptFile } from './skill-files.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'
import type { Sessions } from './sessions.ts'
import { tool, type Tool } from './tools/tool.ts'

export interface AssistantHost {
  context: Context
  store: Store
  sessions: Sessions
  effects: Effects
  engine(): Engine
  id: string
  configured(): boolean
}

const reference = z.object({ message_id: z.string().min(1), request_id: z.string().min(1).max(120) })
const context = z.string().trim().min(1).max(24000)
const instructions = promptFile('assistant')

/** Owns the assistant's local-user receipts, handoff links and recovery checkpoint, not execution state. */
export class Assistant {
  constructor(private readonly host: AssistantHost) {}

  /** Record only actual user RPC messages; plugin relays can never become human authorization. */
  observe(sessionId: string, message: UserMessage): void {
    if (sessionId !== this.host.id || message.source.kind !== 'user') return
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    this.host.store.set(KV.assistant.message(message.id), { id: message.id, text })
  }

  private original(id: string) {
    const message = this.host.store.get(KV.assistant.message(id))
    if (!message) throw new Error('An original user message from this project assistant is required; use assistant_history to find its id.')
    return message
  }

  private trigger(messageId: string, requestId: string): Trigger {
    const message = this.original(messageId)
    const id = key('assistant-request', this.host.id, messageId, requestId)
    return { id, source: 'assistant', actor: { source: 'assistant', id: 'local-user' }, human: true, addressed: 'direct',
      threads: [{ source: 'assistant', id }], at: new Date().toISOString(), text: message.text,
      channel: { source: 'assistant', thread: id, address: { session_id: this.host.id, message_id: messageId } },
      meta: { session_id: this.host.id, message_id: messageId, request_id: requestId } }
  }

  work() {
    return this.host.store.keys(KV.assistant.work).flatMap(name => {
      const link = this.host.store.get(KV.assistant.work(name.slice(KV.assistant.work.prefix.length)))
      const ticket = link && this.host.store.tickets.get(link.ticketId)
      return ticket ? [{ ...ticketCard(ticket), source: { session_id: link.sessionId, message_id: link.messageId,
        trigger_id: link.triggerId }, read: `ticket/${ticket.id}` }] : []
    })
  }

  owns(ticketId: string): boolean { return !!this.host.store.get(KV.assistant.work(ticketId)) }

  recovery(): string {
    return `${instructions}\nCheckpoint: ${this.host.store.get(KV.assistant.checkpoint) ?? '(none)'}`
  }

  /** Persist an event in the same command transaction as its ticket change, before any dispatch can run. */
  event(event: DomainEvent): void {
    // A worker may hand a local follow-up back for routing. Tickets subsequently accepted by the router keep its return path too.
    if (event.type === 'ticket.created') {
      const ticket = this.host.store.tickets.get(event.data.ticketId)!
      const trigger = this.host.store.triggers.get(ticket.origin.triggerId)
      const messageId = trigger?.meta.message_id
      if (trigger?.source === 'assistant' && trigger.meta.session_id === this.host.id && typeof messageId === 'string'
        && this.host.store.get(KV.assistant.message(messageId))) {
        this.host.store.set(KV.assistant.work(ticket.id), { ticketId: ticket.id, sessionId: this.host.id, messageId,
          triggerId: trigger.id, context: ticket.mandate.scope })
      }
      return
    }
    if (event.type !== 'assignment.started' && event.type !== 'ticket.ended') return
    const ticketId = event.data.ticketId
    if (!this.owns(ticketId)) return
    const occurrence = event.type === 'assignment.started' ? event.data.assignmentId
      : this.host.store.tickets.get(ticketId)?.ended?.at ?? event.at
    this.host.effects.enqueue('assistant-relay', key('assistant-event', event.type, ticketId, occurrence), {
      text: JSON.stringify({ kind: event.type === 'assignment.started' ? 'assignment_dispatched' : 'ticket_ended',
        ...event, read: `ticket/${ticketId}` }),
    })
  }

  async history(offset: number, limit: number, query = '') {
    const { context, id } = this.host
    await context.sessionPersistence.flush()
    await using handle = await context.sessionPersistence.open(id as SessionId, 'read')
    const items: { offset: number; event: unknown }[] = []
    let cursor = offset
    // Scan a bounded window per call; callers may continue even when a search page has no matches.
    const end = offset + (query ? 512 : limit)
    while (cursor < end && items.length < limit) {
      const { events } = await handle.read(cursor, Math.min(end - cursor, limit))
      if (!events.length) return { items, next_offset: null }
      for (const event of events) {
        if (event.type === 'user/message') this.observe(id, event.data)
        const entry = transcriptEntry(event)
        const visible = entry && { ...entry, ...(event.type === 'user/message' ? { message_id: event.data.id,
          source: event.data.source } : {}) }
        if (visible && (!query || JSON.stringify(visible).toLowerCase().includes(query.toLowerCase()))) items.push({ offset: cursor, event: visible })
        cursor++
        if (items.length >= limit) break
      }
    }
    return { items, next_offset: cursor }
  }

  tools(_agent: Agent): Tool[] {
    const { store } = this.host
    return [
      tool({ name: 'assistant_history', description: 'Read or search persisted assistant conversation events, including original user message ids. Continue with next_offset.',
        schema: z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20), query: z.string().default('') }).strict(),
        execute: async args => this.history(args.offset, args.limit, args.query) }),
      tool({ name: 'assistant_checkpoint', description: 'Replace discussion recovery context: goal, accepted decisions, constraints, open questions and source references. This grants no authority and does not replace project assets.',
        schema: z.object({ text: context }).strict(), execute: async args => { store.set(KV.assistant.checkpoint, args.text); return { saved: true } } }),
      tool({ name: 'assistant_work', description: 'Query current facts of work handed off by this assistant. Full details use orchestrator_read.',
        schema: z.object({}).strict(), execute: async () => ({ items: this.work() }) }),
      tool({ name: 'orchestrator_ticket_request_status', description: 'Ask a linked worker that ended without a report for its status. This adds no new work or authority; other states are unchanged.',
        schema: z.object({ ticket_id: z.string().min(1) }).strict(), execute: async args => {
          if (!this.owns(args.ticket_id)) throw new Error('This work is not linked to the project assistant.')
          return { asked: this.host.engine().requestStatus(args.ticket_id) }
        } }),
      tool({ name: 'assistant_create_work', description: 'Create explicitly authorized work from an original user message. Keep scope, constraints, unresolved questions and asset references in context. Same message_id/request_id retries reuse the ticket; never reuse that pair for different work.',
        schema: reference.extend({ title: z.string().trim().min(1).max(300), scope: context, context, worktree_name: WorktreeNameSchema }).strict(),
        execute: async args => store.atomic(() => {
          if (!this.host.configured()) throw new Error('Execution setup is incomplete; work has not been handed off.')
          const trigger = this.trigger(args.message_id, args.request_id)
          const operation = KV.assistant.operation(trigger.id)
          const payload = JSON.stringify(args)
          const existing = store.get(operation)
          if (existing) {
            if (existing.payload !== payload) throw new Error('This request_id already identifies different work.')
            return { status: 'created', ticket_id: existing.ticketId, reused: true, read: `ticket/${existing.ticketId}` }
          }
          const engine = this.host.engine()
          if (engine.receive(trigger) === 'filtered') throw new Error('The project assistant source is disabled or unavailable.')
          const decision = engine.decide(trigger.id, { kind: 'accept', title: args.title, scope: args.scope,
            name: args.worktree_name, note: args.context, reason: 'Explicit local user request through project assistant' })
          if (!decision.ticketId || decision.kind !== 'accept') throw new Error(reasonText(decision.reason))
          const ticketId = decision.ticketId
          store.set(KV.assistant.work(ticketId), { ticketId, sessionId: this.host.id, messageId: args.message_id,
            triggerId: trigger.id, context: args.context })
          store.set(operation, { ticketId, payload })
          return { status: 'created', ticket_id: ticketId, dispatch: 'pending', read: `ticket/${ticketId}` }
        }) }),
      tool({ name: 'assistant_update_work', description: 'Deliver only selected user requirements or an answer to one ticket, within its existing scope. Wider work needs a new ticket. question_id must match the current question when answering.',
        schema: reference.extend({ ticket_id: z.string().min(1), context, question_id: z.string().optional() }).strict(),
        execute: async args => store.atomic(() => {
          if (!this.owns(args.ticket_id)) throw new Error('This work is not linked to the project assistant.')
          const trigger = this.trigger(args.message_id, args.request_id)
          const operation = KV.assistant.operation(trigger.id)
          const payload = JSON.stringify(args), existing = store.get(operation)
          if (existing) {
            if (existing.payload !== payload) throw new Error('This request_id already identifies a different operation.')
            return { delivered: true, ticket_id: existing.ticketId, reused: true }
          }
          const ticket = store.tickets.get(args.ticket_id)!
          if (args.question_id && ticket.attention?.id !== args.question_id) throw new Error('The question is no longer current; query the work again.')
          if (this.host.engine().receive(trigger) === 'filtered') throw new Error('The project assistant source is disabled or unavailable.')
          this.host.engine().attach(ticket.id, trigger.id, args.context)
          store.set(operation, { ticketId: ticket.id, payload })
          return { delivered: true, ticket_id: ticket.id, meaning: 'queued for delivery; worker receipt is shown on the ticket' }
        }) }),
      tool({ name: 'assistant_stop_work', description: 'Stop one linked ticket on an explicit user request. Does not undo external changes already made.',
        schema: z.object({ ticket_id: z.string().min(1), message_id: z.string().min(1) }).strict(), execute: async args => store.atomic(() => {
          this.original(args.message_id)
          if (!this.owns(args.ticket_id)) throw new Error('This work is not linked to the project assistant.')
          this.host.engine().stopTicket(args.ticket_id, `Local user request ${this.host.id}/${args.message_id}`)
          return { stopped: true, ticket_id: args.ticket_id }
        }) }),
      tool({ name: 'assistant_retry_work', description: 'Retry a failed or blocked linked ticket on an explicit user request, under its existing mandate. Reuse request_id on retries.',
        schema: reference.extend({ ticket_id: z.string().min(1) }).strict(), execute: async args => store.atomic(() => {
          const trigger = this.trigger(args.message_id, args.request_id)
          if (!this.owns(args.ticket_id)) throw new Error('This work is not linked to the project assistant.')
          const operation = KV.assistant.operation(trigger.id), payload = JSON.stringify(args), previous = store.get(operation)
          if (previous) {
            if (previous.payload !== payload) throw new Error('This request_id already identifies a different operation.')
            return { retried: true, ticket_id: previous.ticketId, reused: true }
          }
          this.host.engine().retryTicket(args.ticket_id)
          store.set(operation, { ticketId: args.ticket_id, payload })
          return { retried: true, ticket_id: args.ticket_id, dispatch: 'pending' }
        }) }),
    ]
  }
}
