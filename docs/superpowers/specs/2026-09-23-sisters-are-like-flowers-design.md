# Sisters Are Like Flowers — an original clip-art product

Date: 2026-09-23. Status: approved in chat.

## Goal

A new Litzzy product with our own artwork, built on the personaliser structure of the Customall
clone cm-01 (Festive Sister Love): 9 templates for 2–10 people, a clip-art pick and a name per
person, a title choice with a Custom option. Only the artwork, words and font change. The
Customall clone tool is not modified; the product is new data (a catalogue + payload) that the
existing `cm-builder` runtime draws.

## Decisions (user, in chat)

- Same frame, new theme: **Sisters are like flowers**.
- Clip-art: **12 birth-month flowers** — Carnation (Jan), Violet (Feb), Daffodil (Mar), Daisy (Apr),
  Lily of the Valley (May), Rose (Jun), Larkspur (Jul), Gladiolus (Aug), Aster (Sep),
  Marigold (Oct), Chrysanthemum (Nov), Narcissus (Dec). Picker label "January – Carnation".
- Style: **watercolour with a fine outline** (reads on clear glass).
- Title choices: Sisters / Besties / Siblings / Custom + "are like flowers";
  sub-line **"We may bloom in different ways, but our roots are the same."**
- Price: source prices $19.99 / $24.99 / $28.99 until the owner says otherwise; DRAFT first.

## Artwork

| Piece | Size | Made by |
|---|---|---|
| 12 flowers | square PNG, transparent, ≥1600 px | GPT Image 2 (kie.ai), background removed; 3 samples approved first |
| Title plates ×4 | 992×992 artwork units, rendered at 2976 px | watercolour floral frame (AI) + text set in code with the chosen fonts |
| Picker thumbnails | 200 px | from the finals |
| Template tiles 2–10 | 200 px | code |
| Preview mockup | 1200×1200 | AI photo of a blank beveled round glass ornament on a tree; print area measured |
| Product photos | 5–7 | composites of the design in AI scenes |

Fonts from Google Fonts (OFL): a script face for the title word and names, a light caps face for
the sub-line; the owner picks from 2–3 pairs.

## Build

1. `remix` script: read cm-01's catalogue, keep templates/layers/conditions/geometry, replace
   categories (one flower category of 12 items used by every flower slot), title items, template
   thumbs, mockup, fonts; write `catalogue.json`.
2. Upload with the tool's `assets.py`, payload to theme with `theme_upsert.py`, product via
   productSet (DRAFT), metafield `custom.cm_payload`, template `clip-art-version-01`.
3. QA: `qa_page.py` checks (desktop, phone, order properties) plus a visual review of renders at
   2, 5 and 10 people by the owner. No parity (there is no source).

Originals, fonts and the catalogue are archived in `D:\Ecom manager\clipart-originals\sisters-flowers\`.
