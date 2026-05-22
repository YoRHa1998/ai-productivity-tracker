import { VERSION } from '../version.js'

export async function runVersion(): Promise<number> {
  console.log(`ai-productivity-tracker v${VERSION}`)
  return 0
}
