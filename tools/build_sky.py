#!/usr/bin/env python3
"""Poly Haven HDRIs (assets-src/polyhaven/hdri/*.hdr, 4k) → public/sky/:

  <name>_bg.jpg    4096×1024 sRGB, the upper hemisphere only (the background), stored as
                   linear × scale (see sky.json) so the page can bring the radiance back
  sky.json         per sky: bg scale, the sun's direction (brightest texel), mean radiance

ffmpeg decodes the RGBE files to 32-bit float; numpy does the rest.
"""
import json, os, subprocess, sys
import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'assets-src', 'polyhaven', 'hdri')
OUT = os.path.join(ROOT, 'public', 'sky')


def read_hdr(path):
    w, h = 4096, 2048
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                            '-of', 'csv=p=0', path], capture_output=True, text=True).stdout.strip().split(',')
    w, h = int(probe[0]), int(probe[1])
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-'],
                         capture_output=True).stdout
    a = np.frombuffer(raw, dtype=np.float32).reshape(3, h, w)  # planes g, b, r
    return np.stack([a[2], a[0], a[1]], axis=-1)


def write_hdr(path, img):
    h, w, _ = img.shape
    mx = img.max(axis=-1)
    e = np.zeros_like(mx, dtype=np.int32)
    m = np.zeros_like(mx)
    nz = mx > 1e-32
    m[nz], e[nz] = np.frexp(mx[nz])
    scale = np.zeros_like(mx)
    scale[nz] = m[nz] * 256.0 / mx[nz]
    rgbe = np.zeros((h, w, 4), dtype=np.uint8)
    rgbe[..., :3] = np.clip(img * scale[..., None], 0, 255).astype(np.uint8)
    rgbe[..., 3] = np.where(nz, e + 128, 0).astype(np.uint8)
    with open(path, 'wb') as f:
        f.write(b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n')
        f.write(f'-Y {h} +X {w}\n'.encode())
        f.write(rgbe.tobytes())  # flat (uncompressed) scanlines


def box_down(img, f):
    h, w, c = img.shape
    return img.reshape(h // f, f, w // f, f, c).mean(axis=(1, 3))


def lin2srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


os.makedirs(OUT, exist_ok=True)
meta = {}
for fn in sorted(os.listdir(SRC)):
    if not fn.endswith('.hdr'):
        continue
    name = fn[:-4]
    img = read_hdr(os.path.join(SRC, fn))
    h, w, _ = img.shape
    # sun: the brightest texel of a blurred copy (direction in three's equirect convention)
    lum = img @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    small = box_down(lum[..., None], 8)[..., 0]
    y, x = np.unravel_index(np.argmax(small), small.shape)
    u, v = (x + 0.5) / small.shape[1], (y + 0.5) / small.shape[0]
    phi, theta = (u - 0.5) * 2 * np.pi, (0.5 - v) * np.pi  # azimuth, elevation
    # three's equirect: dir = (−cos(el)·cos(az'), sin(el), cos(el)·sin(az'))… keep raw u/v; the page converts
    peak = float(small.max())
    # the sun's irradiance (normal incidence) and colour: every texel far brighter than the sky
    # within 6 degrees of the peak, times its solid angle
    yy, xx = np.mgrid[0:h, 0:w]
    el = (0.5 - (yy + 0.5) / h) * np.pi
    az = ((xx + 0.5) / w - 0.5) * 2 * np.pi
    sd = np.array([np.cos(theta) * np.cos(phi), np.sin(theta), np.cos(theta) * np.sin(phi)])
    d = np.stack([np.cos(el) * np.cos(az), np.sin(el), np.cos(el) * np.sin(az)], axis=-1)
    near = (d @ sd) > np.cos(np.radians(6))
    sky_ref = float(np.percentile(lum[: h // 2], 99.0))
    hot = near & (lum > sky_ref * 4)
    domega = (2 * np.pi / w) * (np.pi / h) * np.cos(el)
    sunE = (img * (domega * hot)[..., None]).reshape(-1, 3).sum(axis=0)
    # the sky's own irradiance on a horizontal surface, sun texels removed
    up = np.clip(d[..., 1], 0, None)
    skyE = (img * (domega * up * (~hot))[..., None]).reshape(-1, 3).sum(axis=0)
    # background: upper hemisphere (plus a sliver below the horizon), linear × scale → sRGB jpg
    top = img[: h // 2 + h // 32]
    sky_lum = lum[: h // 2]
    # scale: the 99.7th percentile of the sky (sun excluded by the percentile) lands at 0.92
    p = float(np.percentile(sky_lum, 99.7))
    scale = 0.92 / max(p, 1e-6)
    bg = lin2srgb(top * scale)
    Image.fromarray((bg * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, f'{name}_bg.jpg'), quality=90,
                                                           optimize=True, progressive=True)
    mean = img.reshape(-1, 3).mean(axis=0)
    meta[name] = {'scale': round(scale, 6), 'sunE': [round(float(c), 4) for c in sunE],
                  'skyE': [round(float(c), 4) for c in skyE], 'sunUV': [round(float(u), 5), round(float(v), 5)],
                  'sunElevDeg': round(float(np.degrees(theta)), 2), 'sunPeak': round(peak, 2),
                  'mean': [round(float(c), 4) for c in mean], 'bgRows': int(top.shape[0]), 'rows': h}
    print(name, meta[name], flush=True)
json.dump(meta, open(os.path.join(OUT, 'sky.json'), 'w'), indent=1)
