import { createReadStream, existsSync, statSync } from 'node:fs'

export interface IncrementalReadResult {
  lines: string[]
  newOffset: number
  truncated: boolean
}

export async function readJsonlIncremental(
  filePath: string,
  fromOffset: number
): Promise<IncrementalReadResult> {
  if (!existsSync(filePath)) {
    return { lines: [], newOffset: 0, truncated: false }
  }

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(filePath)
  } catch {
    return { lines: [], newOffset: fromOffset, truncated: false }
  }
  const currentSize = stats.size

  let actualOffset = fromOffset
  let truncated = false
  if (fromOffset > currentSize) {
    actualOffset = 0
    truncated = true
  }
  if (actualOffset >= currentSize) {
    return { lines: [], newOffset: currentSize, truncated }
  }

  return new Promise<IncrementalReadResult>((resolve, reject) => {
    const lines: string[] = []
    let buffer = ''
    let bytesConsumed = 0

    const stream = createReadStream(filePath, { start: actualOffset, encoding: 'utf-8' })
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      buffer += text
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        if (line.trim()) lines.push(line)
        bytesConsumed += Buffer.byteLength(line, 'utf-8') + 1
        buffer = buffer.slice(idx + 1)
      }
    })
    stream.on('end', () => {
      resolve({ lines, newOffset: actualOffset + bytesConsumed, truncated })
    })
    stream.on('error', reject)
  })
}
