# QoreWitness brand

Solid, calm and trustworthy. QoreWitness protects ordinary people against threats they cannot see, such as AI edits and quantum computers. The design looks like a security product: clear structure, plain language, real product evidence. No black backgrounds and no purple-to-blue gradients.

## Logo

The mark is the "Sealed frame": a shield that holds a camera viewfinder. Three white corners and the persimmon recording dot form the frame. A check sits inside it. The idea in one line: this recording is sealed. The camera is the footage, the check is the proof and the shield is the protection.

- Wordmark: "QoreWitness" in IBM Plex Sans 600, shipped as outlines inside the lockup files. Use the lockup when there is room and the icon alone when there is not.
- Two-tone rule: the left half of the shield is always lighter than the right half. The dot is always Signal. Never recolour the halves to the same tone, never add gradients or outlines, and never rotate or stretch the mark.
- Light backgrounds: shield `#2F7D64` (left) and `#17483A` (right), corners white, bottom right corner `#D9EAE3`, dot `#E8663D`.
- Dark backgrounds (deep pine `#0F211C` and the footer): shield `#4FA586` and `#246A54`, bottom right corner `#CFE5DC`, dot `#EE7046`. On the site the symbol reads the `--lg-*` custom properties, so it switches with the theme.
- Minimum size: icon 20 px high, lockup 24 px high. Below 20 px use the favicon version.
- Clear space: half the icon width on every side.
- Favicon: `web/site/favicon.svg` is a simplified mark with only the shield, a bold check and the orange dot, because the viewfinder corners get too thin at 16 px.
- Sources: `<symbol id="logo">` in `web/site/index.html` and `scripts/build-site-preview.mjs`, `LOGO` and `LOGO_LIGHT` in `src/web/html.ts`, and the full SVG set in the logo proposal folder (icon and lockup, light and dark). The trademark search is still open.

## Colours

| Token | Hex | Use |
|---|---|---|
| Pine 900 | `#0E2F26` | Footer, button hover |
| Pine 800 | `#17483A` | Brand colour: logo, primary buttons, banner panel |
| Pine 700 | `#1F5C4B` | Links |
| Pine 100 | `#E4EEEA` | Icon tiles |
| Pine 50 | `#F1F6F4` | Hero gradient, notes |
| Signal | `#E8663D` | Recording dot, focus ring, list markers. Use sparingly. |
| Signal ink | `#B3451C` | Eyebrow labels on white (AA contrast) |
| Ink | `#13201C` | Body text |
| Stone 500 | `#5A6661` | Secondary text |
| Stone 200 | `#DCE1DD` | Borders (1 px) |
| Stone 50 | `#F6F7F5` | Alternate section background |
| OK | `#1E7A50` on `#E6F2EC` | Verified states |
| Bad | `#B42318` on `#FBEAE7` | Failed states |

Dark mode uses deep pine (`#0F211C`, surfaces `#152B25`), never black.

## Type

- IBM Plex Sans (variable). Headings 600, body 400, UI labels 500 to 600.
- IBM Plex Mono 400 and 500 for hashes, block numbers and eyebrow labels (upper case, letter spacing 0.08 em).
- Both fonts are self-hosted in `web/site/fonts/` under the SIL Open Font License.

## Layout and components

- Max content width 72 rem. Sections with 88 px vertical padding. Alternate sections on Stone 50.
- Cards and tiles: radius 8 px, 1 px border, no shadow. Only the product card (receipt) has a shadow.
- Buttons: radius 8 px. Primary in Pine 800 with white text. Secondary white with a border.
- Icons: 24 px line icons, 1.8 px stroke, in a Pine 100 tile.
- Show the product. The hero shows three camera frames with seal badges and the verification report that belongs to the main frame.

## Voice

- Short, active sentences. Speak to "you".
- Explain the threat in plain words first, then the technology.
- Be honest about status. Call it an alpha pilot. List the limits.
- No em dashes, no hype words, no claims the code does not support.

## Featured image

`docs/assets/qorewitness-featured.png` (1600 x 900). Source: `web/brand/banner.html`. Render with Playwright:

```bash
node web/brand/render.cjs web/brand/banner.html docs/assets/qorewitness-featured.png 1600 900 1
```
