#!/usr/bin/env python3
"""Fetch the source packs into assets-src/ (git-ignored):

  rocketbox/  Microsoft Rocketbox avatars + animations (MIT) — hard-linked from ~/ApexGP when
              that checkout already has them, else downloaded from GitHub raw.
  polyhaven/  Poly Haven HDRI skies and PBR textures (CC0).

Then `node tools/build_assets.mjs` converts them into public/.
"""
import json, os, sys, urllib.request, concurrent.futures as cf

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'assets-src')
APEX = os.path.expanduser('~/ApexGP/assets-src/rocketbox')
RAW = 'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets/'

# ---------------------------------------------------------------------------------------- rocketbox
PLAYERS = ['Professions/Sports_Male_04', 'Professions/Sports_Male_02', 'Professions/Sports_Male_03',
           'Professions/Sports_Female_02']
STAFF = ['Professions/Business_Male_02', 'Professions/Business_Female_01', 'Professions/Security_Male_01',
         'Children/Male_Child_01', 'Children/Female_Child_01', 'Children/Male_Child_02', 'Children/Female_Child_02']
CROWD = [f'Adults/Male_Adult_{i:02d}' for i in range(1, 17)] + [f'Adults/Female_Adult_{i:02d}' for i in range(1, 13)]
AVATARS = PLAYERS + STAFF + CROWD

STATIC = ['idle_neutral_01', 'idle_neutral_02', 'idle_breathe_01', 'idle_look_around_01', 'idle_waiting_01',
          'cheer_01', 'cheer_03', 'cheer_04', 'cheer_05', 'claphands_01', 'claphands_02', 'wave_01',
          'gestic_shrug_01', 'idle_angry_01', 'idle_dust_01', 'crouch_idle', 'crouch_in', 'crouch_out',
          'sit_chair_idle_neutral_01', 'sit_chair_breathe_01', 'sit_chair_idle_look_around',
          'sit_chair_idle_waiting_01', 'sit_chair_gestic_thoughtful', 'gestic_talk_neutral_01', 'take_picture']
XY = ['walk_neutral_01', 'walk_fast_01', 'run_slow_01', 'run_neutral_01', 'run_fast_01', 'run_start', 'run_stop']


def get(url, dst):
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return 0
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'centercourt'})
    with urllib.request.urlopen(req) as r, open(dst + '.part', 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(dst + '.part', dst)
    return os.path.getsize(dst)


def link(src, dst):
    if os.path.exists(dst):
        return True
    if not os.path.exists(src):
        return False
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        import shutil
        shutil.copy2(src, dst)
    return True


def rocketbox_jobs():
    tree = json.load(open(TREE)) if os.path.exists(TREE) else None
    paths = [x['path'] for x in tree['tree']] if tree else []
    jobs = []
    for a in AVATARS:
        name = a.split('/')[-1]
        want = [p for p in paths if p.startswith(f'Assets/Avatars/{a}/') and
                (p.endswith('.tga') or (p.endswith('.fbx') and not p.endswith('_facial.fbx')))]
        for p in want:
            fn = p.split('/')[-1]
            dst = os.path.join(SRC, 'rocketbox', 'avatars', name, fn)
            if not link(os.path.join(APEX, 'avatars', name, fn), dst):
                jobs.append((RAW + p[len('Assets/'):], dst))
    for folder, clips in [('all_animations_max_motextr_static', STATIC), ('all_animations_max_motextr_xy', XY)]:
        for c in clips:
            for g in 'mf':
                fn = f'{g}_{c}.max.fbx'
                if not any(p.endswith('/' + folder + '/' + fn) for p in paths):
                    continue
                dst = os.path.join(SRC, 'rocketbox', 'anims', fn)
                # ApexGP keeps static and xy clips in one folder; only reuse same-folder files
                if folder.endswith('static') and link(os.path.join(APEX, 'anims', fn), dst):
                    continue
                jobs.append((RAW + f'Animations/{folder}/{fn}', dst))
    return jobs


# ---------------------------------------------------------------------------------------- poly haven
HDRIS = {  # our name: (poly haven id, resolution)
    'day': ('kloofendal_48d_partly_cloudy_puresky', '4k'),
    'overcast': ('kloofendal_overcast_puresky', '4k'),
    'sunset': ('qwantani_sunset_puresky', '4k'),
    'night': ('qwantani_night_puresky', '4k'),
}
TEXTURES = {  # poly haven id: maps
    'coast_sand_01': ['diff', 'nor_gl', 'rough'],
    'concrete_floor_worn_001': ['diff', 'nor_gl', 'rough'],
    'rubber_tiles': ['diff', 'nor_gl', 'rough'],
}


def polyhaven_jobs():
    jobs = []
    for name, (pid, res) in HDRIS.items():
        jobs.append((f'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/{res}/{pid}_{res}.hdr',
                     os.path.join(SRC, 'polyhaven', 'hdri', f'{name}.hdr')))
    for pid, maps in TEXTURES.items():
        try:
            files = json.load(urllib.request.urlopen(urllib.request.Request(
                f'https://api.polyhaven.com/files/{pid}', headers={'User-Agent': 'centercourt'})))
        except Exception as e:  # noqa
            print('skip', pid, e)
            continue
        for m in maps:
            key = {'diff': 'Diffuse', 'nor_gl': 'nor_gl', 'rough': 'Rough'}[m]
            node = files.get(key) or files.get(m)
            if not node:
                print('no map', pid, m)
                continue
            f = node['2k'].get('jpg') or node['2k'].get('png')
            jobs.append((f['url'], os.path.join(SRC, 'polyhaven', 'tex', f'{pid}_{m}.' + f['url'].rsplit('.', 1)[1])))
    return jobs


TREE = os.path.join(SRC, 'rocketbox_tree.json')
if __name__ == '__main__':
    os.makedirs(SRC, exist_ok=True)
    if not os.path.exists(TREE):
        get('https://api.github.com/repos/microsoft/Microsoft-Rocketbox/git/trees/master?recursive=1', TREE)
    jobs = rocketbox_jobs() + polyhaven_jobs()
    print(len(jobs), 'files to download', flush=True)
    tot = 0
    with cf.ThreadPoolExecutor(8) as ex:
        for i, n in enumerate(ex.map(lambda j: get(*j), jobs)):
            tot += n
            if i % 20 == 0:
                print(i, f'{tot / 1e6:.0f} MB', flush=True)
    print('done', f'{tot / 1e6:.0f} MB')
