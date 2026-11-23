import type { ContentBlock, ImageBlock, Message } from '../src/api.ts'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { ApiError } from '../src/errors.ts'

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const isPublicAddress = (address: string): boolean => {
  const version = isIP(address)
  if (version === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    )
  }
  if (version === 6) {
    // Only global unicast 2000::/3 is fetched; this excludes local and mapped addresses.
    const groups = address.toLowerCase().split(':')
    const first = Number.parseInt(groups[0] ?? '', 16)
    const second = Number.parseInt(groups[1] ?? '', 16)
    return Number.isFinite(first) && (first & 0xe000) === 0x2000 && !(first === 0x2001 && second === 0x0db8)
  }
  return false
}

const checkRemoteUrl = async (value: string): Promise<URL> => {
  let url: URL
  try { url = new URL(value) }
  catch { throw new ApiError(400, 'invalid_request_error', 'image URL is invalid') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new ApiError(400, 'invalid_request_error', 'image URL must use HTTP(S) and cannot include credentials')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal'))
    throw new ApiError(400, 'invalid_request_error', 'image URL cannot target a local host')
  let addresses: Array<{ address: string }>
  try { addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true }) }
  catch { throw new ApiError(400, 'invalid_request_error', 'image URL host could not be resolved') }
  if (addresses.length === 0 || addresses.some(entry => !isPublicAddress(entry.address)))
    throw new ApiError(400, 'invalid_request_error', 'image URL must resolve to a public IP address')
  return url
}

const fetchRemoteImage = async (value: string): Promise<Extract<ImageBlock['source'], { type: 'base64' }>> => {
  let url = await checkRemoteUrl(value)
  let response: Response | undefined
  for (let redirects = 0; redirects <= 5; redirects++) {
    try { response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) }) }
    catch (err) { throw new ApiError(400, 'invalid_request_error', `could not fetch image URL: ${String(err)}`) }
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects === 5) throw new ApiError(400, 'invalid_request_error', 'image URL redirected too many times')
    let redirected: string
    try { redirected = new URL(location, url).toString() }
    catch { throw new ApiError(400, 'invalid_request_error', 'image URL redirect is invalid') }
    url = await checkRemoteUrl(redirected)
  }
  if (!response?.ok) throw new ApiError(400, 'invalid_request_error', `image URL returned HTTP ${response?.status ?? 'no response'}`)
  const mediaType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!IMAGE_TYPES.has(mediaType)) throw new ApiError(400, 'invalid_request_error', `image URL returned unsupported media type "${mediaType}"`)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_REMOTE_IMAGE_BYTES)
    throw new ApiError(400, 'invalid_request_error', 'image URL exceeds the 10 MiB limit')
  if (!response.body) throw new ApiError(400, 'invalid_request_error', 'image URL returned an empty body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REMOTE_IMAGE_BYTES) {
        await reader.cancel()
        throw new ApiError(400, 'invalid_request_error', 'image URL exceeds the 10 MiB limit')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { type: 'base64', media_type: mediaType, data: Buffer.from(bytes).toString('base64') }
}

const hydrateBlock = async (block: ContentBlock): Promise<ContentBlock> => {
  if (block.type === 'image' && block.source.type === 'url')
    return { ...block, source: await fetchRemoteImage(block.source.url) }
  if (block.type === 'tool_result' && Array.isArray(block.content))
    return { ...block, content: await Promise.all(block.content.map(hydrateBlock)) }
  return block
}

export const hydrateImageUrls = async (messages: readonly Message[]): Promise<Message[]> =>
  Promise.all(messages.map(async message =>
    typeof message.content === 'string' ? message : { ...message, content: await Promise.all(message.content.map(hydrateBlock)) },
  ))
