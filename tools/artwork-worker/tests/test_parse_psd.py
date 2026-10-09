import pytest

from conftest import CROCS, DC, DES1, HAPO, HAPO_UNNAMED, HARRYP, MALONE, MYRIAD_BOLD, need
from parse_psd import ParseError, field_name, parse, placements


def no_fonts(_ps):
    return None


def by_field(result):
    return {f['field']: f for f in result['fields']}


def test_field_name_strips_at_and_copy_suffix():
    assert field_name('@Custom Name') == 'Custom Name'
    assert field_name('@ Name copy') == 'Name'
    assert field_name('@Name copy 3') == 'Name'
    assert field_name('RACHEL copy') == 'RACHEL'


@pytest.fixture(scope='module')
def des1():
    need(DES1)
    return parse(DES1, None, no_fonts, custom_layers={'mrs', 'mrs copy', 'RACHEL', 'RACHEL copy'})


def test_des1_effect_copies_merge_into_one_field(des1):
    result, artwork, preview = des1
    assert result['status'] == 'NEEDS_FONTS'
    assert sorted(result['missingFonts']) == ['MLTokyoAurora-Bold', 'krustycraft']
    assert result['checkScore'] is None
    f = by_field(result)
    assert set(f) == {'mrs', 'RACHEL'}

    mrs = f['mrs']
    assert mrs['layer'] == 'mrs'  # topmost visible member is the primary
    assert mrs['layers'] == ['mrs copy', 'mrs']
    assert mrs['font'] == 'MLTokyoAurora-Bold'
    assert mrs['sizePx'] == pytest.approx(1000, abs=0.5)
    assert mrs['color'] == '#000000'
    assert mrs['align'] == 'center'
    sh = mrs['shadow']  # contributed by the "mrs copy" layer, global light 153 deg, distance 21
    assert sh['dx'] == pytest.approx(18.71, abs=0.05) and sh['dy'] == pytest.approx(9.53, abs=0.05)
    assert sh['blur'] == 13 and sh['opacity'] == pytest.approx(0.72) and sh['color'] == '#000000'

    rachel = f['RACHEL']
    assert rachel['layer'] == 'RACHEL copy'
    assert rachel['sizePx'] == pytest.approx(600, abs=0.5)
    assert rachel['scaleX'] == pytest.approx(1.1067, abs=0.001)
    assert rachel['tracking'] == 75
    assert len(rachel['charColors']) == 6 and rachel['charColors'][0] == '#dd584f'
    assert rachel['shadow']['dx'] == pytest.approx(18.71, abs=0.05)
    # the paragraph box runs off the canvas; the field box is clipped but stays centred
    b = rachel['box']
    assert b['x'] >= 0 and b['x'] + b['w'] <= 3600
    para_center = (-358.9 + (-358.9 + 4089.72 * 1.1067)) / 2
    assert b['x'] + b['w'] / 2 == pytest.approx(para_center, abs=2)

    assert result['warnings'] == []
    assert artwork.size == (3600, 3600)
    assert max(preview.size) <= 2000


def test_des1_artwork_has_custom_text_removed(des1):
    result, artwork, _ = des1
    box = by_field(result)['mrs']['box']
    region = artwork.convert('RGB').crop((box['x'], box['y'], box['x'] + box['w'], box['y'] + box['h']))
    # "mrs" is solid black text on a light pattern; without it there are almost no black pixels
    dark = sum(1 for p in region.getdata() if max(p) < 40)
    assert dark < 0.02 * region.width * region.height


def test_dc_point_text_size_from_transform():
    need(DC)
    result, _, _ = parse(DC, None, no_fonts, custom_layers={'Mrs'})
    mrs = by_field(result)['Mrs']
    assert mrs['sizePx'] == pytest.approx(292 * 2.12578, abs=0.1)  # FontSize x vertical transform scale
    assert mrs['font'] == 'AlohaMarch'
    assert mrs['color'] == '#ffffff'
    assert result['status'] == 'NEEDS_FONTS' and result['missingFonts'] == ['AlohaMarch']


def test_malone_offset_copy_becomes_hard_shadow_and_warnings():
    need(MALONE)
    result, _, _ = parse(MALONE, None, no_fonts, custom_layers={'MALONE'})
    f = by_field(result)['MALONE']
    assert f['color'] == '#ffffff'
    assert f['shadow']['blur'] == 0 and f['shadow']['color'] == '#000000'
    assert f['shadow']['dx'] == pytest.approx(-6.17, abs=0.05) and f['shadow']['dy'] == pytest.approx(5.56, abs=0.05)
    assert any('rotated' in w for w in result['warnings'])
    assert any('faux bold' in w for w in result['warnings'])
    assert len(result['warnings']) == len(set(result['warnings']))
    assert {t['text'] for t in result['fixedTexts']} == {'who loves', '-better now-'}


def test_no_at_layers_means_no_fields_and_a_warning():
    need(MALONE)
    result, _, _ = parse(MALONE, None, no_fonts)
    assert result['fields'] == []
    assert len(result['fixedTexts']) == 6
    assert any('no custom text layers' in w for w in result['warnings'])
    assert result['status'] == 'NEEDS_REVIEW'


@pytest.fixture(scope='module')
def crocs_ready():
    need(CROCS, MYRIAD_BOLD)
    fonts = {'MyriadPro-Bold': MYRIAD_BOLD}
    return parse(CROCS, {'widthPx': 2894, 'heightPx': 852, 'dpi': 300,
                         'areas': [{'name': 'Front', 'x': 0, 'y': 0, 'w': 2894, 'h': 852}]},
                 fonts.get, custom_layers={'Note'})


def test_crocs_ready_with_installed_font(crocs_ready):
    result, artwork, _ = crocs_ready
    f = by_field(result)['Note']
    assert result['status'] == 'READY', result
    assert result['missingFonts'] == [] and result['warnings'] == []
    assert result['checkScore'] is not None and result['checkScore'] <= 6
    assert f['sizePx'] == pytest.approx(659.99988 * 0.2494966, abs=0.05)
    assert f['stroke'] == {'px': 13.0, 'color': '#ffffff'}
    assert f['align'] == 'left' and f['tracking'] == -10
    assert f['area'] == 'Front'
    assert f['fit'] == 'shrink' and f['anchor'] == 'center'
    assert artwork.size == (2894, 852)


def test_crocs_missing_font_is_needs_fonts():
    need(CROCS)
    result, _, _ = parse(CROCS, None, no_fonts, custom_layers={'Note'})
    assert result['status'] == 'NEEDS_FONTS' and result['missingFonts'] == ['MyriadPro-Bold']
    assert by_field(result)['Note']['box']['w'] > 0


def test_template_scaling_and_size_warning():
    need(CROCS)
    result, artwork, _ = parse(CROCS, {'widthPx': 2894 * 2, 'heightPx': 852 * 2}, no_fonts, custom_layers={'Note'})
    f = by_field(result)['Note']
    assert artwork.size == (5788, 1704)
    assert f['sizePx'] == pytest.approx(2 * 164.67, abs=0.1)
    assert f['stroke']['px'] == pytest.approx(26)
    assert any('template is 5788x1704' in w for w in result['warnings'])


def test_aspect_mismatch_is_an_error():
    need(CROCS)
    with pytest.raises(ParseError):
        parse(CROCS, {'widthPx': 2894, 'heightPx': 2894}, no_fonts, custom_layers={'Note'})


def _info(x0, y0, x1, y1):
    return {'ink': (x0, y0, x1, y1)}


def test_placements_split_far_apart_layers_and_keep_overlapping_copies():
    far = [_info(0, 0, 100, 50), _info(500, 0, 600, 50)]
    assert placements(far) == [[0], [1]]
    copies = [_info(0, 0, 100, 50), _info(4, 4, 104, 54), _info(500, 0, 600, 50), _info(503, 2, 603, 52)]
    assert placements(copies) == [[0, 1], [2, 3]]
    chain = [_info(0, 0, 100, 50), _info(90, 0, 190, 50), _info(180, 0, 280, 50)]
    assert placements(chain) == [[0, 1, 2]]


HAPO_TEMPLATE = {'widthPx': 3270, 'heightPx': 1860, 'dpi': 300, 'areas': [{'name': 'Print', 'x': 0, 'y': 0, 'w': 3270, 'h': 1860}]}


def harryp(ps):
    return HARRYP if ps == 'HarryP' else None


@pytest.fixture(scope='module')
def hapo():
    need(HAPO, HARRYP)
    return parse(HAPO, HAPO_TEMPLATE, harryp)


def test_hapo_same_field_twice_is_two_placements(hapo):
    result, artwork, _ = hapo
    fields = sorted(result['fields'], key=lambda f: f['box']['x'])
    assert [f['field'] for f in fields] == ['Custom Name', 'Custom Name']
    left, right = fields
    assert left['box']['x'] + left['box']['w'] < right['box']['x']
    assert abs(left['box']['y'] - right['box']['y']) <= 1 and left['box']['w'] == pytest.approx(right['box']['w'], abs=2)
    assert 'shadow' in left and 'layers' not in left  # not merged as an effect copy
    assert artwork.size == (3270, 1860)


def test_hapo_layer_styles_are_read(hapo):
    result, _, _ = hapo
    f = result['fields'][0]
    assert f['font'] == 'HarryP' and f['sizePx'] == pytest.approx(300 * 0.97856 * 1.05, abs=0.2)
    assert f['scaleX'] == pytest.approx(1.1052, abs=0.001)
    g = f['gradient']
    assert g['type'] == 'linear' and g['angle'] == 0 and g['scale'] == 81 and g['align'] is True
    assert g['offset'] == {'x': pytest.approx(7.544, abs=0.001), 'y': pytest.approx(-78.79, abs=0.01)}
    assert g['interpolation'] == 'perceptual'
    assert [s['color'] for s in g['stops']] == ['#a66b24', '#fed98f', '#a66b24', '#fbe6b2', '#fbe6b2']
    assert [s['mid'] for s in g['stops']] == [0.5, 0.66, 0.39, 0.77, 0.5]
    assert g['stops'][1]['pos'] == pytest.approx(1148 / 4096, abs=1e-4)
    b = f['bevel']
    assert (b['technique'], b['direction'], b['depth'], b['size'], b['soften']) == ('chiselHard', 'down', 396, pytest.approx(3, abs=0.01), pytest.approx(1, abs=0.01))
    assert (b['angle'], b['altitude']) == (30, 30)  # "use global light": document global angle/altitude
    assert b['highlight'] == {'color': '#ffffff', 'opacity': 0.74, 'mode': 'screen'}
    assert b['shadow'] == {'color': '#b17017', 'opacity': 0.64, 'mode': 'multiply'}
    assert len(b['contour']) == 9
    sh = f['shadow']  # global light 30 deg, distance 10, choke 20 %, size 5 -- effects scale (lfx2 Scl) not applied
    assert sh['dx'] == pytest.approx(-8.66, abs=0.02) and sh['dy'] == pytest.approx(5.0, abs=0.02)
    assert sh['blur'] == pytest.approx(5, abs=0.01) and sh['spread'] == 20


def test_hapo_render_matches_photoshop(hapo):
    result, _, _ = hapo
    assert result['warnings'] == ['PSD is 3271x1861 px, template is 3270x1860 px; positions were scaled']
    assert result['checkScore'] is not None and result['checkScore'] <= 6
    fit = [d['trackingFit'] for d in result['diagnostics'].values()]
    assert fit and all(-30 <= t['to'] <= 0 and t['iouTo'] > t['iouFrom'] for t in fit)


def test_layer_field_mapping_on_an_unnamed_psd():
    need(HAPO_UNNAMED, HARRYP)
    result, _, _ = parse(HAPO_UNNAMED, HAPO_TEMPLATE, harryp, custom_layers={'Harry': 'Custom Name', 'Harry copy': 'Custom Name'})
    assert sorted(f['layer'] for f in result['fields']) == ['Harry', 'Harry copy']
    assert {f['field'] for f in result['fields']} == {'Custom Name'}
    assert result['fixedTexts'] == []
    assert not any('no custom text layers' in w for w in result['warnings'])
