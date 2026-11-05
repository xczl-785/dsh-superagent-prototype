/** Project collaboration, explicit handoffs, and durable recovery context for the local DSH user. */
import { reasonText, type Engine } from '../core/index.ts'
import { KV } from '../kv.ts'
import { promptFile } from './skill-files.ts'
import type { AssistantSource } from '../sources/assistant.ts'
import type { AssistantFeedback } from './assistant-feedback.ts'
import type { Store } from './store.ts'

export interface AssistantHost {
  store: Store
  source: AssistantSource
  feedback: AssistantFeedback
  engine(): Engine
  id: string
  configured(): boolean
}

const instructions = promptFile('assistant')

/** Coordinates explicit user handoffs and checkpoints; source and feedback own ingress and return links. */
export class Assistant {
  constructor(private readonly host: AssistantHost) {}

  work() { return this.host.feedback.work() }
  linked(ticketId: string): boolean { return this.host.feedback.linked(ticketId) }

  recovery(): string {
    return `${instructions}\nCheckpoint: ${this.host.store.get(KV.assistant.checkpoint) ?? '(none)'}`
  }

  checkpoint(text: string) { this.host.store.set(KV.assistant.checkpoint, text); return { saved: true } }
  requestStatus(ticketId: string) {
    if (!this.linked(ticketId)) throw new Error('This work is not linked to the project assistant.')
    return { asked: this.host.engine().requestStatus(ticketId) }
  }

  createWork(args: { message_id: string; request_id: string; title: string; scope: string; context: string; worktree_name: string }) {
    const { store } = this.host
    return store.atomic(() => {
      if (!this.host.configured()) throw new Error('Execution setup is incomplete; work has not been handed off.')
      const trigger = this.host.source.trigger(args.message_id, args.request_id, args.context)
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
      store.set(operation, { ticketId, payload })
      return { status: 'created', ticket_id: ticketId, dispatch: 'pending', read: `ticket/${ticketId}` }

    })
  }

  updateWork(args: { message_id: string; request_id: string; ticket_id: string; context: string; question_id?: string }) {
    const { store } = this.host
    return store.atomic(() => {
      if (!this.linked(args.ticket_id)) throw new Error('This work is not linked to the project assistant.')
      const trigger = this.host.source.trigger(args.message_id, args.request_id, args.context)
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
      this.host.source.original(args.message_id)
      if (!this.linked(args.ticket_id)) throw new Error('This work is not linked to the project assistant.')
      this.host.engine().stopTicket(args.ticket_id, `Local user request ${this.host.id}/${args.message_id}`)
      return { stopped: true, ticket_id: args.ticket_id }

    })
  }

  retryWork(args: { message_id: string; request_id: string; ticket_id: string }) {
    const { store } = this.host
    return store.atomic(() => {
      const trigger = this.host.source.trigger(args.message_id, args.request_id)
      if (!this.linked(args.ticket_id)) throw new Error('This work is not linked to the project assistant.')
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
