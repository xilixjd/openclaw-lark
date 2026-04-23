import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createPublishManifest } from '../scripts/prepare-publish-manifest.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');

describe('publish manifest', () => {
  it('strips devDependencies from the packed package manifest', () => {
    const sourcePkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const publishPkg = createPublishManifest(sourcePkg);

    expect(sourcePkg.devDependencies?.openclaw).toBeTruthy();
    expect(publishPkg.dependencies?.openclaw).toBeFalsy();
    expect(publishPkg.peerDependencies?.openclaw).toBeTruthy();
    expect(publishPkg.devDependencies).toBeUndefined();
  });
});
