// Sophia's release version (package.json; see CHANGELOG.md for what each one changed).

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
