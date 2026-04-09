import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

function hasRuntimeOpenClawSdkImport(source: string): boolean {
  const runtimeImportPattern = /\bimport\s+(?!type\b)[\s\S]*?\bfrom\s+['"]openclaw\/plugin-sdk(?:\/[^'"]*)?['"]/;
  const runtimeExportPattern = /\bexport\s+[\s\S]*?\bfrom\s+['"]openclaw\/plugin-sdk(?:\/[^'"]*)?['"]/;
  return runtimeImportPattern.test(source) || runtimeExportPattern.test(source);
}

describe('package manifest runtime dependencies', () => {
  it('declares openclaw as an install-time dependency when runtime sdk imports exist', () => {
    const files = [path.join(repoRoot, 'index.ts'), ...collectTsFiles(path.join(repoRoot, 'src'))];
    const runtimeImportFiles = files
      .filter((file) => hasRuntimeOpenClawSdkImport(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file));

    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(
      runtimeImportFiles.length,
      'update this test if the packaging strategy changes and runtime OpenClaw SDK imports are removed',
    ).toBeGreaterThan(0);
    expect(
      pkg.dependencies?.openclaw,
      `runtime OpenClaw SDK imports require an installed openclaw package: ${runtimeImportFiles.join(', ')}`,
    ).toBeTruthy();
    expect(pkg.peerDependencies?.openclaw).toBeTruthy();
  });
});
