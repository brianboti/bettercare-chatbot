// Every answer points to a person who can help: the Health IT Help Desk, as
// the site footer lists it. The footer excerpt is always given to the model
// (so "how do I get help right now?" can be answered from it) and the help
// line cites it.

export const HELP_SOURCE_ID = 'site:footer';

const HELP_NUMBER = /450[-.\s]?4800|450[-.\s]?HELP/i;

/** The closing line, citing the footer excerpt as [n]. */
export function helpLine(n) {
  return `Need a person? Call the Health IT Help Desk at 210-450-4800 (210-450-HELP) or email HealthITSupport@uthscsa.edu [${n}].`;
}

/** The answer already gives the help desk contact (a question about getting help). */
export const hasHelp = (answer) => HELP_NUMBER.test(answer);

/** Make sure the footer is among the excerpts; returns the results to use. */
export function withHelpSource(results, retriever) {
  if (results.some((c) => c.id === HELP_SOURCE_ID)) return results;
  const footer = retriever.get?.(HELP_SOURCE_ID);
  return footer ? [...results, footer] : results;
}
