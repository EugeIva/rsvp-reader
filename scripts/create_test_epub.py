import zipfile
import io
import os

OUTPUT = os.path.join(os.path.dirname(__file__), "test.epub")

mimetype = b"application/epub+zip"

container_xml = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""

package_opf = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:test-book-001</dc:identifier>
    <dc:title>Test EPUB</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
    <item id="c4" href="c4.xhtml" media-type="application/xhtml+xml"/>
    <item id="c5" href="c5.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
    <itemref idref="c4"/>
    <itemref idref="c5"/>
  </spine>
</package>"""

nav_xhtml = """<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Navigation</title></head>
<body><nav><ol>
  <li><a href="c1.xhtml">Chapter 1</a></li>
  <li><a href="c2.xhtml">Chapter 2</a></li>
  <li><a href="c3.xhtml">Chapter 3</a></li>
  <li><a href="c4.xhtml">Chapter 4</a></li>
  <li><a href="c5.xhtml">Chapter 5</a></li>
</ol></nav></body>
</html>"""

chapters = [
    ("c1.xhtml", "<h1>Chapter 1</h1><p>The beginning of a long journey. This is the first chapter of our test book. It contains several paragraphs to test the RSVP reader functionality.</p><p>Another paragraph with a longer word: <b>incomprehensibilities</b> and some punctuation: hello, world! How are you?</p>"),
    ("c2.xhtml", "<h1>Chapter 2</h1><p>The story continues with more text to read. <i>The quick brown fox jumps over the lazy dog.</i></p><p>Multiple sentences here. With some pauses. And questions? Absolutely!</p>"),
    ("c3.xhtml", "<h1>Chapter 3</h1><p>A new chapter brings new adventures. Words of varying length appear: a, an, the, extraordinary, unprecedented.</p><p>Punctuation test: stop. pause; think: reflect! query? ellipsis... done.</p>"),
    ("c4.xhtml", "<h1>Chapter 4</h1><p>Deeper into the book. The plot thickens with every word that appears on the screen.</p><p>This chapter contains more content to ensure the page counting works correctly across chapter boundaries.</p><p>Yet another paragraph. And one more for good measure.</p>"),
    ("c5.xhtml", "<h1>Chapter 5</h1><p>The final chapter. All good things must come to an end. This is the last page of the test book.</p><p>Thank you for reading! The end.</p>"),
]

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
    info = zipfile.ZipInfo("mimetype")
    info.compress_type = zipfile.ZIP_STORED
    zf.writestr(info, mimetype)
    zf.writestr("META-INF/container.xml", container_xml)
    zf.writestr("EPUB/package.opf", package_opf)
    zf.writestr("EPUB/nav.xhtml", nav_xhtml)
    for name, content in chapters:
        zf.writestr(f"EPUB/{name}", content)

with open(OUTPUT, "wb") as f:
    f.write(buf.getvalue())

print(f"Created {OUTPUT} ({os.path.getsize(OUTPUT)} bytes)")