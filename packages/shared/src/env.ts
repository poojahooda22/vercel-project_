/**
 * Reads a required environment variable, or throws with a message that names the
 * actual cause.
 *
 * This was copied into eight files, in three slightly different versions that had
 * drifted apart — only the error text differed. The longest one is kept because it
 * encodes a real failure this project hit repeatedly: `node dist/index.js` starts
 * fine and then dies on a missing variable, because plain node does not read .env.
 * Losing that sentence to deduplication would lose the lesson with it.
 */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Set it in .env, then start with "npm run dev". ` +
        `A bare "node dist/index.js" does NOT read .env — it needs --env-file=.env.`
    );
  }
  return value;
}
