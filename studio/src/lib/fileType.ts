/**
 * A file's type at a glance — a short extension tag plus a family colour — from its
 * name (preferred: what the uploader called it) or, failing that, its MIME type.
 */
export interface FileType {
  /** Upper-case tag shown on the chip, e.g. "DOCX", "PDF", "PNG"; "FILE" if unknown. */
  tag: string
  family: 'doc' | 'sheet' | 'slides' | 'pdf' | 'image' | 'media' | 'archive' | 'text' | 'other'
  color: string
}

const FAMILIES: Array<[FileType['family'], string, RegExp]> = [
  ['pdf', '#d9534f', /^pdf$/],
  ['doc', '#2b6cb0', /^(docx?|odt|rtf|pages)$/],
  ['sheet', '#2f855a', /^(xlsx?|xlsm|ods|csv|tsv|numbers)$/],
  ['slides', '#c05621', /^(pptx?|odp|key)$/],
  ['image', '#805ad5', /^(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/],
  ['media', '#b83280', /^(mp3|wav|m4a|ogg|mp4|mov|webm|avi|mkv)$/],
  ['archive', '#718096', /^(zip|gz|tgz|tar|rar|7z)$/],
  ['text', '#4a5568', /^(txt|md|markdown|json|ya?ml|xml|html?|log)$/],
]

const MIME_EXT: Array<[RegExp, string]> = [
  [/pdf/, 'pdf'],
  [/wordprocessingml|msword/, 'docx'],
  [/spreadsheetml|ms-excel/, 'xlsx'],
  [/presentationml|ms-powerpoint/, 'pptx'],
  [/^text\/csv/, 'csv'],
  [/^image\/(\w+)/, '$1'],
  [/^text\/markdown/, 'md'],
  [/^text\/plain/, 'txt'],
  [/zip/, 'zip'],
]

function extOf(filename: string | null | undefined, mime: string | null | undefined): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename ?? '')
  if (m?.[1]) return m[1].toLowerCase()
  for (const [re, ext] of MIME_EXT) {
    const hit = re.exec(mime ?? '')
    if (hit) return ext === '$1' ? (hit[1] ?? '').toLowerCase() : ext
  }
  return ''
}

export function fileType(filename?: string | null, mime?: string | null): FileType {
  const ext = extOf(filename, mime)
  for (const [family, color, re] of FAMILIES) {
    if (re.test(ext)) return { tag: ext.toUpperCase(), family, color }
  }
  return { tag: ext ? ext.toUpperCase() : 'FILE', family: 'other', color: '#718096' }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
