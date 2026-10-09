import io
import os

import numpy as np
import pytest
from PIL import Image

from conftest import ARIAL, HAPO, HARRYP, need
import render_line as rl
import textrender as tr
import worker
from api import FontRef, parse_claim

TEMPLATE = {'widthPx': 800, 'heightPx': 300, 'dpi': 300}


def name_field(x, **kw):
    f = {'field': 'Custom Name', 'layer': '@Custom Name', 'sample': 'Harry', 'font': 'ArialMT', 'sizePx': 80.0,
         'color': '#d4a24c', 'align': 'center', 'box': {'x': x, 'y': 100, 'w': 260, 'h': 100}, 'anchor': 'center',
         'tracking': 0, 'fit': 'shrink',
         'gradient': {'type': 'linear', 'angle': 0, 'scale': 100, 'offset': {'x': 0, 'y': 0}, 'align': True, 'reverse': False,
                      'opacity': 1, 'interpolation': 'perceptual', 'smoothness': 1,
                      'stops': [{'pos': 0, 'color': '#a66b24', 'mid': 0.5}, {'pos': 1, 'color': '#fed98f', 'mid': 0.5}]},
         'bevel': {'technique': 'chiselHard', 'depth': 300, 'direction': 'down', 'size': 3, 'soften': 1, 'angle': 30,
                   'altitude': 30, 'highlight': {'color': '#ffffff', 'opacity': 0.74, 'mode': 'screen'},
                   'shadow': {'color': '#b17017', 'opacity': 0.64, 'mode': 'multiply'}},
         'shadow': {'dx': -8.66, 'dy': 5, 'blur': 5, 'color': '#000000', 'opacity': 1, 'spread': 20}}
    f.update(kw)
    return f


FIELDS = [name_field(40), name_field(480)]


def fonts(_ps):
    return ARIAL


def artwork():
    return Image.new('RGBA', (800, 300), (20, 20, 30, 255))


def test_value_is_drawn_at_every_placement_and_fits():
    need(ARIAL)
    img, preview, info = rl.render_line(artwork(), FIELDS, {'Custom Name': 'Marie-Pier'}, fonts, TEMPLATE)
    assert img.size == (800, 300) and max(preview.size) <= rl.PREVIEW_MAX
    assert [d['value'] for d in info['fields']] == ['Marie-Pier', 'Marie-Pier']
    for f in FIELDS:
        bb = tr.ink_bbox(f, 'Marie-Pier', ARIAL)
        assert bb[0] >= f['box']['x'] - 1 and bb[2] <= f['box']['x'] + f['box']['w'] + 1  # shrink: no overflow
    a = np.asarray(img.convert('RGB'), dtype=int)
    left, right = a[:, 40:300], a[:, 480:740]
    assert np.abs(left - right).mean() < 1.0  # identical placements -> identical pixels
    assert (a[:, 310:460] == [20, 20, 30]).all()  # nothing between the placements but the shadow edge


def test_long_value_shrinks_short_value_keeps_size():
    need(ARIAL)
    _, _, long = rl.render_line(artwork(), FIELDS[:1], {'Custom Name': 'Bartholomew-Alexandria'}, fonts, TEMPLATE)
    _, _, short = rl.render_line(artwork(), FIELDS[:1], {'Custom Name': 'Al'}, fonts, TEMPLATE)
    assert long['fields'][0]['sizePx'] < 40 and any('thu nhỏ' in w for w in long['warnings'])
    assert short['fields'][0]['sizePx'] == 80


def test_shrunk_value_keeps_the_sample_centre():
    need(ARIAL)
    f = FIELDS[0]
    sample = tr.ink_bbox(f, 'HAMM', ARIAL)  # same letter heights so the ink centre is comparable
    long = tr.ink_bbox(f, 'HAMMOND-ALEXANDRIA', ARIAL)
    assert abs((sample[1] + sample[3]) / 2 - (long[1] + long[3]) / 2) <= 6
    assert abs((sample[0] + sample[2]) / 2 - (long[0] + long[2]) / 2) <= 6


def test_deterministic_print_file_with_dpi_and_srgb():
    need(ARIAL)
    a, _, _ = rl.render_line(artwork(), FIELDS, {'Custom Name': 'Rebecca'}, fonts, TEMPLATE)
    b, _, _ = rl.render_line(artwork(), FIELDS, {'Custom Name': 'Rebecca'}, fonts, TEMPLATE)
    png = rl.print_png(a, 300)
    assert png == rl.print_png(b, 300)
    im = Image.open(io.BytesIO(png))
    assert im.size == (800, 300) and round(im.info['dpi'][0]) == 300 and im.info.get('icc_profile')


def test_missing_value_or_font_is_a_render_error():
    need(ARIAL)
    with pytest.raises(rl.RenderError):
        rl.render_line(artwork(), FIELDS, {}, fonts, TEMPLATE)
    with pytest.raises(rl.RenderError):
        rl.render_line(artwork(), FIELDS, {'Custom Name': 'Rebecca'}, lambda ps: None, TEMPLATE)


def test_missing_glyphs_are_warned():
    need(ARIAL)
    _, _, info = rl.render_line(artwork(), FIELDS[:1], {'Custom Name': 'Rebecca 中'}, fonts, TEMPLATE)
    assert any('không có ký tự' in w for w in info['warnings'])


RENDER_CLAIM = {  # shape returned by renderClaimFor() in src/lib/repos/artwork-render.ts
    'job': {'id': 'job9', 'kind': 'RENDER_LINE', 'attempts': 1, 'createdAt': '2026-10-11T00:00:00.000Z'},
    'entry': {'id': 'e1', 'storeId': 's1', 'shopifyProductId': 'gid://shopify/Product/1', 'printTemplateId': 't1',
              'optionKey': '', 'title': 'Tumbler', 'status': 'READY', 'fields': FIELDS},
    'template': {'id': 't1', 'name': 'Tumbler', 'widthPx': 800, 'heightPx': 300, 'dpi': 300, 'bleedIn': 0, 'safeIn': 0,
                 'mirror': False, 'areas': [{'name': 'Print', 'x': 0, 'y': 0, 'w': 800, 'h': 300}]},
    'artwork': {'id': 'art1', 'fileName': 'artwork.png', 'size': 1, 'sha256': None},
    'fonts': [{'postscriptName': 'ArialMT', 'fileId': 'font1', 'sha256': ''}],
    'values': {'Custom Name': 'Marie-Pier'},
    'target': {'orderId': 'o1', 'shopifyLineId': 'l1', 'orderNumber': '#LIT1', 'linePosition': 1, 'taskKey': 'LIT1_1', 'printArea': 'Print'},
}


class FakeApi:
    def __init__(self, art_path):
        self.art_path = art_path
        self.rendered, self.failed = [], []

    def fonts(self):
        return [FontRef('ArialMT', 'font1', '', 'arial.ttf')]

    def download(self, file_id, dest, expect_sha256=None):
        import hashlib
        import shutil
        shutil.copyfile(self.art_path if file_id == 'art1' else ARIAL, dest)
        return hashlib.sha256(open(dest, 'rb').read()).hexdigest()

    def submit_render(self, job_id, result, print_png, preview_jpg):
        self.rendered.append((job_id, result, print_png, preview_jpg))
        return {'ok': True, 'status': 'DONE', 'artworkId': 'a1', 'version': 1}

    def fail(self, job_id, error, permanent=False):
        self.failed.append((job_id, error, permanent))
        return {'ok': True, 'jobStatus': 'FAILED', 'attempts': 1}


def test_render_line_job_end_to_end(tmp_path):
    need(ARIAL)
    art = tmp_path / 'artwork.png'
    artwork().save(art)
    claim = parse_claim(RENDER_CLAIM)
    assert claim.kind == 'RENDER_LINE' and claim.values == {'Custom Name': 'Marie-Pier'} and claim.target['printArea'] == 'Print'
    fake = FakeApi(str(art))
    worker.process(fake, worker.FontCache(fake, tmp_path / 'fonts'), claim, artworks=worker.ArtworkCache(fake, tmp_path / 'art'))
    assert fake.failed == []
    (job_id, result, png, jpg), = fake.rendered
    assert job_id == 'job9' and png[:8] == b'\x89PNG\r\n\x1a\n' and jpg[:3] == b'\xff\xd8\xff'
    assert [f['value'] for f in result['fields']] == ['Marie-Pier', 'Marie-Pier']
    # artwork cached by content hash: a second order for the same entry does not download it again
    assert len(os.listdir(tmp_path / 'art')) == 1


def test_render_line_missing_value_fails_permanently(tmp_path):
    need(ARIAL)
    art = tmp_path / 'artwork.png'
    artwork().save(art)
    claim = parse_claim({**RENDER_CLAIM, 'values': {}})
    fake = FakeApi(str(art))
    worker.process(fake, worker.FontCache(fake, tmp_path / 'fonts'), claim, artworks=worker.ArtworkCache(fake, tmp_path / 'art'))
    (job_id, error, permanent), = fake.failed
    assert permanent and 'Custom Name' in error and fake.rendered == []


def test_hapo_marie_pier_fits_both_sides():
    need(HAPO, HARRYP)
    from parse_psd import parse
    tpl = {'widthPx': 3270, 'heightPx': 1860, 'dpi': 300, 'areas': [{'name': 'Print', 'x': 0, 'y': 0, 'w': 3270, 'h': 1860}]}
    result, art, _ = parse(HAPO, tpl, lambda ps: HARRYP if ps == 'HarryP' else None)
    img, _, info = rl.render_line(art, result['fields'], {'Custom Name': 'Marie-Pier'}, lambda ps: HARRYP, tpl)
    assert len(info['fields']) == 2
    for f in result['fields']:
        bb = tr.ink_bbox(f, 'Marie-Pier', HARRYP)
        assert f['box']['x'] - 1 <= bb[0] and bb[2] <= f['box']['x'] + f['box']['w'] + 1
