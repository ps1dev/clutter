# Writes manual/sample.png, the indexed image the manual's screenshots use.
# python3 manual/make-sample.py
import math
from pathlib import Path
from PIL import Image

W, H = 192, 128
img = Image.new('P', (W, H), 0)
pal = [(12, 14, 26)]  # 0: night sky
# 1-16: water ramp, dark to light and back, so a cycle reads as flow
for i in range(16):
    t = 0.5 - 0.5 * math.cos(i / 16 * 2 * math.pi)
    pal.append((int(20 + 60 * t), int(60 + 120 * t), int(120 + 135 * t)))
# 17-24: lava/sun rings, dark red to yellow
for i in range(8):
    t = i / 7
    pal.append((int(120 + 135 * t), int(20 + 200 * t), int(10 + 60 * t)))
# 25-26: rock
pal += [(48, 40, 46), (78, 66, 70)]
px = img.load()
for y in range(H):
    for x in range(W):
        if 70 <= x < 120:  # the waterfall: diagonal bands of entries 1-16
            px[x, y] = 1 + ((y + (x - 70) // 3) // 2) % 16
        elif (x - 40) ** 2 + (y - 36) ** 2 < 22 ** 2:  # sun
            d = math.hypot(x - 40, y - 36)
            px[x, y] = 17 + min(7, int((22 - d) / 22 * 8))
        elif y > 90 + 8 * math.sin(x / 9):
            px[x, y] = 25 + ((x // 7 + y // 5) % 2)
img.putpalette([c for rgb in pal for c in rgb])
out = Path(__file__).with_name('sample.png')
img.save(out)
print(out, len(pal), 'entries')
