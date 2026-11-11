# QoreWitness brand

Friendly and calm. Minimal layouts, soft round shapes, warm colours. A small hint of kawaii through the mascot. No black backgrounds and no purple-to-blue gradients.

## Mascot: Witt

A round pistachio camera with a persimmon lens. The lens is the face.

| Mood | Where | Face |
|---|---|---|
| Idle | Default, logo, banner | Dot eyes, small "w" mouth |
| Happy | Verifier: verified | Closed "^ ^" eyes, open smile |
| Worried | Verifier: not verified | Raised brows, wavy mouth, sweat drop |

Rules:

- Keep the shapes flat. No outlines, no gradients, no gloss.
- Blush cheeks only in sizes of 48 px and up. The favicon uses eyes only.
- Use Witt once or twice per page. Do not use it as a background pattern.

Source: the `<symbol id="witt">` in `web/site/index.html`. Favicon: `web/site/favicon.svg`.

## Colours

| Token | Hex | Use |
|---|---|---|
| Oat | `#F7F1E6` | Page background |
| Cream | `#FFFBF4` | Cards, lens |
| Line | `#E8DCC8` | Borders (2 px) |
| Pine | `#22332D` | Text. Use this, not black. |
| Muted | `#5F6B64` | Secondary text |
| Persimmon | `#EF7B4F` | Brand colour: lens ring, highlights, focus ring |
| Persimmon deep | `#B84A22` | Primary buttons and links on light (white text, AA) |
| Pistachio | `#BFD9A8` | Mascot body, first chip |
| Pistachio deep | `#9CC384` | Viewfinder, tree nodes |
| Moss | `#3E7A4A` | "Verified" text |
| Butter | `#F6D98B` | Second chip, bullets, sparkles |
| Blush | `#F4A99A` | Cheeks, third chip |
| Berry | `#B23A48` | "Not verified" text |

Dark mode is warm cocoa, not black: background `#231D1A`, cards `#2E2622`, text `#F4ECE0`, accent `#FF9A6E`.

Chip and step order is always pistachio, butter, blush, persimmon.

## Type

- Display: Fredoka (variable, weight 600). Headings and the wordmark.
- Body: Nunito (variable, weights 400 to 800).
- Code and hashes: the system monospace font.
- Both fonts are self-hosted in `web/site/fonts/` under the SIL Open Font License.

## Shapes

- Cards: radius 24 px, 2 px border in Line, no shadow.
- Buttons and chips: full pill radius, weight 800.
- Block numbers: small rounded "pebbles" in monospace. The anchored block has a persimmon border.

## Featured image

`docs/assets/qorewitness-featured.png` (1600 x 900). Source: `web/brand/banner.html`. Render it with Playwright:

```bash
node web/brand/render.cjs web/brand/banner.html docs/assets/qorewitness-featured.png 1600 900 1
```
