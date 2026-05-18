export function parseLabels(labels: string[]): {
  size: 'XS' | 'S' | 'M' | 'L' | 'XL' | null
  priority: number
} {
  const sizeLabel = labels.find((l) => /^size\/(XS|S|M|L|XL)$/.test(l))
  const size = sizeLabel ? (sizeLabel.split('/')[1] as 'XS' | 'S' | 'M' | 'L' | 'XL') : null
  const priorityLabel = labels.find((l) => /^priority\/[0-3]$/.test(l))
  const priority = priorityLabel ? parseInt(priorityLabel.split('/')[1]) : 0
  return { size, priority }
}
