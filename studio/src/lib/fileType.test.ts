import { describe, expect, it } from 'vitest'
import { fileType, formatBytes } from './fileType'

describe('fileType', () => {
  it('prefers the filename extension', () => {
    expect(fileType('Informe_final.docx', 'application/octet-stream')).toMatchObject({
      tag: 'DOCX',
      family: 'doc',
    })
    expect(fileType('data.XLSX', null).family).toBe('sheet')
    expect(fileType('deck.pptx').family).toBe('slides')
    expect(fileType('scan.pdf').family).toBe('pdf')
  })

  it('falls back to the MIME type, then to FILE', () => {
    expect(fileType('noext', 'application/pdf').tag).toBe('PDF')
    expect(fileType(null, 'image/png')).toMatchObject({ tag: 'PNG', family: 'image' })
    expect(
      fileType('x', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').tag,
    ).toBe('DOCX')
    expect(fileType('weird', 'application/x-unknown')).toMatchObject({
      tag: 'FILE',
      family: 'other',
    })
  })

  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(48_000)).toBe('47 KB')
    expect(formatBytes(3_500_000)).toBe('3.3 MB')
  })
})
