import {cpSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(sourceRoot, 'out', 'i18n');
const target = resolve(sourceRoot, '..', '..', 'site', 'assets', 'motion');

if (!existsSync(built)) {
  throw new Error('No rendered assets found. Run npm run render:i18n first.');
}

mkdirSync(target, {recursive: true});
cpSync(built, target, {recursive: true, force: true});
console.log(`[CapturePack motion] copied assets to ${target}`);
