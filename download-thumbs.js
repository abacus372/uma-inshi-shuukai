const fs = require('fs');
const https = require('https');
const path = require('path');

const supports = require('./data/supports.json');
const outDir = path.join(__dirname, 'data', 'thumbs');
fs.mkdirSync(outDir, { recursive: true });

function download(slug) {
  return new Promise((resolve) => {
    const dest = path.join(outDir, slug + '.png');
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) {
      return resolve({ slug, status: 'skip' });
    }
    const url = `https://raw.githubusercontent.com/daftuyda/UmaTools/main/assets/support_thumbs/${slug}.png`;
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ slug, status: 'http-' + res.statusCode });
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve({ slug, status: 'ok' })));
    }).on('error', (err) => resolve({ slug, status: 'error:' + err.message }));
  });
}

async function main() {
  const CONCURRENCY = 8;
  const queue = supports.map(s => s.slug);
  let idx = 0;
  let ok = 0, skip = 0, fail = 0;
  async function worker() {
    while (idx < queue.length) {
      const slug = queue[idx++];
      const r = await download(slug);
      if (r.status === 'ok') ok++;
      else if (r.status === 'skip') skip++;
      else { fail++; console.log('FAIL', r.slug, r.status); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log({ ok, skip, fail, total: queue.length });
}

main();
