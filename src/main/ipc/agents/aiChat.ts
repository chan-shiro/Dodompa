// ─── AI Chat Utilities ───
// Shared streaming/non-streaming chat functions and model builder for all agents.
//
// Both chatStream() and chatNonStream() respect the ambient abort signal
// from aiService so that cancelling autonomous generation instantly halts
// in-flight LLM requests — even deep inside agents that don't receive a
// signal parameter explicitly.

import type { AiProviderConfig } from '../../../shared/types'
import { getAmbientAbortSignal } from '../aiService'

/**
 * Throw immediately if the ambient abort signal has already been tripped.
 * Called at the top of chatStream / chatNonStream so we don't even start
 * a new LLM call after the user has pressed Cancel.
 */
function throwIfAborted(): void {
  const sig = getAmbientAbortSignal()
  if (sig?.aborted) {
    throw new Error('GENERATION_CANCELLED')
  }
}

export async function chatStream(
  config: AiProviderConfig,
  messages: Array<{ role: string; content: unknown }>,
  onDelta: (delta: string) => void,
  opts?: { maxOutputTokens?: number },
): Promise<{ text: string; usage?: { totalTokens?: number } }> {
  throwIfAborted()

  const { streamText } = await import('ai')
  const model = await buildModelForAgent(config)
  const abortSignal = getAmbientAbortSignal() ?? undefined

  try {
    // Sanitize messages: ensure images are under 4MB (Anthropic limit is 5MB)
    const sanitizedMessages = messages.map(msg => {
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: (msg.content as Array<Record<string, unknown>>).filter(part => {
            if (part.type === 'image' && typeof part.image === 'string') {
              const sizeBytes = (part.image as string).length * 0.75 // base64 → bytes approx
              if (sizeBytes > 4 * 1024 * 1024) {
                console.warn(`[chatStream] Skipping image: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds 4MB limit`)
                return false
              }
            }
            return true
          }),
        }
      }
      return msg
    })

    const result = streamText({
      model,
      messages: sanitizedMessages as Parameters<typeof streamText>[0]['messages'],
      maxOutputTokens: opts?.maxOutputTokens ?? 8192,
      ...(abortSignal ? { abortSignal } : {}),
    })

    let fullText = ''
    const stream = result.textStream
    for await (const delta of stream) {
      // Check abort between chunks so we stop quickly even if the SDK
      // doesn't propagate the signal on every iteration.
      throwIfAborted()
      fullText += delta
      onDelta(delta)
    }

    return {
      text: fullText,
      usage: result.usage
        ? {
            totalTokens:
              ((await result.usage).promptTokens ?? 0) +
              ((await result.usage).completionTokens ?? 0),
          }
        : undefined,
    }
  } catch (err) {
    // Re-throw cancellation errors without wrapping
    const errMsg = (err as Error).message ?? String(err)
    if (errMsg === 'GENERATION_CANCELLED' || getAmbientAbortSignal()?.aborted) {
      throw new Error('GENERATION_CANCELLED')
    }
    console.error('[chatStream] AI API error:', errMsg)
    throw new Error(`AI API error: ${errMsg}`)
  }
}

export async function chatNonStream(
  config: AiProviderConfig,
  messages: Array<{ role: string; content: unknown }>
): Promise<{ text: string; usage?: { totalTokens?: number } }> {
  throwIfAborted()

  const { generateText } = await import('ai')
  const model = await buildModelForAgent(config)
  const abortSignal = getAmbientAbortSignal() ?? undefined

  try {
    const result = await generateText({
      model,
      messages: messages as Parameters<typeof generateText>[0]['messages'],
      maxOutputTokens: 8192,
      ...(abortSignal ? { abortSignal } : {}),
    })
    return {
      text: result.text,
      usage: result.usage
        ? {
            totalTokens:
              (result.usage.promptTokens ?? 0) +
              (result.usage.completionTokens ?? 0),
          }
        : undefined,
    }
  } catch (err) {
    const errMsg = (err as Error).message ?? String(err)
    if (errMsg === 'GENERATION_CANCELLED' || getAmbientAbortSignal()?.aborted) {
      throw new Error('GENERATION_CANCELLED')
    }
    throw err
  }
}

export async function buildModelForAgent(config: AiProviderConfig) {
  switch (config.type) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      return createAnthropic({ apiKey: config.apiKey, baseURL: 'https://api.anthropic.com/v1' })(config.model)
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      return createOpenAI({ apiKey: config.apiKey }).chat(config.model)
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      return createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model)
    }
    case 'openai-compatible': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      return createOpenAI({
        baseURL: config.baseUrl ?? 'https://api.openai.com/v1',
        apiKey: config.apiKey,
      }).chat(config.model)
    }
    default:
      throw new Error(`Unknown provider: ${config.type}`)
  }
}
