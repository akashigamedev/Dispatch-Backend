export function slugify(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, maxLen)
    .replace(/-+$/, '')
}
