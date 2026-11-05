/** Project collaboration, explicit handoffs, and durable recovery context for the local DSH user. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { key, reasonText, type DomainEvent, type Engine, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { ticketCard } from './cards.ts'
import { promptFile } from './skill-files.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface AssistantHost {
  store: Store
  effects: Effects
  engine(): Engine
  id: string
  configured(): boolean
}

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

  checkpoint(text: string) { this.host.store.set(KV.assistant.checkpoint, text); return { saved: true } }
  requestStatus(ticketId: string) {
    if (!this.owns(ticketId)) throw new Error('This work is not linked to the project assistant.')
    return { asked: this.host.engine().requestStatus(ticketId) }
  }

  createWork(args: { message_id: string; request_id: string; title: string; scope: string; context: string; worktree_name: string }) {
    const { store } = this.host
    return store.atomic(() => {
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

    })
  }

  updateWork(args: { message_id: string; request_id: string; ticket_id: string; context: string; question_id?: string }) {
    const { store } = this.host
    return store.atomic(() => {
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

    })
  }

  stopWork(args: { message_id: string; ticket_id: string }) {
    const { store } = this.host
    return store.atomic(() => {
      this.original(args.message_id)
      if (!this.owns(args.ticket_id)) throw new Error('This work is not linked to the project assistant.')
      this.host.engine().stopTicket(args.ticket_id, `Local user request ${this.host.id}/${args.message_id}`)
      return { stopped: true, ticket_id: args.ticket_id }

    })
  }

  retryWork(args: { message_id: string; request_id: string; ticket_id: string }) {
    const { store } = this.host
    return store.atomic(() => {
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

    })
  }
}
