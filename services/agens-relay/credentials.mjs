// Each internal token resolves to exactly one supplier key. Cloudflare owns
// affinity, alias selection and health; the relay never retries another key.
export function parseCredentials(value) {
  if (!value) return [];
  const entries = JSON.parse(value);
  if (!Array.isArray(entries) || entries.length > 32 || entries.some(entry =>
    !entry || typeof entry.token !== 'string' || entry.token.length < 32 ||
    typeof entry.apiKey !== 'string' || !entry.apiKey.trim()
  )) throw new Error('Invalid relay credential configuration');
  if (new Set(entries.map(entry => entry.token)).size !== entries.length ||
    new Set(entries.map(entry => entry.apiKey)).size !== entries.length)
    throw new Error('Duplicate relay credential configuration');
  return entries;
}
