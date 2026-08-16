/**
 * Read a secret from the environment, or refuse to run.
 *
 * The seeding scripts set real passwords on real accounts. Those passwords must
 * not be written in the scripts themselves: everything under `scripts/` is
 * tracked, this repository is public, and a password committed once stays in
 * the history after it is edited out. That has already happened here with an
 * API key.
 *
 * There is deliberately no default. A script that falls back to a placeholder
 * when a variable is missing sets a password nobody chose and reports success,
 * which is worse than not running at all.
 */
export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `\n${name} is not set.\n\n  ${hint}\n\n` +
        `Put it in .env.local (gitignored) and re-run with --env-file=.env.local.\n`,
    );
    process.exit(1);
  }
  return value;
}
