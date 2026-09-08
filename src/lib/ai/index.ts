import 'server-only'
import type { AIProvider } from './provider'
import { MockAIProvider } from './mock-provider'
import { AnthropicAIProvider } from './anthropic-provider'
import { isAIConfigured } from './provider'

let cached: AIProvider | null = null

/**
 * Resolves the configured provider, falling back to the deterministic mock when
 * no API key is present. Nothing else in the codebase decides this.
 */
export function getAIProvider(): AIProvider {
  if (cached) return cached

  if (isAIConfigured()) {
    cached = new AnthropicAIProvider()
  } else {
    cached = new MockAIProvider()
  }
  return cached
}

export * from './provider'
export { scoreCandidates, assignmentConfidence, DEFAULT_WEIGHTS } from './scoring'
