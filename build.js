const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const output = path.resolve(root, process.env.BUILD_DIR || 'dist');
const files = [
  'index.html',
  'logo.png',
  'favicon.ico',
  'chart.umd.min.js',
  'xlsx.full.min.js'
];

fs.mkdirSync(output, { recursive: true });

for (const file of files) {
  const source = path.join(root, file);
  if (!fs.existsSync(source)) throw new Error(`Build asset is missing: ${file}`);
  fs.copyFileSync(source, path.join(output, file));
}

console.log(`Vercel static site built in ${output}`);
