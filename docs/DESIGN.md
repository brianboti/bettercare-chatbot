# Sophia — design specification

How Sophia looks, sounds and behaves on screen, in **every app built for Sophia**.
Every team building a Sophia app follows this file so the apps look like one product.
A change to the look starts as a change here.

The **Sophia theme** below is the default and the source of truth. An app that lives
inside another organization's site (for example, Sophia inside the BetterCare
SharePoint site) may use a **host theme**: the host's colors and font, nothing else
(§3). Shapes, spacing, type sizes, components, wording and accessibility are the same in
every app.

---

## 1. Principles

1. **A clinical instrument.** Calm, precise, Apple-grade restraint. One deep-azure accent,
   one teal "vitals" companion, on a white page.
2. **Always a white background.** Every screen, in every app, sits on white
   (`#FFFFFF`). There is no dark mode: Sophia stays light when the computer is set to
   dark. Cards are told apart from the page by a 1px separator border and a soft shadow,
   not by a tinted background.
3. **Evidence first.** Every answer shows where it came from, and says plainly whether
   it was checked ("Evidence linked", "Unreviewed sources", "Unable to answer").
4. **Color never speaks alone.** Every status has a word next to it.
5. **Plain words, short answers.** No restating the question, no headings in answers.
6. **One system, many homes.** Components use semantic tokens (`primary`, `label2`,
   `danger`), never raw colors, so a host theme can change the values without touching
   a component.

---

## 2. Color — Sophia theme

Tokens are RGB triplets so opacity works (`rgb(var(--c-primary) / 0.12)`). Use the token,
never a raw value. Light only (principle 2).

| Token | Hex | Use | Contrast on white |
|---|---|---|---|
| `--c-primary` | `#3D56D2` | Deep azure. Primary buttons, links, focus, the selected item, charts | 6.1:1 |
| `--c-primary-hover` | `#3048BB` | Hover and pressed | 7.6:1 |
| `--c-teal` ("vitals") | `#0D7D84` | Secondary accent: the end of the brand gradient, live/vitals indicators | 4.9:1 |
| `--c-label` | `#172033` | Body text and headings (a deep navy, not black) | 16.3:1 |
| `--c-label2` | `#4A576F` | Secondary text | 7.3:1 |
| `--c-label3` | `#626E85` | Hints, timestamps, placeholders | 5.1:1 |
| `--c-canvas` | `#FFFFFF` | Page background: always white | — |
| `--c-surface` | `#FFFFFF` | Cards, composer, panels | — |
| `--c-surface2` | `#EFF2F8` | Wells, inputs, quiet fills | — |
| `--c-separator` | `#DBE1EC` | Borders and dividers | — |
| `--c-success` | `#137A42` | "Evidence linked", pass, curated | 5.4:1 |
| `--c-warning` | `#935700` | "Unreviewed sources", live, unverified | 5.8:1 |
| `--c-danger` | `#C52C36` | Errors, fail, destructive actions | 5.5:1 |

Every text color passes 4.5:1 on white. Status backgrounds are the status color at 10%
(`rgb(var(--c-success) / .1)`) with the status color as text.

There is no dark palette. Don't add `prefers-color-scheme: dark` styles or a theme
switch; set `color-scheme: light` on the root so form controls stay light too.

### Start here: the tokens as CSS

```css
:root {
  color-scheme: light;
  --c-primary: 61 86 210;        --c-primary-hover: 48 72 187;   --c-teal: 13 125 132;
  --c-label: 23 32 51;           --c-label2: 74 87 111;          --c-label3: 98 110 133;
  --c-canvas: 255 255 255;       --c-surface: 255 255 255;       --c-surface2: 239 242 248;
  --c-separator: 219 225 236;
  --c-success: 19 122 66;        --c-warning: 147 87 0;          --c-danger: 197 44 54;
  --g-brand: linear-gradient(145deg, #3D56D2, #365EC0 60%, #0D7D84 145%);
  --font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif;
  --r-control: 12px; --r-card: 16px; --r-hero: 22px;
  --shadow-card: 0 1px 2px rgb(31 43 76 / .04), 0 14px 34px -30px rgb(38 57 111 / .38);
  --shadow-pop: 0 24px 64px -26px rgb(26 39 78 / .42), 0 5px 16px -10px rgb(25 38 75 / .16);
}
body { background: rgb(var(--c-canvas)); color: rgb(var(--c-label)); font: 400 15px/22px var(--font); }
```

### The brand gradient and the mark

The Sophia mark and the primary button use one gradient, azure into teal:
`linear-gradient(145deg, #3D56D2, #365EC0 60%, #0D7D84 145%)`.
The mark is a rounded tile, `#3E62E8 → #5060D9 → #09AEB4`, with a white "S" and a mint
(`#9AFBF1`) heartbeat line through it.
Use the gradient for the mark and the one primary action on a screen, nowhere else.

---

## 3. Host themes

An app shown inside another organization's site may take on that site's look so Sophia
reads as part of the page. A host theme:

- **may change:** the primary family (`primary`, `primary-hover`, `primary-light`), the
  neutrals (labels, surface2, separator), the status colors, and the font, to the
  host's own values. The brand gradient becomes the host primary into its hover color.
- **never changes:** the white page, the token names, the type sizes, shapes, spacing,
  elevation, components, wording and accessibility rules in this file.
- **must still pass** every contrast rule in §8 with its new values.

Each host theme is written down in its own file next to the app, as a table mapping
every token to the host's value. Today there is one:
**BetterCare** (the BetterCare SharePoint site's orange and Segoe UI) — see
[`DESIGN-BETTERCARE.md`](DESIGN-BETTERCARE.md).

---

## 4. Typography

The system font, `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif`
(San Francisco on Apple devices, Inter or the system font elsewhere), with Apple's
Dynamic Type ramp. Body text is tightened slightly (`letter-spacing: -0.011em`).
A host theme may swap the font; the sizes stay.

| Style | Size / line | Weight | Use |
|---|---|---|---|
| display | 36–44px fluid / 1.05 | 700 | Login and empty-state hero |
| largetitle | 30–34px fluid / 1.16 | 700 | Page titles, big numbers |
| title | 24–27px fluid / 1.2 | 700 | Section titles |
| title2 | 21 / 26px | 700 | Card titles |
| title3 | 18 / 23px | 600 | Sub-sections |
| headline | 16 / 21px | 600 | Emphasized rows, the question being answered |
| clinical | 16 / 24px | 400 | Answer text (a little larger and looser for reading) |
| body | 15 / 22px | 400 | Default text |
| callout | 14 / 19px | 400 | Secondary text, chips, table text |
| footnote | 13 / 17px | 400 | Meta, citations list |
| caption | 12 / 15px | 500 | Badges, labels, hints |
| eyebrow | 12px, uppercase, +0.055em | 600 | Small labels above titles and numbers, table headers |

Fluid sizes are rem-based and never more than 2.5× apart, so they still respond to browser
zoom. Numbers in tables use tabular figures.

---

## 5. Shape, space, elevation, motion

- **Corner radius:** 12px controls (inputs, buttons, chips) · 16px cards · 22px hero
  panels · fully round for pills, badges and the citation numbers.
- **Spacing:** multiples of 4px (4, 8, 12, 16, 24, 32).
- **Elevation** (soft, blue-tinted, never gray-black):
  - card: `0 1px 2px rgb(31 43 76 / .04), 0 14px 34px -30px rgb(38 57 111 / .38)`
  - pop-over / modal: `0 24px 64px -26px rgb(26 39 78 / .42), 0 5px 16px -10px rgb(25 38 75 / .16)`
- **Surfaces:** cards are white with a 1px separator border, a faint white sheen (a 145°
  gradient) and a 1px inner top highlight; the evidence rail is frosted glass
  (`backdrop-filter: blur(18px)`).
- **Motion:** 150–220ms, ease or `cubic-bezier(0.16, 1, 0.3, 1)`. Login and empty states may
  use a slow "aurora" over the white page. Everything decorative stops when the computer
  asks for reduced motion.

---

## 6. Components

| Component | Spec |
|---|---|
| **Primary button** | Brand gradient, white text, 12px radius, inner top highlight, soft primary-tinted shadow. One per screen. |
| **Secondary button** | Translucent surface, separator border, label color text. |
| **Composer** | Docked at the bottom of the conversation, white, with a large soft shadow and an inner top highlight. |
| **Answer** | `clinical` text style. Plain sentences, `- ` bullets or `1.` steps, bold sparingly. No headings, no tables. |
| **Answer badge** | Pill above the answer saying how it was checked: green "Evidence linked" or amber "Unreviewed sources", "General response", "Unable to answer". |
| **Citation** | Small round number in primary on a primary-tinted pill, with a larger invisible touch target. Opens the evidence. |
| **Evidence rail** | Frosted panel docked on the right on screens ≥1024px, an overlay below that. Each source shows title, date, and a "Curated / Not reviewed / Live" label. |
| **Suggestion / template chips** | 12px-radius chips; a chip with a blank to fill gently pulses until filled. |
| **Feedback** | Thumbs up / down under every answer; the rating saves on click, then an optional comment box opens ("What was helpful?" / "What was wrong or missing?"). |
| **Toast** | Stacked at the top right, surface card, animates in. |
| **Privacy curtain** | When the window loses focus, the workspace is hidden behind "Protected workspace". |
| **Admin card / tile** | Surface card, title2 title, caption hint; big numbers in largetitle under an eyebrow label; status pills with words. |
| **Data table** | callout text, eyebrow column headers, separator lines between rows, long tables paged (10 rows, Previous / Next) rather than scrolled. |
| **Test tile** | Suite name, status pill, big "17 / 17 passed", green/red pass bar, Run button. |

### Charts

- One series: `primary`. The hovered mark darkens to `primary-hover`.
- Heat maps and shares: from `surface2` (none) to `primary` (most).
- Gridlines in `separator`, axis labels in `label3` at caption size.
- Several series: `primary`, `teal`, then `label2`; each series also named in a legend or label.
- Every chart has a "View as table" option and an `aria-label`.

---

## 7. Voice and wording

- Sophia speaks in the first person, briefly, and never restates the question.
- When the information isn't in her sources, the wording is fixed:
  **"That information doesn't exist in the [source] documents."** — with the app's own
  source name (BetterCare: "the BetterCare documents").
- No medical advice unless a source states it, cited.
- Buttons are verbs ("Sign in", "Send", "Run"). Labels are sentence case; eyebrows are
  uppercase.

---

## 8. Accessibility

- Text contrast at least 4.5:1 (3:1 at 18px+ or bold 14px+). All Sophia-theme text tokens
  pass; a host theme must too.
- Every control works by keyboard with a visible focus ring in primary.
- Touch targets at least 44×44px (small controls such as citations use an invisible
  larger target).
- Icons and colors always have a word or an `aria-label` beside them.
- Server content is set as text, never as HTML.
- Fluid type stays zoom-safe; reduced motion is respected.

---

## 9. Apps not yet on this spec

| App | What's left |
|---|---|
| Ask Sophia | Off-white page (`#F6F8FC`) and dark mode: move to white, light only. |
| Sophia admin console | Same as Ask Sophia. |
| Sophia for BetterCare | See [`DESIGN-BETTERCARE.md`](DESIGN-BETTERCARE.md). |
