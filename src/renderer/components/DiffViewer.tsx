interface DiffViewerProps {
  oldCode: string
  newCode: string
}

export default function DiffViewer({ oldCode, newCode }: DiffViewerProps) {
  const oldLines = oldCode.split('\n')
  const newLines = newCode.split('\n')

  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length)
  const lines: Array<{ type: 'same' | 'removed' | 'added'; content: string }> = []

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]

    if (oldLine === newLine) {
      if (oldLine !== undefined) {
        lines.push({ type: 'same', content: oldLine })
      }
    } else {
      if (oldLine !== undefined) {
        lines.push({ type: 'removed', content: oldLine })
      }
      if (newLine !== undefined) {
        lines.push({ type: 'added', content: newLine })
      }
    }
  }

  return (
    <div className="font-mono text-[10px] border border-notion-border rounded overflow-hidden">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`px-2 py-0.5 ${
            line.type === 'removed'
              ? 'bg-red-50 text-notion-danger'
              : line.type === 'added'
              ? 'bg-green-50 text-notion-success'
              : 'text-notion-text-secondary'
          }`}
        >
          <span className="inline-block w-4 mr-2 text-notion-text-muted select-none">
            {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
          </span>
          {line.content}
        </div>
      ))}
    </div>
  )
}
