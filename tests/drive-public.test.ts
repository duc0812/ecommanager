import { describe, it, expect, afterEach, vi } from 'vitest'
import { describeDesignLinks, parseDriveLink, parseFolderEmbed, resetPublicDriveCache } from '@/lib/drive-public'

const FOLDER = '1GxGQsg-rFJMNv5pImzWLhIGVG504JQ9P'
const entry = (id: string, title: string, href = `https://drive.google.com/file/d/${id}/view?usp=drive_web`) =>
  `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="${href}" target="_blank">` +
  `<div class="flip-entry-visual"></div><div class="flip-entry-title">${title}</div></a></div></div>`
const page = (...entries: string[]) => `<html><body><div class="flip-entries">${entries.join('')}</div></body></html>`

afterEach(() => {
  vi.unstubAllGlobals()
  resetPublicDriveCache()
})

describe('parseDriveLink', () => {
  it('reads folder and file ids from the link shapes people paste, and nothing else', () => {
    expect(parseDriveLink(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`)).toEqual({ kind: 'folder', id: FOLDER })
    expect(parseDriveLink(`https://drive.google.com/drive/u/1/folders/${FOLDER}`)).toEqual({ kind: 'folder', id: FOLDER })
    expect(parseDriveLink('https://drive.google.com/file/d/1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6/view?usp=drivesdk')).toEqual({ kind: 'file', id: '1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6' })
    expect(parseDriveLink('https://drive.google.com/open?id=1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6')).toEqual({ kind: 'file', id: '1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6' })
    expect(parseDriveLink('https://evil.example/drive/folders/1GxGQsg-rFJMNv5pImzWLhIGVG504JQ9P')).toBeNull()
    expect(parseDriveLink('http://drive.google.com/drive/folders/1GxGQsg-rFJMNv5pImzWLhIGVG504JQ9P')).toBeNull()
    expect(parseDriveLink('https://pod.example.com/api/public/artwork/abc/x.png')).toBeNull()
  })
})

describe('parseFolderEmbed', () => {
  it('lists files and sub-folders with decoded names', () => {
    const html = page(entry('1eaxrVc4vYOUmqdcEyUnwHgEsgyA2vOs6', 'LIT4578_1.pdf'), entry('1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6', 'Tom &amp; Jerry&#39;s.jpg'),
      entry('1Sub-folder_id_000', 'Front', 'https://drive.google.com/drive/folders/1Sub-folder_id_000'))
    expect(parseFolderEmbed(html)).toEqual([
      { id: '1eaxrVc4vYOUmqdcEyUnwHgEsgyA2vOs6', name: 'LIT4578_1.pdf', folder: false, viewUrl: 'https://drive.google.com/file/d/1eaxrVc4vYOUmqdcEyUnwHgEsgyA2vOs6/view' },
      { id: '1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6', name: "Tom & Jerry's.jpg", folder: false, viewUrl: 'https://drive.google.com/file/d/1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6/view' },
      { id: '1Sub-folder_id_000', name: 'Front', folder: true, viewUrl: 'https://drive.google.com/drive/folders/1Sub-folder_id_000' },
    ])
  })
})

describe('describeDesignLinks', () => {
  it('reads each shared folder once, keeps a file link as is, skips other links and reports a private folder', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const id = new URL(String(input)).searchParams.get('id')
      if (id === FOLDER) return new Response(page(entry('1eaxrVc4vYOUmqdcEyUnwHgEsgyA2vOs6', 'LIT4578_1.pdf')), { status: 200 })
      return new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/ServiceLogin' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const stored = [
      `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`,
      'https://drive.google.com/file/d/1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6/view',
      'https://pod.example.com/api/public/artwork/abc/x.png',
      'https://drive.google.com/drive/folders/1PrivateFolderId_0000',
    ].join(' | ')

    const links = await describeDesignLinks(stored)
    expect(links.map(l => [l.kind, l.files.map(f => f.id), l.error])).toEqual([
      ['folder', ['1eaxrVc4vYOUmqdcEyUnwHgEsgyA2vOs6'], null],
      ['file', ['1SCunSO_g1FPrxOeuXEDwBmhrug91AwV6'], null],
      ['folder', [], 'Thư mục không công khai'],
    ])
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://drive.google.com/embeddedfolderview?id=${FOLDER}`)

    await describeDesignLinks(stored)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
