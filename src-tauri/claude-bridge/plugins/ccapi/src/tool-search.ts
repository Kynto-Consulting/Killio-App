import type { Tool } from './api.ts'

const tokens = (text: string): string[] => text.toLowerCase().replace(/[_-]+/g, ' ').match(/[\p{L}\p{N}]{2,}/gu) ?? []

const schemaText = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(schemaText).join(' ')
  if (typeof value !== 'object' || value === null) return typeof value === 'string' ? value : ''
  return Object.entries(value)
    .map(([key, item]) => `${key} ${schemaText(item)}`)
    .join(' ')
}

// The Messages API's tool-search tool is server-side. ccapi emulates its BM25 retrieval locally,
// then registers only the best matching deferred definitions with the Claude Code agent.
export const selectDeferredTools = (tools: readonly Tool[], query: string, limit = 5): Tool[] => {
  const deferred = tools.filter(tool => tool.defer_loading === true)
  if (deferred.length === 0) return []
  const queryTerms = [...new Set(tokens(query))]
  if (queryTerms.length === 0) return []

  const documents = deferred.map(tool => tokens(`${tool.name} ${tool.description ?? ''} ${schemaText(tool.input_schema)}`))
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1
  const documentFrequency = new Map<string, number>()
  for (const doc of documents) {
    for (const term of new Set(doc)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  }

  return deferred
    .map((tool, i) => {
      const doc = documents[i] ?? []
      const frequencies = new Map<string, number>()
      for (const term of doc) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
      const score = queryTerms.reduce((sum, term) => {
        const frequency = frequencies.get(term) ?? 0
        if (frequency === 0) return sum
        const df = documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (deferred.length - df + 0.5) / (df + 0.5))
        const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * doc.length / averageLength)
        return sum + idf * (frequency * 2.2) / denominator
      }, 0)
      return { tool, score, index: i }
    })
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(hit => hit.tool)
}
