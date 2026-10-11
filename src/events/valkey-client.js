import Valkey from 'iovalkey';

const DEFAULT_URL = process.env.VALKEY_URL || 'redis://localhost:6389';

let sharedClient = null;

/**
 * Create or return a shared iovalkey client.
 *
 * The client reads VALKEY_URL from the environment (default redis://localhost:6389).
 * Callers must not call quit() on the shared instance; use closeSharedValkey()
 * for graceful shutdown.
 *
 * @param {string} [url]
 * @returns {import('iovalkey').Valkey}
 */
export function getValkeyClient(url = DEFAULT_URL) {
  if (!sharedClient) {
    sharedClient = new Valkey(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      showFriendlyErrorStack: process.env.NODE_ENV !== 'production'
    });
  }
  return sharedClient;
}

export async function closeSharedValkey() {
  if (sharedClient) {
    const client = sharedClient;
    sharedClient = null;
    await client.quit();
  }
}
