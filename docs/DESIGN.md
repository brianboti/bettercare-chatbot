# Sophia — design specification

How Sophia looks, sounds, and behaves on screen, in every product she appears in.
Every new screen or component follows this file; a change to the look starts as a
change here.

Sophia is one assistant with several homes:

| Product | Where | Look today |
|---|---|---|
| **Ask Sophia** (clinical reference) | `~/Code/sophia/ask-sophia`, standalone web app | **Sophia theme** (this file's default) |
| Sophia admin console | `~/Code/sophia/web` | Sophia theme (same tokens) |
| **Sophia for BetterCare** | this repo: the pane in the SharePoint site, its admin panel | **BetterCare theme** (§3) |
| Sophia Chrome extension | this repo, `extension/` | An early teal mockup palette; moves to the Sophia theme (§8) |

The **Sophia theme** below is the source of truth. It is taken from Ask Sophia
(`ask-sophia/src/index.css`, `tailwind.config.js`), which already says: *"The same
semantic token set, Apple type ramp, and login system span Sophia's clinical and
administrative experiences."* A product hosted inside someone else's site may swap the
**colors and font** for a host theme (§3). Everything else (shapes, spacing, components,
wording, accessibility) stays the same everywhere.

---

## 1. Principles

1. **A clinical instrument.** Calm, precise, Apple-grade restraint. One deep-azure accent,
   one teal "vitals" companion, on a white page.
2. **Always a white background.** Every screen, in every product, sits on white
   (`#FFFFFF`). There is no dark mode: Sophia stays light when the computer is set to
   dark. Cards are told apart from the page by a 1px separator border and a soft shadow,
   not by a tinted background.
3. **Evidence first.** Every answer shows where it came from, and says plainly whether
   it was checked ("Evidence linked", "Unreviewed sources", "Unable to answer").
4. **Color never speaks alone.** Every status has a word next to it.
5. **Plain words, short answers.** No restating the question, no headings in answers.
6. **One system, many homes.** Tokens are semantic (`primary`, `label2`, `danger`), never
   named after a color, so a host theme can change the values without touching components.

---

## 2. Color — Sophia theme

Tokens are RGB triplets so opacity works (`rgb(var(--c-primary) / 0.12)`). Use the token,
never a raw value.

Light only (§1, principle 2).

| Token | Hex | Use | Contrast on white |
|---|---|---|---|
| `--c-primary` | `#3D56D2` | Deep azure. Primary buttons, links, focus, the selected item | 6.1:1 |
| `--c-primary-hover` | `#3048BB` | Hover and pressed | 7.6:1 |
| `--c-teal` ("vitals") | `#0D7D84` | Secondary accent: the end of the brand gradient, live/vitals indicators | 4.9:1 |
| `--c-label` | `#172033` | Body text and headings (a deep navy, not black) | 16.3:1 |
| `--c-label2` | `#4A576F` | Secondary text | 7.3:1 |
| `--c-label3` | `#626E85` | Hints, timestamps, placeholders | 5.1:1 |
| `--c-canvas` | `#FFFFFF` | Page background: always white | — |
| `--c-surface` | `#FFFFFF` | Cards, composer, panels | — |
| `--c-surface2` | `#EFF2F8` | Wells, inputs, secondary buttons | — |
| `--c-separator` | `#DBE1EC` | Borders and dividers | — |
| `--c-success` | `#137A42` | "Evidence linked", pass, curated | 5.4:1 |
| `--c-warning` | `#935700` | "Unreviewed sources", live, unverified | 5.8:1 |
| `--c-danger` | `#C52C36` | Errors, fail, destructive actions | 5.5:1 |

Every text color passes 4.5:1 on white.

There is no dark palette. Don't add `prefers-color-scheme: dark` styles or a theme
switch; set `color-scheme: light` on the root so form controls stay light too.

### The brand gradient

The Sophia mark and the primary button use one gradient, azure into teal:
`linear-gradient(145deg, #3D56D2, #365EC0 60%, #0D7D84 145%)`.
The mark (`ask-sophia/public/sophia-mark.svg`) is a rounded tile, `#3E62E8 → #5060D9 → #09AEB4`,
with a white "S" and a mint (`#9AFBF1`) heartbeat line through it.
Use the gradient for the mark and the one primary action on a screen, nowhere else.

---

## 3. Host themes

A host theme replaces only the color values and the font. Same token names, same
components.

### BetterCare theme (Sophia inside the BetterCare SharePoint site)

Inside SharePoint, Sophia uses the site's own theme so she reads as part of the page.
Defined in `site/assistant.css` (`--bc-*`) and `site/admin/admin.css`.

| Sophia token | BetterCare value | Note |
|---|---|---|
| primary | `#CA5010` | The BetterCare SharePoint orange. White on it is exactly 4.5:1, so only bold text ≥13px sits on it |
| primary-hover / orange text | `#993E0C` | 6.9:1 on white |
| primary light (citations, selected) | `#F6DFD2` | |
| label / label2 / label3 | `#242424` / `#605E5C` / `#6E6C6A` | All pass 4.5:1 on white |
| canvas / surface / surface2 / separator | `#FFFFFF` / `#FFFFFF` / `#F3F2F1` / `#E1DFDD` | White page; Fluent warm grays for wells and borders |
| success / warning / danger | `#107C10` / `#7A5300` / `#A4262C` | |
| font | Segoe UI | The Microsoft 365 font |

The BetterCare pane and the BetterCare admin panel are light only, on white, like
every Sophia screen.

**Decision to confirm (professor):** keep a host theme inside BetterCare, or show Sophia's
own azure/teal everywhere so she is recognizably the same assistant. See the
"one look or two" slide.

---

## 4. Typography

**Sophia theme:** the system font, `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif`
(San Francisco on Apple devices, Inter or the system font elsewhere), with Apple's
Dynamic Type ramp. Body text is tightened slightly (`letter-spacing: -0.011em`).
**BetterCare theme:** Segoe UI, same sizes.

| Style | Size / line | Weight | Use |
|---|---|---|---|
| display | 36–44px fluid / 1.05 | 700 | Login and empty-state hero |
| largetitle | 30–34px fluid / 1.16 | 700 | Page titles |
| title | 24–27px fluid / 1.2 | 700 | Section titles |
| title2 | 21 / 26px | 700 | Card titles |
| title3 | 18 / 23px | 600 | Sub-sections |
| headline | 16 / 21px | 600 | Emphasized rows, the question being answered |
| clinical | 16 / 24px | 400 | Answer text (a little larger and looser for reading) |
| body | 15 / 22px | 400 | Default text |
| callout | 14 / 19px | 400 | Secondary text, chips |
| footnote | 13 / 17px | 400 | Meta, citations list |
| caption | 12 / 15px | 500 | Badges, labels |
| eyebrow | 12px, uppercase, +0.055em | 600 | Small labels above titles |

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
- **Surfaces:** cards carry a faint white sheen (a 145° gradient) and a 1px inner top
  highlight; the evidence rail is frosted glass (`backdrop-filter: blur(18px)`).
- **Motion:** 150–220ms, ease or `cubic-bezier(0.16, 1, 0.3, 1)`. Login and empty states may
  use a slow "aurora" over the white page. Everything decorative stops when the computer asks for
  reduced motion.

---

## 6. Components

| Component | Spec |
|---|---|
| **Primary button** | Brand gradient, white text, 12px radius, inner top highlight, soft azure shadow. One per screen. |
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
| **Admin card / tile** | Surface card, title2 title, caption hint; big numbers in largetitle; status pills with words. |
| **Test tile** | Suite name, status pill, big "17 / 17 passed", green/red pass bar, Run button. |

---

## 7. Voice and wording

- Sophia speaks in the first person, briefly, and never restates the question.
- When the information isn't in her sources, the wording is fixed. In BetterCare:
  **"That information doesn't exist in the BetterCare documents."**
- No medical advice unless a source states it, cited.
- Buttons are verbs ("Sign in", "Send", "Run"). Labels are sentence case; eyebrows are
  uppercase.

---

## 8. Accessibility

- Text contrast at least 4.5:1 (3:1 at 18px+ or bold 14px+). All Sophia-theme text tokens pass.
- Every control works by keyboard with a visible focus ring in primary.
- Touch targets at least 44×44px (citations use an invisible larger target).
- Icons and colors always have a word or an `aria-label` beside them.
- Server content is set as text, never as HTML.
- Fluid type stays zoom-safe; reduced motion is respected.

---

## 9. Known gaps

- **Chrome extension** (`extension/sidepanel.css`) uses the first mockup's teal palette
  (`#127D94`, navy `#17394A`). It should adopt the Sophia theme tokens above.
- **Ask Sophia and the Sophia admin console** (`~/Code/sophia`) still use the pearl canvas
  (`#F6F8FC`) and follow dark mode. Both move to white, light only.
- **Answer badges** ("Evidence linked" / "Unreviewed sources") exist in Ask Sophia but not
  yet in the BetterCare pane.
- Slide decks use a separate presentation style (Source Serif 4, IBM Plex Sans, `#B4501A`);
  it is for slides only.
