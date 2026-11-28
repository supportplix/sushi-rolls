import { describe, expect, it } from 'vitest'
import { toCsv } from '../src/renderer/src/lib/export'

describe('toCsv', () => {
  it('prefixes formula-like header and cell values with an apostrophe', () => {
    const csv = toCsv(['=1+1', ' =cmd', '@SUM(A1)'], [['+cmd', '-cmd'], ['=HYPERLINK("x")', 5]])
    const cells = csv.split('\r\n').flatMap((line) => line.split(','))
    expect(cells).toContain("'=1+1")
    expect(cells).toContain("' =cmd")
    expect(cells).toContain("'@SUM(A1)")
    expect(cells).toContain("'+cmd")
    expect(cells).toContain("'-cmd")
    expect(cells).toContain(`"'=HYPERLINK(""x"")"`)
    expect(cells).toContain('5')
  })

  it('leaves numeric cells (including negatives) unprefixed', () => {
    expect(toCsv(['n'], [[-5, 0, 12.5]])).toBe('n\r\n-5,0,12.5')
  })

  it('still escapes quotes, commas and newlines', () => {
    expect(toCsv(['a,b'], [['say "hi"\nnext']])).toBe('"a,b"\r\n"say ""hi""\nnext"')
    expect(toCsv(['\t'], [['ok']])).toBe("'\t\r\nok")
  })
})
