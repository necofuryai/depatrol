import { resolveBuildVersion, run } from "./cli/index.ts";

async function main(): Promise<void> {
  const exitCode = await run(process.argv.slice(2), {
    version: resolveBuildVersion(),
  });
  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
