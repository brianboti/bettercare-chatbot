// Opens the database DATABASE names: SQLite (store.mjs) or Firestore
// (store-firestore.mjs). Both have the same methods; callers await them.

import { config } from './config.mjs';
import { openStore } from './store.mjs';

export async function openConfiguredStore() {
  if (config.DATABASE === 'firestore') {
    const { openFirestoreStore } = await import('./store-firestore.mjs');
    return openFirestoreStore({
      projectId: config.FIRESTORE_PROJECT_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
      prefix: config.FIRESTORE_COLLECTION_PREFIX,
    });
  }
  return openStore(config.DB_FILE);
}

/** One line for the startup log. */
export const describeDatabase = () => (config.DATABASE === 'firestore'
  ? `firestore (${config.FIRESTORE_PROJECT_ID || 'project from credentials'}, database ${config.FIRESTORE_DATABASE_ID}${config.FIRESTORE_COLLECTION_PREFIX ? `, prefix ${config.FIRESTORE_COLLECTION_PREFIX}` : ''})`
  : `sqlite (${config.DB_FILE})`);
