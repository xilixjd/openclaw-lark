import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'package.json');
const backupPath = path.join(repoRoot, '.npm-pack-package.json.bak');

export function createPublishManifest(pkg) {
  const publishPkg = { ...pkg };

  delete publishPkg.devDependencies;

  return publishPkg;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function preparePublishManifest() {
  if (await fileExists(backupPath)) return;

  const originalText = await readFile(manifestPath, 'utf8');
  const originalPkg = JSON.parse(originalText);
  const publishPkg = createPublishManifest(originalPkg);

  await writeFile(backupPath, originalText);
  await writeFile(manifestPath, `${JSON.stringify(publishPkg, null, 2)}\n`);
}

async function restoreManifest() {
  if (!(await fileExists(backupPath))) return;

  const originalText = await readFile(backupPath, 'utf8');
  await writeFile(manifestPath, originalText);
  await unlink(backupPath);
}

const mode = process.argv[2];

if (mode === 'prepare') {
  await preparePublishManifest();
} else if (mode === 'restore') {
  await restoreManifest();
} else {
  console.error('Usage: node scripts/prepare-publish-manifest.mjs <prepare|restore>');
  process.exitCode = 1;
}
