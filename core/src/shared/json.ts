/** Remove the optional UTF-8 BOM that some Windows editors preserve in text. */
export function stripUtf8Bom(text: string): string {
  return text.replace(/^\uFEFF/u, '')
}
