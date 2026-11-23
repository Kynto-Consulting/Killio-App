import type { ContentBlock, Message, MessagesRequest, TextBlock } from './api.ts'
import { AttachmentList } from './attachments.ts'

export type Rendered = { prompt: string; attachments: AttachmentList; latestHasAttachments: boolean; prefill?: string }

export const systemText = (system: MessagesRequest['system']): string =>
  system === undefined ? '' : typeof system === 'string' ? system : system.map(b => b.text).join('\n\n')

const blocksOf = (m: Message): ContentBlock[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)

const renderBlock = (block: ContentBlock, attachments: AttachmentList): string => {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
    case 'document':
      return `[attachment #${attachments.add(block)}: ${block.type}]`
    case 'tool_use':
      return `<tool_call name="${block.name}" id="${block.id}">${JSON.stringify(block.input ?? {})}</tool_call>`
    case 'server_tool_use':
      return `<server_tool_use>${JSON.stringify(block)}</server_tool_use>`
    case 'tool_search_tool_result':
      return `<tool_search_tool_result>${JSON.stringify(block)}</tool_search_tool_result>`
    case 'compaction':
      return `<compaction_summary>${block.content ?? ''}</compaction_summary>`
    case 'tool_result': {
      const inner =
        block.content === undefined
          ? ''
          : typeof block.content === 'string'
            ? block.content
            : block.content.map(c => renderBlock(c, attachments)).join('\n')
      return `<tool_result id="${block.tool_use_id}"${block.is_error ? ' is_error="true"' : ''}>${inner}</tool_result>`
    }
    case 'thinking':
    case 'redacted_thinking':
      return ''
  }
}

const renderBlocks = (m: Message, attachments: AttachmentList): string =>
  blocksOf(m)
    .map(b => renderBlock(b, attachments))
    .filter(s => s !== '')
    .join('\n')

export const renderConversation = (messages: readonly Message[]): Rendered => {
  const attachments = new AttachmentList()
  let list = [...messages]
  let prefill: string | undefined
  const last = list[list.length - 1]
  const prefillable = last?.role === 'assistant' && blocksOf(last).every(b =>
    b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking',
  )
  if (prefillable && last) {
    prefill = blocksOf(last)
      .filter((b): b is TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
    list = list.slice(0, -1)
  }
  // Serialize each turn in the same form wherever it appears. As a conversation grows,
  // prior turns then remain an identical prompt prefix and can benefit from prompt caching.
  let latestHasAttachments = false
  const parts = list.map((m, index) => {
    const before = attachments.items.length
    const content = renderBlocks(m, attachments)
    if (index === list.length - 1) latestHasAttachments = attachments.items.length > before
    return `<${m.role}>\n${content}\n</${m.role}>\n`
  })
  if (prefill) parts.push('', `Continue your reply exactly from where this text stops, without repeating it:\n${prefill}`)
  const prompt = parts.join('\n') || '(empty message)'
  return { prompt, attachments, latestHasAttachments, ...(prefill ? { prefill } : {}) }
}
