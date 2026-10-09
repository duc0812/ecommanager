import pytest

from conftest import CROCS, DC, DES1, MALONE, MYRIAD_BOLD, need
from parse_psd import ParseError, field_name, parse


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
