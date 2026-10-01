'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');

async function main() {
  if (process.platform !== 'win32') throw new Error('Run Windows packaging on Windows.');
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--zip')) throw new Error('Usage: node scripts/package-windows.cjs [--zip]');
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (Object.keys(pkg.dependencies || {}).length) {
    throw new Error('Production dependencies must be added to the staging step before packaging.');
  }
  const electronVersion = require('electron/package.json').version;
  const outputBase = path.join(root, 'dist', 'releases');
  await fs.mkdir(outputBase, { recursive: true });
  // Every invocation gets a new directory, including when an existing app is running.
  const output = await fs.mkdtemp(path.join(outputBase, `${pkg.version}-`));
  const staging = path.join(output, '.staging');
  if (path.dirname(staging) !== output || !output.startsWith(`${outputBase}${path.sep}`)) {
    throw new Error('Refusing staging outside this build output.');
  }
  await fs.mkdir(staging);
  try {
    // Allowlist runtime files: never ship drafts, local builds, repository metadata,
    // node_modules, or arbitrary files from the developer's working directory.
    for (const name of ['src', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      await fs.cp(path.join(root, name), path.join(staging, name), { recursive: true, dereference: false });
    }
    const runtimePackage = Object.fromEntries(
      ['name', 'version', 'description', 'main', 'private', 'license'].map((key) => [key, pkg[key]]),
    );
    await fs.writeFile(path.join(staging, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
    const [appDirectory] = await packager({
      dir: staging,
      name: pkg.name,
      platform: 'win32',
      arch: 'x64',
      electronVersion,
      // Optional local cache for offline builds; CI uses Electron's normal download cache.
      ...(process.env.AITRACKER_ELECTRON_ZIP_DIR
        ? { electronZipDir: path.resolve(process.env.AITRACKER_ELECTRON_ZIP_DIR) } : {}),
      out: output,
      overwrite: false,
      prune: false,
    });
    console.log(`Windows app: ${appDirectory}`);
    if (args.includes('--zip')) {
      const archive = path.join(output, `${pkg.name}-${pkg.version}-win32-x64.zip`);
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'zip-windows.ps1'),
        '-SourceDirectory', appDirectory, '-DestinationPath', archive,
      ], { stdio: 'inherit' });
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(archive)) hash.update(chunk);
      await fs.writeFile(`${archive}.sha256`, `${hash.digest('hex')}  ${path.basename(archive)}\n`);
      console.log(`Download assets: ${archive}\n                 ${archive}.sha256`);
    }
  } finally {
    // Only remove the staging directory created by this invocation.
    await fs.rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
