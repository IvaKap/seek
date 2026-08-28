/*
 * Seek — pull a Lucide icon into the builder's table.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 *   node design/add-icon.mjs tag bookmark radio
 *
 * Geometry is lifted from the copy of Lucide already in app/node_modules, so
 * the mock uses the same paths the app would paint if the icon were adopted
 * there too. Nothing is downloaded and nothing is drawn by hand.
 *
 * Lucide names are kebab-case and occasionally not what you would guess —
 * `triangle-alert`, not `alert-triangle`. An unknown name lists near matches
 * rather than failing blank.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = join(HERE, '..', 'app', 'node_modules', 'lucide-react', 'dist', 'esm', 'icons');
const CODE = join(HERE, 'figma-plugin', 'code.js');

const wanted = process.argv.slice(2);
if (wanted.length === 0) {
  console.error('usage: node design/add-icon.mjs <lucide-name> [more…]');
  process.exit(1);
}

const available = (await readdir(ICON_DIR))
  .filter((f) => f.endsWith('.js') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.js$/, ''));

let code = await readFile(CODE, 'utf8');
const added = [];

for (const name of wanted) {
  if (!available.includes(name)) {
    const near = available.filter((a) => a.includes(name) || name.includes(a)).slice(0, 8);
    console.error(`✗ no Lucide icon "${name}"${near.length ? `\n  did you mean: ${near.join(', ')}` : ''}`);
    continue;
  }
  if (code.includes(`  '${name}': "`)) {
    console.log(`· ${name} is already in the table`);
    continue;
  }

  let src = await readFile(join(ICON_DIR, `${name}.js`), 'utf8');
  /* Lucide keeps its old names as one-line re-exports — `alert-triangle` is
     now `triangle-alert`. Follow the alias rather than reporting a parse
     failure on a file that is perfectly fine and simply points elsewhere. */
  const alias = src.match(/export \{ default \} from '\.\/([\w-]+)\.js'/);
  if (alias) {
    console.log(`· ${name} is an alias for ${alias[1]}`);
    src = await readFile(join(ICON_DIR, `${alias[1]}.js`), 'utf8');
  }
  const m = src.match(/=\s*(\[[\s\S]*?\]);\s*\n/);
  if (!m) { console.error(`✗ could not parse ${name}.js`); continue; }
  /* The element array spans lines and holds nested objects, so a regex over the
     attributes gives up on the multi-line ones — which is how Release, Star and
     Settings silently came out empty the first time. Evaluate the literal. */
  const els = Function(`return ${m[1]}`)();
  const body = els.map(([tag, attrs]) => {
    const a = Object.entries(attrs)
      .filter(([k]) => k !== 'key')
      .map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag} ${a}/>`;
  }).join('');

  code = code.replace('\nconst ICONS = {\n', `\nconst ICONS = {\n  '${name}': ${JSON.stringify(body)},\n`);
  added.push(name);
}

if (added.length) {
  await writeFile(CODE, code);
  console.log(`✓ added ${added.join(', ')} — re-run the plugin in Figma to load it`);
} else {
  console.log('nothing added');
}
