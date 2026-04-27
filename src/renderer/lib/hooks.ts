import { useRef, useCallback } from 'react'

/**
 * Hook that suppresses the Enter key that confirms IME (e.g. Japanese kanji)
 * composition so it doesn't accidentally submit the surrounding form.
 * Tracks compositionstart/end and reports the current state via `isComposing`.
 */
export function useCompositionGuard() {
  const composingRef = useRef(false)

  const onCompositionStart = useCallback(() => {
    composingRef.current = true
  }, [])

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false
  }, [])

  const isComposing = useCallback(() => composingRef.current, [])

  return {
    compositionProps: { onCompositionStart, onCompositionEnd },
    isComposing,
  }
}
