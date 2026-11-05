/** Trusted local-user ingress and return channel for the project assistant. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { KV } from '../kv.ts'
import type { SourceKind } from './kind.ts'

/** Converts authentic DSH user messages to immutable, individually addressed local Triggers. */
export class AssistantSource {
  constructor(private readonly store: Store, readonly sessionId: string) {}

  observe(sessionId: string, message: UserMessage): void {
    if (sessionId !== this.sessionId || message.source.kind !== 'user') return
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    this.store.set(KV.assistant.message(message.id), { id: message.id, text })
  }

  original(id: string) {
    const message = this.store.get(KV.assistant.message(id))
    if (!message) throw new Error('An original user message from this project assistant is required; use assistant_history to find its id.')
    return message
  }

  trigger(messageId: string, requestId: string, context?: string): Trigger {
    const message = this.original(messageId)
    const id = key('assistant-request', this.sessionId, messageId, requestId)
    return { id, source: 'assistant', actor: { source: 'assistant', id: 'local-user' }, human: true, addressed: 'direct',
      threads: [{ source: 'assistant', id }], at: new Date().toISOString(), text: message.text,
      channel: { source: 'assistant', thread: id, address: { session_id: this.sessionId, message_id: messageId } },
      meta: { session_id: this.sessionId, message_id: messageId, request_id: requestId, ...(context === undefined ? {} : { assistant_context: context }) } }
  }

  kind(reply: (message: OutboundMessage) => void): SourceKind {
    return { kind: 'assistant', title: { zh: '项目助手', en: 'Project assistant' },
      description: { zh: '本地用户定向交接的工作。', en: 'Work explicitly handed off by the local user.' },
      authorizedSenders: [{ id: 'local-user', name: 'Local DSH user' }],
      schema: z.object({}), fields: [], health: [],
      scope: ({ meta }) => meta.session_id === this.sessionId ? { listened: true, observed: false }
        : { listened: false, reason: 'source_disabled' },
      channel: {
        send: async (_host, message) => { reply(message); return 'sent' },
        link: () => ({ url: '', label: { zh: '项目助手', en: 'Project assistant' } }),
      },
    }
  }
}
