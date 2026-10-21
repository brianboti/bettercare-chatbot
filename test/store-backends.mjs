// The databases the store tests run against: SQLite always, and Firestore
// when the Firestore emulator is running (FIRESTORE_EMULATOR_HOST is set;
// `npm run test:firestore` starts it). Each Firestore store gets its own
// collection prefix, so tests never see each other's rows.

import { randomBytes } from 'node:crypto';
import { openStore } from '../server/store.mjs';

export const BACKENDS = [
  { name: 'sqlite', open: async () => openStore(':memory:') },
];

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { Firestore } = await import('@google-cloud/firestore');
  const { openFirestoreStore } = await import('../server/store-firestore.mjs');
  const firestore = new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID || 'sophia-test', ignoreUndefinedProperties: true });
  BACKENDS.push({ name: 'firestore', open: async () => openFirestoreStore({ firestore, prefix: `t${randomBytes(4).toString('hex')}_` }) });
}
