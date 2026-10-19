# Real bugs we hit

Three bugs from building Sophia, written up as references for writing tests.
Each one passed a quick manual check, and each one now has a test that would
have caught it.

---

## 1. "Fastest" contains "test": a real news page was thrown away

**What happened.** The BetterCare site has pages the site admin made to try
things out (`Wisdom-TEST.aspx`, `DtlTestPage.aspx`, `mary-test.aspx`). The
ingest step left out any page whose file name matched `/test/i`. That also
matched
`Texas-A&M-System-Home-to-Nation's-Fastest-University-Supercomputer.aspx`,
because "Fas**test**" contains "test". A real news page silently disappeared
from Sophia's search, and nothing warned anyone.

**Cause.** A substring match was used where a word match was meant:

```js
// src/ingest/pages.mjs (before, 2026-09-24)
[/test/i, 'test page'],
```

**Fix (2026-10-08, `db9abe8`).** `src/ingest/test-content.mjs` splits a
name into words, handling camelCase, separators and digits (`AbrInsideTEST` →
`Abr Inside TEST`, `test234` → `test 234`). It then applies two rules:
- **"test" as a whole word** marks a trial page, unless the name also says
  it is a real test ("Lab Test Directory", "COVID Test Ordering").
- **"test" inside a longer word** marks a trial page (`TESTANALYTICS`),
  unless that word is ordinary English ("fastest", "latest", "retest",
  "testing", "testimonials").

Ingest also prints everything it leaves out, so a person can check the list.

**Test.** `test/test-content.test.mjs` checks that the "Fastest University
Supercomputer" page is kept while `Wisdom-TEST`, `test234` and
`DtlTestPage` are dropped.

**Lesson for tests.** For any filter, test what it must **keep** as well as
what it must drop. The bug was invisible because nobody looked at what was
missing.

---

## 2. SharePoint said "200 OK" and sent an error page instead of the file

**What happened.** Exporting the site downloads about 3,600 library files
(PDFs, Word, PowerPoint, Excel). Under heavy load, SharePoint throttles
requests. It doesn't return the usual `429 Too Many Requests`: it returns
**`200 OK` with a small HTML error page** (it loads `throttleerror.js`). The
downloader saw "200 OK" and saved that HTML page under the file's name, for
example `Tip Sheet.pdf`. Ingest then tried to read an HTML page as a PDF and
either failed or indexed junk in place of the real tip sheet.

**Cause.** The code trusted the HTTP status code. For SharePoint, "200" does
not guarantee you got the file.

**Fix (2026-09-24).** `src/ingest/documents.mjs` compares each file with
SharePoint's listed size and looks at its first bytes. If the size is wrong
and the body starts with `<` (HTML), the file is reported as an "incomplete
download" and skipped instead of indexed, so it can be downloaded again.
Office files are allowed a size difference, because SharePoint re-stamps them
on download, unless their body is HTML.

**Test.** `isIncompleteDownload` in `test/ingest-documents.test.mjs` checks these cases, and a regression test runs a throttled download through the whole document import:
- A real file of the right size is accepted.
- An HTML throttle page saved as `.pdf` is rejected.
- A real Office file with a different size is accepted.
- An Office file whose body is HTML is rejected.

**Lesson for tests.** Don't treat an external system's status code as the
truth. Write tests that feed the code the strange-but-real responses you've
actually seen.

---

## 3. The model cited the sentence but not the bullets

**What happened.** Sophia's rule is that every point in an answer cites its
source (`[1]`, `[2]`, …) so people can check it. The prompt said so, and most
answers followed it. Some answers, though, cited only the sentence that
introduced a list ("The Thrive objectives cover this [1]:") and left every
bullet under it without a citation. The answer looked fine at a glance, so
manual checks missed it. The answer-rules eval caught it.

**Cause.** A rule that is only in the prompt is followed most of the time,
not all of the time. Nothing in the code checked the output.

**Fix (2026-10-12, `41b4388`).** `server/citations.mjs` checks every
answer after it is written:
- `uncitedItems` finds bullets and steps without a citation. It skips
  questions back to the person.
- `repairCitations` gives each one the source it overlaps with most,
  preferring the source the lead-in sentence cited. It puts the number before
  the final punctuation, the way the model writes it.

The eval counts what the model wrote and what people see separately, so the
model's own error rate stays visible.

**Test.** `test/answer-shape.test.mjs` and `test/citations.test.mjs` cover
these cases:
- Bullets under a cited lead-in get the lead-in's source.
- A bullet that matches nothing stays uncited and is reported.
- Questions are left alone.
- Existing citations are untouched.

`npm run eval:answers` checks the same rule against the real model.

**Lesson for tests.** When an AI model produces the output, test the code
that checks and repairs its output, and keep an eval that measures how often
the model gets it right on its own.
