"""Conversion helpers.

Everything runs locally using tools already on macOS:

  images     -> `sips` (Apple's own decoder, handles HEIC and friends)
  documents  -> Quick Look renders a page image; Microsoft Word, if installed,
                is scripted to export a true multi-page PDF
  iWork      -> the PDF preview Pages/Keynote/Numbers embeds in its own files

Nothing is written to disk except a short-lived temp directory that is deleted
as soon as the conversion returns.
"""

import contextlib
import glob
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import zipfile
import zlib

# --- what we accept -------------------------------------------------------

IMAGE_EXTS = ("heic", "heif", "png", "jpg", "jpeg", "tif", "tiff", "gif", "bmp", "webp")
PDF_EXTS = ("pdf",)
WORD_EXTS = ("doc", "docx", "rtf")
IWORK_EXTS = ("pages", "key", "numbers")

INPUT_EXTS = IMAGE_EXTS + PDF_EXTS + WORD_EXTS + IWORK_EXTS

OUTPUT_FORMATS = {"jpg": "jpg", "jpeg": "jpeg", "pdf": "pdf"}

MAX_BYTES = 200 * 1024 * 1024

# Quick Look renders a page into a box this many pixels tall -- roughly 200dpi
# for a Letter page, which keeps text readable.
RENDER_PX = 2400

# Fitting an image to a size budget: quality is lowered first, and only when
# that isn't enough are the pixel dimensions reduced. Each attempt is a `sips`
# run, so the search is bounded.
MIN_QUALITY = 40
MAX_FIT_ATTEMPTS = 18
MIN_EDGE_PX = 120
PDF_OVERHEAD = 1024      # the wrapper a one-page image PDF adds around a JPEG
WORD_TIMEOUT = 60   # export cap, once Word has proven it is responsive
WORD_PROBE = 5      # a modal dialog in Word blocks AppleScript entirely

# Word gives a true multi-page PDF, but only when it is running and not sitting
# behind a sign-in or first-launch dialog. By default we use it only if it is
# already open, so converting a file never launches Word behind your back.
# `--use-word` opts into launching it.
USE_WORD = False


class ConversionError(Exception):
    """Raised when a file could not be converted."""


def kind(filename: str) -> str | None:
    """Classify a file by extension: image / pdf / word / iwork, else None."""
    ext = os.path.splitext(filename)[1].lstrip(".").lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in PDF_EXTS:
        return "pdf"
    if ext in WORD_EXTS:
        return "word"
    if ext in IWORK_EXTS:
        return "iwork"
    return None


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise ConversionError(f"macOS tool '{name}' not found -- this app needs macOS.")
    return path


@contextlib.contextmanager
def _workspace(data: bytes, filename: str):
    """Write the upload to a private temp dir, and remove it afterwards."""
    ext = os.path.splitext(filename)[1].lstrip(".").lower()
    ext = re.sub(r"[^a-z0-9]", "", ext)[:10] or "bin"
    tmpdir = tempfile.mkdtemp(prefix="convertly-")
    try:
        src = os.path.join(tmpdir, "input." + ext)
        with open(src, "wb") as fh:
            fh.write(data)
        yield tmpdir, src
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# --- primitives -----------------------------------------------------------

def _sips(args, timeout=120):
    proc = subprocess.run([_tool("sips")] + args, capture_output=True, timeout=timeout)
    return proc.returncode == 0


def _to_jpeg(src: str, dst: str, quality: int, max_px: int | None = None) -> bool:
    args = ["-s", "format", "jpeg", "-s", "formatOptions", str(quality)]
    if max_px:
        args += ["-Z", str(max_px)]
    return _sips(args + [src, "--out", dst]) and os.path.exists(dst)


def _dimensions(src: str):
    """(width, height) of an image, or None if sips can't say."""
    try:
        proc = subprocess.run(
            [_tool("sips"), "-g", "pixelWidth", "-g", "pixelHeight", src],
            capture_output=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return None
    text = proc.stdout.decode("utf-8", "replace")
    width = re.search(r"pixelWidth:\s*(\d+)", text)
    height = re.search(r"pixelHeight:\s*(\d+)", text)
    return (int(width.group(1)), int(height.group(1))) if width and height else None


def _fit_jpeg(src: str, tmpdir: str, quality: int,
              max_px: int | None, target_bytes: int | None):
    """Encode `src` as JPEG, optionally resized and/or squeezed under a size.

    Returns (jpeg_bytes, note). The note describes anything that was done to
    the image beyond a plain conversion, so the UI can tell the user.
    """
    dst = os.path.join(tmpdir, "fit.jpg")
    size = _dimensions(src)
    longest = max(size) if size else None

    # `sips -Z` enlarges images smaller than the limit, which would be a
    # surprising way to "resize" a photo. Never scale up.
    if max_px and longest:
        max_px = min(max_px, longest)

    attempts = []

    def encode(px, q):
        if not _to_jpeg(src, dst, q, px):
            raise ConversionError("Not a readable image")
        with open(dst, "rb") as fh:
            data = fh.read()
        attempts.append((len(data), px, q, data))
        return data

    def describe(data, q):
        """Say only what actually changed, comparing against the source."""
        width, height, _ = _jpeg_size(data)
        parts = []
        if size and (width, height) != tuple(size):
            parts.append(f"Resized to {width}\u00d7{height}")
        if q < quality:
            parts.append(f"quality {q}" if parts else f"Quality lowered to {q}")
        return ", ".join(parts) if parts else None

    first = encode(max_px, quality)
    if not target_bytes or len(first) <= target_bytes:
        return first, describe(first, quality)

    # Too big. Lower quality at this size, then shrink, and repeat.
    px = max_px or longest
    while len(attempts) < MAX_FIT_ATTEMPTS:
        low, high, best = MIN_QUALITY, quality, None
        while low <= high and len(attempts) < MAX_FIT_ATTEMPTS:
            mid = (low + high) // 2
            data = encode(px, mid)
            if len(data) <= target_bytes:
                best = (data, mid)
                low = mid + 1
            else:
                high = mid - 1
        if best:
            data, used = best
            return data, describe(data, used)

        if px is None:                       # dimensions unknown, can't shrink
            break
        # A JPEG's size tracks its pixel count, so scale by the square root of
        # how far over budget the smallest attempt at this size was.
        floor_size = min(a[0] for a in attempts if a[2] == MIN_QUALITY) or 1
        scale = math.sqrt(target_bytes / floor_size) * 0.92
        next_px = max(MIN_EDGE_PX, int(px * min(scale, 0.9)))
        if next_px >= px or next_px <= MIN_EDGE_PX and px <= MIN_EDGE_PX:
            break
        px = next_px

    # Couldn't reach the target: hand back the smallest we managed and say so.
    smallest = min(attempts, key=lambda a: a[0])
    width, height, _ = _jpeg_size(smallest[3])
    return smallest[3], (f"Could not reach the size limit -- smallest is "
                         f"{_human_size(smallest[0])} at {width}\u00d7{height}")


def _human_size(count: int) -> str:
    """Decimal units, the way Finder shows file sizes on macOS.

    Rounds half up with floor(x + 0.5) rather than round(), which rounds half
    to even: round(2.5) is 2 in Python but Math.round(2.5) is 3 in JavaScript,
    and the two front ends have to agree. See shared/spec/file-sizes.json.
    """
    if count < 1_000_000:
        return f"{max(1, math.floor(count / 1000 + 0.5))} KB"
    return f"{count / 1_000_000:.1f} MB"


def _quicklook(src: str, size: int, timeout: int = 30) -> bytes | None:
    """Render a file's first page with Quick Look. Returns PNG bytes.

    Quick Look can take a very long time to admit defeat on a file type it has
    no generator for, so the timeout matters.
    """
    outdir = tempfile.mkdtemp(prefix="convertly-ql-")
    try:
        subprocess.run(
            [_tool("qlmanage"), "-t", "-s", str(size), "-o", outdir, src],
            capture_output=True, timeout=timeout,
        )
        made = glob.glob(os.path.join(outdir, "*.png"))
        if not made:
            return None
        with open(made[0], "rb") as fh:
            return fh.read()
    except subprocess.TimeoutExpired:
        return None
    finally:
        shutil.rmtree(outdir, ignore_errors=True)


def _render_page1(src: str, tmpdir: str, quality: int, size: int = RENDER_PX,
                  max_px: int | None = None, target_bytes: int | None = None):
    """First page of a document as JPEG bytes. Returns (bytes, note)."""
    png = _quicklook(src, size)
    if not png:
        raise ConversionError("Could not render this document")
    png_path = os.path.join(tmpdir, "page1.png")
    with open(png_path, "wb") as fh:
        fh.write(png)
    # Fit from the lossless render rather than re-encoding a JPEG twice.
    return _fit_jpeg(png_path, tmpdir, quality, max_px, target_bytes)


def _pdf_page_count(data: bytes) -> int | None:
    """Best-effort page count. Returns None when it can't tell."""
    pattern = re.compile(rb"/Type\s*/Page[^s]")
    count = len(pattern.findall(data))
    # Modern PDFs pack objects into compressed streams, so also look inside them.
    for match in re.finditer(rb"stream\r?\n", data):
        chunk = data[match.end():match.end() + 2_000_000]
        try:
            # Bounded output: a "zip bomb" stream must not exhaust memory.
            count += len(pattern.findall(
                zlib.decompressobj().decompress(chunk, 8_000_000)))
        except zlib.error:
            continue
    return count or None


def _word_responsive() -> bool:
    """True only if Word is usable right now, without launching or blocking."""
    running = subprocess.run(["/usr/bin/pgrep", "-x", "Microsoft Word"],
                             capture_output=True).returncode == 0
    if not running and not USE_WORD:
        return False
    try:
        # If Word is showing a modal dialog this never answers -- so cap it hard
        # and treat silence as "not available" rather than waiting on it.
        return subprocess.run(
            ["/usr/bin/osascript", "-e",
             'tell application id "com.microsoft.Word" to count documents'],
            capture_output=True, timeout=WORD_PROBE,
        ).returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def _word_to_pdf(src: str, tmpdir: str) -> bytes | None:
    """Ask Microsoft Word to export a real PDF. None if that isn't possible."""
    if not _word_responsive():
        return None

    dst = os.path.join(tmpdir, "word.pdf")
    script = f'''
        set src to POSIX file "{src}"
        set dst to POSIX file "{dst}"
        tell application id "com.microsoft.Word"
            set wasRunning to running
            open src
            save as active document file name (dst as string) file format format PDF
            close active document saving no
            if not wasRunning then quit saving no
        end tell
    '''
    try:
        subprocess.run(
            ["/usr/bin/osascript", "-e", script],
            capture_output=True, timeout=WORD_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return None
    if not os.path.exists(dst) or os.path.getsize(dst) == 0:
        return None
    with open(dst, "rb") as fh:
        return fh.read()


def _iwork_preview(src: str):
    """Pull the preview Pages/Keynote/Numbers stores inside its own document.

    Returns (bytes, "pdf") or (bytes, "image"), or raises.
    """
    try:
        with zipfile.ZipFile(src) as zf:
            names = zf.namelist()
            for want in ("QuickLook/Preview.pdf", "preview.pdf", "Preview.pdf"):
                if want in names:
                    return zf.read(want), "pdf"
            for name in names:
                if name.lower().endswith(("quicklook/preview.jpg", "preview.jpg")):
                    return zf.read(name), "image"
    except (zipfile.BadZipFile, OSError):
        raise ConversionError("This iWork file could not be opened")
    raise ConversionError("No preview stored in this file -- export it from Pages instead")


# --- the entry point ------------------------------------------------------

def _budget_for(out_format: str, target_bytes: int | None):
    """A PDF wraps the JPEG, so the image itself gets a slightly smaller budget."""
    if not target_bytes or out_format != "pdf":
        return target_bytes
    return max(1024, target_bytes - PDF_OVERHEAD)


def _join(*notes):
    """Combine caveats into one line, dropping the empty ones."""
    return " \u00b7 ".join(n for n in notes if n) or None


def convert(data: bytes, filename: str, out_format: str, quality: int = 85,
            max_px: int | None = None, target_bytes: int | None = None):
    """Convert an upload. Returns (bytes, extension, note).

    `max_px` caps the longest edge of the image; `target_bytes` squeezes the
    result under a size budget by lowering quality and, if that isn't enough,
    the dimensions. `note` is a short caveat to show the user, or None.
    """
    if out_format not in OUTPUT_FORMATS:
        raise ConversionError(f"Unsupported output format: {out_format}")
    if not data:
        raise ConversionError("Empty file")
    if len(data) > MAX_BYTES:
        raise ConversionError("File is larger than 200 MB")

    what = kind(filename)
    if what is None:
        raise ConversionError("Unsupported file type")
    quality = max(1, min(100, int(quality)))
    ext = OUTPUT_FORMATS[out_format]

    with _workspace(data, filename) as (tmpdir, src):
        if what == "iwork":
            inner, inner_kind = _iwork_preview(src)
            name = "preview.pdf" if inner_kind == "pdf" else "preview.jpg"
            payload, ext, inner_note = convert(inner, name, out_format, quality,
                                               max_px, target_bytes)
            note = "From the preview stored in the document"
            if inner_note and inner_note.startswith("First page"):
                note = f"{inner_note}; from the document's stored preview"
            return payload, ext, note

        if what == "image":
            budget = _budget_for(out_format, target_bytes)
            jpeg, note = _fit_jpeg(src, tmpdir, quality, max_px, budget)
            if out_format == "pdf":
                return jpeg_to_pdf(jpeg), ext, note
            return jpeg, ext, note

        if what == "pdf":
            if out_format == "pdf":
                return data, ext, "Already a PDF -- copied unchanged"
            pages = _pdf_page_count(data)
            note = f"First page only ({pages} pages in the PDF)" if pages and pages > 1 else None
            jpeg, fit_note = _render_page1(src, tmpdir, quality,
                                           max_px=max_px, target_bytes=target_bytes)
            return jpeg, ext, _join(note, fit_note)

        # Word: a real export if Word is around, otherwise a rendered page.
        exported = _word_to_pdf(src, tmpdir)
        if exported:
            if out_format == "pdf":
                return exported, ext, None
            pages = _pdf_page_count(exported)
            pdf_path = os.path.join(tmpdir, "exported.pdf")
            with open(pdf_path, "wb") as fh:
                fh.write(exported)
            note = f"First page only ({pages} pages in the document)" if pages and pages > 1 else None
            jpeg, fit_note = _render_page1(pdf_path, tmpdir, quality,
                                           max_px=max_px, target_bytes=target_bytes)
            return jpeg, ext, _join(note, fit_note)

        budget = _budget_for(out_format, target_bytes)
        jpeg, fit_note = _render_page1(src, tmpdir, quality,
                                       max_px=max_px, target_bytes=budget)
        note = _join("First page only -- open this in Microsoft Word for a full export",
                     fit_note)
        return (jpeg_to_pdf(jpeg), ext, note) if out_format == "pdf" else (jpeg, ext, note)


def thumbnail(data: bytes, filename: str, px: int = 240) -> bytes | None:
    """A small JPEG preview of an upload, or None if we can't make one."""
    if not data or len(data) > MAX_BYTES or kind(filename) is None:
        return None
    what = kind(filename)
    try:
        with _workspace(data, filename) as (tmpdir, src):
            dst = os.path.join(tmpdir, "thumb.jpg")
            if what == "image":
                if _to_jpeg(src, dst, 70, max_px=px):
                    with open(dst, "rb") as fh:
                        return fh.read()
                return None

            if what == "iwork":
                # Go straight to the embedded preview: without Pages installed
                # Quick Look grinds for a minute before failing on these.
                try:
                    inner, inner_kind = _iwork_preview(src)
                    name = "preview.pdf" if inner_kind == "pdf" else "preview.jpg"
                    return thumbnail(inner, name, px)
                except ConversionError:
                    return None

            png = _quicklook(src, px, timeout=15)
            if png is None:
                return None
            png_path = os.path.join(tmpdir, "thumb.png")
            with open(png_path, "wb") as fh:
                fh.write(png)
            if _to_jpeg(png_path, dst, 70, max_px=px):
                with open(dst, "rb") as fh:
                    return fh.read()
            return None
    except ConversionError:
        return None


# --- PDF writing ----------------------------------------------------------

def _jpeg_size(jpeg: bytes):
    """Return (width, height, components) by reading the JPEG's frame header."""
    i = 2  # skip SOI
    while i < len(jpeg) - 9:
        if jpeg[i] != 0xFF:
            i += 1
            continue
        marker = jpeg[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack(">H", jpeg[i + 2:i + 4])[0]
        # SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", jpeg[i + 5:i + 9])
            return width, height, jpeg[i + 9]
        i += 2 + length
    raise ConversionError("Could not read image dimensions")


PAGE_W, PAGE_H = 612.0, 792.0  # US Letter, in points
MARGIN = 18.0


def jpeg_to_pdf(jpeg: bytes) -> bytes:
    """Wrap a JPEG in a one-page PDF, embedding its bytes without recompressing."""
    width, height, comps = _jpeg_size(jpeg)
    colorspace = {1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK"}.get(comps, "/DeviceRGB")

    # Page follows the image's orientation, image is scaled to fit inside it.
    page_w, page_h = (PAGE_W, PAGE_H) if height >= width else (PAGE_H, PAGE_W)
    scale = min((page_w - 2 * MARGIN) / width, (page_h - 2 * MARGIN) / height)
    draw_w, draw_h = width * scale, height * scale
    off_x, off_y = (page_w - draw_w) / 2, (page_h - draw_h) / 2

    content = f"q {draw_w:.2f} 0 0 {draw_h:.2f} {off_x:.2f} {off_y:.2f} cm /Im0 Do Q\n".encode()

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_w:.2f} {page_h:.2f}] "
            f"/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"
        ).encode(),
        (
            f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
            f"/ColorSpace {colorspace} /BitsPerComponent 8 /Filter /DCTDecode "
            f"/Length {len(jpeg)} >>"
        ).encode() + b"\nstream\n" + jpeg + b"\nendstream",
        f"<< /Length {len(content)} >>".encode() + b"\nstream\n" + content + b"endstream",
    ]

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for num, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return bytes(out)
