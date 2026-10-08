// node:test reporter that writes one JSON line per finished test, for the
// admin panel's Tests tab (server/testrunner.mjs):
//
//   node --test --test-reporter=./tools/test-reporter-json.mjs test/*.test.mjs

const message = (err) => {
  const e = err?.cause ?? err;
  return e ? String(e.message ?? e).slice(0, 2000) : null;
};

export default async function* jsonReporter(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data;
    if (d.details?.type === 'suite') continue;
    yield `${JSON.stringify({
      name: d.name, file: d.file || null, nesting: d.nesting || 0, pass: ev.type === 'test:pass',
      durationMs: d.details?.duration_ms ?? null, error: ev.type === 'test:fail' ? message(d.details?.error) : null,
    })}\n`;
  }
}
