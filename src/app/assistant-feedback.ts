/** Owns local work return links and feedback routing; execution state remains in Engine. */
import { key, type DomainEvent, type OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import { ticketCard } from './cards.ts'
import type { Effects } from './effects.ts'
import type { Relay } from './notices.ts'
import type { Store } from './store.ts'

/** Maintains return links once at ticket creation and queues feedback in the caller's transaction. */
export class AssistantFeedback {
  constructor(private readonly store: Store, private readonly effects: Effects, private readonly sessionId: string) {}

  linked(ticketId: string): boolean { return !!this.store.get(KV.assistant.work(ticketId)) }
  target(ticketId: string): 'assistant' | 'orchestrator' { return this.linked(ticketId) ? 'assistant' : 'orchestrator' }

  work() {
    return this.store.keys(KV.assistant.work).flatMap(name => {
      const link = this.store.get(KV.assistant.work(name.slice(KV.assistant.work.prefix.length)))
      const ticket = link && this.store.tickets.get(link.ticketId)
      return ticket ? [{ ...ticketCard(ticket), source: { session_id: link.sessionId, message_id: link.messageId,
        trigger_id: link.triggerId }, read: `ticket/${ticket.id}` }] : []
    })
  }

  report(ticketId: string, relay: Relay): void {
    this.effects.enqueue(this.target(ticketId) === 'assistant' ? 'assistant-relay' : 'relay', relay.id, { text: relay.text })
  }

  reply(message: OutboundMessage): void {
    this.effects.enqueue('assistant-relay', `channel:${message.id}`, { text: JSON.stringify({ kind: 'worker_reply',
      ticket_id: message.ticketId, text: message.text, purpose: message.kind }) })
  }

  event(event: DomainEvent): void {
    if (event.type === 'ticket.created') {
      const ticket = this.store.tickets.get(event.data.ticketId)!
      const trigger = this.store.triggers.get(ticket.origin.triggerId)
      const messageId = trigger?.meta.message_id
      if (trigger?.source === 'assistant' && trigger.meta.session_id === this.sessionId && typeof messageId === 'string'
        && this.store.get(KV.assistant.message(messageId)) && !this.linked(ticket.id)) {
        this.store.set(KV.assistant.work(ticket.id), { ticketId: ticket.id, sessionId: this.sessionId, messageId,
          triggerId: trigger.id, context: typeof trigger.meta.assistant_context === 'string' ? trigger.meta.assistant_context : ticket.mandate.scope })
      }
      return
    }
    if (event.type !== 'assignment.started' && event.type !== 'ticket.ended') return
    const ticketId = event.data.ticketId
    if (!this.linked(ticketId)) return
    const occurrence = event.type === 'assignment.started' ? event.data.assignmentId
      : this.store.tickets.get(ticketId)?.ended?.at ?? event.at
    this.report(ticketId, { id: key('assistant-event', event.type, ticketId, occurrence),
      text: JSON.stringify({ kind: event.type === 'assignment.started' ? 'assignment_dispatched' : 'ticket_ended',
        ...event, read: `ticket/${ticketId}` }) })
  }
}
