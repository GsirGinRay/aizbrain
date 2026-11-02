/**
 * Bundles the CLI and the stand-alone hook script into `dist/`. The published
 * package has no runtime dependencies: everything it needs is in these files.
 */
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = resolve(packageDir, "../brain-core/src");

/**
 * Lets esbuild drop the brain-core modules the CLI never calls (and zod with
 * them). The flag is set here so the desktop bundle is not affected.
 */
const brainCoreIsPure = {
  name: "brain-core-is-pure",
  setup(context) {
    context.onResolve({ filter: /^@second-brain\/brain-core$/ }, () => ({
      path: join(coreDir, "index.ts"),
      sideEffects: false,
    }));
    context.onResolve({ filter: /^\.\.?\// }, (args) =>
      args.importer.startsWith(coreDir)
        ? { path: `${resolve(dirname(args.importer), args.path)}.ts`, sideEffects: false }
        : undefined);
  },
};

export async function buildCli(outdir) {
  const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "none",
    logLevel: "warning",
    plugins: [brainCoreIsPure],
    define: { __AIZBRAIN_VERSION__: JSON.stringify(version) },
  };
  await build({
    ...common,
    entryPoints: [join(packageDir, "src/cli.ts")],
    outfile: join(outdir, "aizbrain.mjs"),
    banner: { js: "#!/usr/bin/env node" },
  });
  await build({
    ...common,
    entryPoints: [join(packageDir, "src/hook-entry.ts")],
    outfile: join(outdir, "aizbrain-hook.mjs"),
    banner: { js: `// aizbrain ${version} hook. Generated file, do not edit. Update it with: npx aizbrain hook install <tool>` },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outdir = join(packageDir, "dist");
  rmSync(outdir, { recursive: true, force: true });
  await buildCli(outdir);
}
