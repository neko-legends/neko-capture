// Packages neko-capture into a standalone app for this OS: dist/neko-capture-<platform>-<arch>/
// (Windows: neko-capture.exe). Run with `npm run build` or build.bat / build.sh.
import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zipDir = process.env.ELECTRON_ZIP_DIR; // optional: use an already-downloaded Electron zip

const out = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  name: 'neko-capture',
  overwrite: true,
  prune: true,
  asar: false,
  ignore: [/^\/dist($|\/)/, /^\/tools($|\/)/, /^\/\.github($|\/)/, /\.bat$/, /\.sh$/, /\.tmp$/],
  ...(zipDir ? { download: { cacheRoot: zipDir }, electronZipDir: zipDir } : {}),
});
console.log('\nBuilt:', out.join(', '));
