# Sophia for BetterCare — host theme

Sophia inside UT Health San Antonio's BetterCare SharePoint site uses some of the
site's look so she reads as part of the page. This file is the host theme the general
spec allows ([`DESIGN.md`](DESIGN.md) §3): it maps each Sophia token to a BetterCare
value. Everything not listed here (white page, type sizes, shapes, spacing, components,
wording, accessibility) follows `DESIGN.md` unchanged.

Used by the assistant pane in the site (`site/assistant.css`, `--bc-*`), its admin
panel (`site/admin/admin.css`), and the Chrome extension.

| Sophia token | BetterCare value | Note |
|---|---|---|
| primary | `#CA5010` | The BetterCare SharePoint orange. White on it is exactly 4.5:1, so only bold text ≥13px sits on it |
| primary-hover / orange text | `#993E0C` | 6.9:1 on white |
| primary-light (citations, selected) | `#F6DFD2` | |
| label / label2 / label3 | `#242424` / `#605E5C` / `#6E6C6A` | All pass 4.5:1 on white |
| canvas / surface / surface2 / separator | `#FFFFFF` / `#FFFFFF` / `#F3F2F1` / `#E1DFDD` | White page; Fluent warm grays for wells and borders |
| success / warning / danger | `#107C10` / `#7A5300` / `#A4262C` | |
| brand gradient | `#CA5010 → #993E0C` | The mark and the one primary action |
| font | Segoe UI | The Microsoft 365 font |

Fixed wording when the answer isn't on the site:
**"That information doesn't exist in the BetterCare documents."**

## Not yet on the spec

- **Chrome extension** (`extension/sidepanel.css`) still uses the first mockup's teal
  palette (`#127D94`, navy `#17394A`). It should use this theme.
- **Answer badges** ("Evidence linked" / "Unreviewed sources") aren't in the BetterCare
  pane yet.
