#!/usr/bin/env python3
"""Turn the near-white background of a logo PNG transparent, without leaving
a white fringe around the silhouette.

Strategy: two passes.

  Pass 1 — Region flood-fill from every corner with a WIDE tolerance so we
  catch not only pure white but every anti-aliased pixel that's mostly-white.
  Anything reachable from a corner via a chain of near-white pixels is marked
  as "background region".

  Pass 2 — For every background-region pixel, compute an alpha proportional
  to how NON-white it is (pure white -> 0, saturated color -> 255), then
  UNMIX the RGB from a white background. The undoes the alpha-compositing
  the renderer originally applied when it laid the foreground over the
  background, restoring the true unpremultiplied foreground color at the
  silhouette edge. That kills the white halo.

  Formula for unmatting from a white background:
      C_final = C_source * a + 1.0 * (1 - a)      (compositing eq)
   => C_source = (C_final - (1 - a)) / a          (solve for C_source)

Usage:  python3 logo-alpha.py <in.png> <out.png>
"""
import sys
from collections import deque
from PIL import Image

# Pixels within this per-channel distance of pure white are "candidates" for
# being in the background region. Widened from 20 -> 40 so anti-aliased edge
# pixels (which are still noticeably light-grey/light-green) get pulled in.
BG_TOL = 40


def is_bg_candidate(r: int, g: int, b: int) -> bool:
    return r >= 255 - BG_TOL and g >= 255 - BG_TOL and b >= 255 - BG_TOL


def unmix_from_white(c: int, a_float: float) -> int:
    """Recover the source color that composited over white to give c."""
    if a_float <= 0.001:
        return c
    val = (c / 255.0 - (1.0 - a_float)) / a_float
    return max(0, min(255, int(round(val * 255))))


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    img = Image.open(src).convert("RGBA")
    w, h = img.size
    px = img.load()
    assert px is not None

    # Pass 1: flood-fill from corners with the wide tolerance.
    in_bg_region = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()
    for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        r, g, b, _ = px[x, y]
        if is_bg_candidate(r, g, b):
            q.append((x, y))
            in_bg_region[y * w + x] = 1
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not in_bg_region[ny * w + nx]:
                nr, ng, nb, _ = px[nx, ny]
                if is_bg_candidate(nr, ng, nb):
                    in_bg_region[ny * w + nx] = 1
                    q.append((nx, ny))

    # Pass 2: for every bg-region pixel, compute alpha from how NOT-white it
    # is, and unmix RGB from a white background. Pure white -> alpha 0.
    # Slightly-off-white anti-aliased edges -> partial alpha with cleaned RGB.
    cleared = 0
    softened = 0
    for y in range(h):
        for x in range(w):
            if not in_bg_region[y * w + x]:
                continue
            r, g, b, a = px[x, y]
            # "Whiteness" 0..1: 1 = pure white. Use min-channel distance from
            # 255 as the signal (min channel captures saturation better than
            # brightness — light green (200, 240, 200) is more white-ish than
            # cream (240, 240, 220)).
            not_white = (255 - min(r, g, b)) / 255.0  # 0 = pure white
            # Threshold: only anti-aliased/near-white pixels get partial alpha,
            # everything genuinely white (not_white < ~0.06) is fully transparent.
            if not_white < 0.06:
                px[x, y] = (r, g, b, 0)
                cleared += 1
                continue
            # Ramp from not_white=0.06 -> alpha 0 to not_white=0.35 -> alpha 255.
            new_alpha_f = min(1.0, max(0.0, (not_white - 0.06) / (0.35 - 0.06)))
            if new_alpha_f >= 1.0:
                # Genuinely saturated even though it was in the flood region
                # (rare — e.g. the ground shadow). Leave RGB alone, keep alpha.
                continue
            # Partially transparent: unmix RGB from white.
            nr = unmix_from_white(r, new_alpha_f)
            ng = unmix_from_white(g, new_alpha_f)
            nb = unmix_from_white(b, new_alpha_f)
            px[x, y] = (nr, ng, nb, int(round(new_alpha_f * a)))
            softened += 1

    img.save(dst, "PNG", optimize=True)
    total = w * h
    print(f"total={total}  fully cleared={cleared} ({cleared/total:.1%})  "
          f"edge-softened+unmixed={softened} ({softened/total:.1%})  -> {dst}")


if __name__ == "__main__":
    main()
