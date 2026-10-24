"""Sample Russian EPUB (cover, chapters, footnotes, an image) for the MOBI/AZW3 test books.

The test books are built from it with kindling (https://github.com/ciscoriordan/kindling):

    python3 scripts/create_test_mobi.py /tmp/sample.epub
    kindling-cli build /tmp/sample.epub --no-embed-source -o scripts/test.azw3
    kindling-cli build /tmp/sample.epub --no-embed-source --legacy-mobi -o scripts/test.mobi
"""
import io, random, struct, sys, zipfile, zlib

def png(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

random.seed(7)
WORDS = "мир дом река лес человек время город дорога солнце ночь утро слово книга окно ветер память голос улица небо сердце".split()
def para(n=60):
    w = [random.choice(WORDS) for _ in range(n)]
    w[0] = w[0].capitalize()
    return " ".join(w) + "."

chapters = []
for i in range(1, 5):
    body = f'<h1 id="ch{i}">Глава {i}</h1>\n'
    for j in range(25):
        p = para()
        if i == 2 and j in (3, 10):
            n = 1 if j == 3 else 2
            p += f'<a id="ref{n}" href="notes.xhtml#n{n}"><sup>{n}</sup></a>'
        body += f"<p>{p}</p>\n"
        if i == 3 and j == 5:
            body += '<p><img src="images/pic.png" alt="рисунок"/></p>\n'
    chapters.append((f"c{i}.xhtml", body))
notes = ('<h1>Примечания</h1>\n<p id="n1">1. Первое примечание. <a href="c2.xhtml#ref1">Назад</a></p>\n'
         '<p id="n2">2. Второе примечание. <a href="c2.xhtml#ref2">Назад</a></p>\n')
chapters.append(("notes.xhtml", notes))

def xhtml(title, body):
    return f'<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title><link rel="stylesheet" href="style.css" type="text/css"/></head><body>\n{body}</body></html>'

manifest = "".join(f'<item id="i{k}" href="{n}" media-type="application/xhtml+xml"/>' for k, (n, _) in enumerate(chapters))
spine = "".join(f'<itemref idref="i{k}"/>' for k in range(len(chapters)))
opf = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:identifier id="id">urn:uuid:mobi-test-1</dc:identifier><dc:title>Тестовая книга MOBI</dc:title>
<dc:creator opf:role="aut">Иван Петров</dc:creator><dc:language>ru</dc:language><meta name="cover" content="cover"/>
</metadata>
<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>
<item id="cover" href="images/cover.png" media-type="image/png"/><item id="pic" href="images/pic.png" media-type="image/png"/>{manifest}</manifest>
<spine toc="ncx">{spine}</spine></package>'''
nav = "".join(f'<navPoint id="p{k}" playOrder="{k+1}"><navLabel><text>{n}</text></navLabel><content src="{n}"/></navPoint>' for k, (n, _) in enumerate(chapters))
ncx = f'<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:mobi-test-1"/></head><docTitle><text>Тест</text></docTitle><navMap>{nav}</navMap></ncx>'

with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip")
    z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    z.writestr("OEBPS/content.opf", opf)
    z.writestr("OEBPS/toc.ncx", ncx)
    z.writestr("OEBPS/style.css", "p { text-indent: 1em; }")
    z.writestr("OEBPS/images/cover.png", png(300, 450, (40, 90, 160)))
    z.writestr("OEBPS/images/pic.png", png(200, 120, (200, 60, 60)))
    for n, b in chapters:
        z.writestr(f"OEBPS/{n}", xhtml(n, b))
