/** Tool schemas and adapters for the project collaboration assistant. */
import { z } from 'zod'
import type { Assistant } from '../assistant.ts'
import type { Sessions } from '../sessions.ts'
import { WorktreeNameSchema } from '../assessment.ts'
import { tool, type Tool } from './tool.ts'
const reference = z.object({ message_id: z.string().min(1), request_id: z.string().min(1).max(120) })
const context = z.string().trim().min(1).max(24000)
export function assistantTools(assistant: Assistant, sessions: Pick<Sessions, 'history'>, sessionId: string): Tool[] {
  return [
    tool({ name: 'assistant_history', description: 'Read or search persisted assistant conversation events, including original user message ids. Continue with next_offset.',
      schema: z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20), query: z.string().default('') }).strict(),
      execute: async args => sessions.history(sessionId, args.offset, args.limit, args.query) }),
    tool({ name: 'assistant_checkpoint', description: 'Replace discussion recovery context: goal, accepted decisions, constraints, open questions and source references. This grants no authority and does not replace project assets.',
      schema: z.object({ text: context }).strict(), execute: async args => assistant.checkpoint(args.text) }),
    tool({ name: 'assistant_work', description: 'Query current facts of work handed off by this assistant. Full details use orchestrator_read.',
      schema: z.object({}).strict(), execute: async () => ({ items: assistant.work() }) }),
    tool({ name: 'orchestrator_ticket_request_status', description: 'Ask a linked worker that ended without a report for its status. This adds no new work or authority; other states are unchanged.',
      schema: z.object({ ticket_id: z.string().min(1) }).strict(), execute: async args => assistant.requestStatus(args.ticket_id) }),
    tool({ name: 'assistant_create_work', description: 'Create explicitly authorized work from an original user message. Keep scope, constraints, unresolved questions and asset references in context. Same message_id/request_id retries reuse the ticket; never reuse that pair for different work.',
      schema: reference.extend({ title: z.string().trim().min(1).max(300), scope: context, context, worktree_name: WorktreeNameSchema }).strict(),
      execute: async args => assistant.createWork(args) }),
    tool({ name: 'assistant_update_work', description: 'Deliver only selected user requirements or an answer to one ticket, within its existing scope. Wider work needs a new ticket. question_id must match the current question when answering.',
      schema: reference.extend({ ticket_id: z.string().min(1), context, question_id: z.string().optional() }).strict(),
      execute: async args => assistant.updateWork(args) }),
    tool({ name: 'assistant_stop_work', description: 'Stop one linked ticket on an explicit user request. Does not undo external changes already made.',
      schema: z.object({ ticket_id: z.string().min(1), message_id: z.string().min(1) }).strict(), execute: async args => assistant.stopWork(args) }),
    tool({ name: 'assistant_retry_work', description: 'Retry a failed or blocked linked ticket on an explicit user request, under its existing mandate. Reuse request_id on retries.',
      schema: reference.extend({ ticket_id: z.string().min(1) }).strict(), execute: async args => assistant.retryWork(args) }),
  ]
}
