"""Generate the extension's PNG icons (no third-party dependencies)."""
import struct, zlib, os, sys

def rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

# Shapes in a 16x16 design space: (x0, y0, x1, y1, radius, rgb)
SHAPES = [
    (0, 0, 16, 16, 4, (45, 127, 249)),
    (4, 4, 12, 6, 1, (255, 107, 107)),
    (4, 7, 9.5, 9, 1, (255, 255, 255)),
    (4, 10, 11, 12, 1, (74, 222, 128)),
]

def render(size, ss=4):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * 16 / size
                    y = (py + (sy + 0.5) / ss) * 16 / size
                    col = None
                    for x0, y0, x1, y1, r, rgb in SHAPES:
                        if rrect(x, y, x0, y0, x1, y1, r):
                            col = rgb
                    if col:
                        acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 1
            n = ss * ss
            a = acc[3]
            if a:
                row += bytes([acc[0] // a, acc[1] // a, acc[2] // a, round(255 * a / n)])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "icons")
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f"icon{s}.png"), "wb") as f:
        f.write(render(s))
print("icons written to", os.path.abspath(out))
