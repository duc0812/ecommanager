# Customall clone tool — design

Date: 2026-09-23. Status: approved in chat, first product in progress.

## Goal

Clone a personalised product whose storefront personaliser is **Customall** (customall.io) onto
Litzzy (caramiaus-store, Minimog), the way `cloning-clipart-customizers-litzzy` does it for
Customily: one command from source link to a product on the clip-art page, stopping on
anything that does not check out.

First product: Wrappiness "Festive Sister Love - Personalized Glass Ornament"
(`wrappiness-us.myshopify.com`, product 10056917582112).

## Decisions made with the user

- **Grow by demand.** The first version implements what the first product uses. A later
  product that needs more is stopped at the crawl by the capability table and the rule is
  added then, keyed to Customall's own data flags, never to a store or a product.
- **Independent from the Customily tool.** Own skill folder, own runtime, own register. Code
  that is useful from the old tool is copied and adapted, never imported, so a change on one
  side cannot break the other.
- **Shared product page.** Clones go on the existing store-wide templates
  `clip-art-version-01` / `-02`. That is the only coupling, described under *Storefront*.

## How Customall serves a product (reverse-engineered 2026-09-23)

- Requests go to `https://apis-v2.customall.io/app/<hex>.json`. `<hex>` is a JSON object XORed
  byte-wise with `0x47` and hex-encoded, e.g. `{"uri":"hash/<shop>/<productId>"}`.
- The response is `{"data": s}`; `s` is `lz-string` `compressToBase64` of a `jsonpack` string.
- URIs seen: `hash/<shop>/<pid>` → `{hash}`; `<shop>/<pid>/<hash>` → the campaign;
  `store/<storeId>` → store display settings; `cats/<categoryId>` → a clip-art category;
  `clis/<categoryId>` → its clip-art items.
- Images: `https://assets-v2.customall.io/<hex>` where the hex encodes
  `{"key": "<file key>", "width": n, "unit": "px", "webp": bool, "trim": bool}`.
- Campaign shape (the parts used):
  - `artworks[]` `{id, width, height, templateDisplayLabel, templateDisplayMode, templates[]}`;
    a template is `{title, thumbnail, layers[]}`. Choosing a template is itself a form field
    (here "Number Of Butterflies", 9 templates).
  - A layer is Konva-like: `type` Image|Text, `x, y, width, height, rotation, scaleX/Y,
    crop*`, `visible`, `values[]` (static art / default text), `condition`
    `{action, enable, match, rules[{logic, option, value}]}`, and `personalized` when it is a
    form field: images `type: clipartCategory` (label, `clipartCategory`, defaults); text
    (label, placeholder, `max`, `required`, `text_suffix`, `max_font_size`, `autofit`).
    Text also has `fontFamily`, `fontSize`, `fill`, `align`, `letterSpacing`, `lineHeight`.
  - `settings.default[artworkId]` default value per layer id, `settings.ordering[artworkId]`
    field order per template, `settings.attributes` variant attributes (Size).
  - `variants[]` map Shopify variant ids to print areas and artworks; `mockups[]` place the
    print area on product pictures; `images[]` are the listing photos.

## Tool

`~/.claude/skills/cloning-customall-litzzy/`

| File | Job |
|---|---|
| `scripts/customall_api.py` | encode, fetch, decode; the only place that knows the wire format |
| `scripts/extract.py` | campaign + categories + items → `catalogue.json` (Customall's model, trimmed), the capability table, WARNINGs |
| `tool/clone.py` | stages crawl → product → assets → theme → pdp → attach → verify → record → qa → publish, resumable via `tool-state.json` |
| `theme/cm-builder.js`, `cm-builder.css` | the storefront runtime |
| `scripts/qa*.py`, `qa.js` | copied from the Customily tool and adapted |

Register: `D:\Ecom manager\customall-clones\<slug>\` (catalogue, payload, clone.json, qa/).
Uploaded art is named `cm-art-<file key hash>` and shared between clones.

## Storefront

- Runtime assets `cm-builder.js` / `cm-builder.css`; per-product payload in theme asset
  `cm-<slug>.json`, referenced by metafield `custom.cm_payload`.
- `ca-pdp.liquid` gains one branch: when `custom.cm_payload` is set it loads `cm-builder`
  and points the root at that payload instead of `ca-builder`. Customily products carry no
  such metafield and render exactly as before.
- The branch is added to the theme **and** to the Customily skill's copy of
  `theme-pdp/ca-pdp.liquid`, because that tool pushes its copy and would remove it. Run
  `adopt_theme.py` first so the owner's theme edits are not reverted, then the Customily
  regression sweep.
- `cm-builder` drives the same DOM hooks as `ca-builder` (`[data-ca-stage]`,
  `[data-ca-options]`, `[data-ca-fields]`, `[data-ca-price]`, `[data-ca-form]`,
  `[data-ca-cta]`, `data-ca-prop`, `data-ca-err`) so the page script, preview bar and
  Preview button work unchanged.
- Order line properties use the source's field labels ("Choose The Title", "Type The Title"),
  the template label, and `_design` (the chosen state as JSON) for the print step.

## Runtime rules (v1)

- Template picker: `templateDisplayMode: image` shows template thumbnails.
- Stacking: layer array order. Geometry: Konva — position `x, y` is the top-left before
  rotation, rotation in degrees about that point, size `width*scaleX`, crop from `crop*`.
- Clip-art fields: items of the category, thumbnails from `thumbnail`, art from `file.key`;
  default from `settings.default`.
- Text: `fontFamily` face, `fill`, `align`, `letterSpacing`; `autofit` shrinks from
  `max_font_size` to fit the box; `text_suffix` appended; `max` characters; `required`.
- Visibility: `visible` and `condition` (`action: show`, `match: one|all`, `logic: =`
  against another field's chosen item or text). A field is offered only when its layer shows.
- Preview: the design drawn on the first mockup for the variant, inside its print area.

Anything else in a campaign is refused at the crawl by name.

## Checks

- Parity: explore the source's Customall form, replay each step on a local copy, compare the
  visible layers (id, art key, text) step by step.
- QA product (variants, prices, weights, photos), QA page at desktop and phone, `compare.png`
  (source preview beside our render) signed off by a person with `--visual`.
- Gates left to a person: `--rights`, `--visual`, publishing to the Online Store.

## Open at design time

- The font endpoint (`fontFamily` ids like `fjf4Eg2xPu-regular`).
- How to read the source form's state for parity (Customall globals or DOM).
