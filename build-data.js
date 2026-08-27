const fs = require('fs');
const https = require('https');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SOURCE_DIR = path.join(__dirname, 'source-data');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'uma-inshi-shuukai-data-build' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

function writeJsonAndJs(name, varName, data) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(DATA_DIR, name + '.js'), `const ${varName} = ${JSON.stringify(data)};\n`);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) uma-inshi-shuukai-data-build (contact: github.com/abacus372/uma-inshi-shuukai)',
        'Accept': 'text/html',
        'Accept-Language': 'ja,en;q=0.8'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// Each support card's own training events (as opposed to the passive "hint" skill pool) can
// directly grant hint-eligibility for specific skills depending on which dialogue choice is
// picked. GameTora embeds the full per-choice breakdown in the page's Next.js data blob;
// UmaTools' own asset files don't carry it, so it's fetched straight from GameTora here.
function extractEventsFromHtml(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const props = data && data.props && data.props.pageProps;
  const raw = props && props.eventData && (props.eventData.ja || props.eventData.en);
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }

  const events = [];
  for (const bucket of Object.keys(parsed)) {
    const list = parsed[bucket];
    if (!Array.isArray(list)) continue;
    for (const ev of list) {
      const choices = (ev.c || []).map(c => ({
        text: c.o || '',
        skillIds: [...new Set((c.r || []).filter(r => r.t === 'sk' && r.d).map(r => String(r.d)))]
      }));
      if (choices.some(c => c.skillIds.length > 0)) {
        events.push({ id: ev.i, name: ev.n || '', choices });
      }
    }
  }
  return events;
}

async function fetchEventsForSupports(supports) {
  // Event kits never change once a card is released, so anything already successfully
  // fetched in a previous run is reused instead of re-fetching all 553 pages every time.
  let oldEventsById = new Map();
  try {
    const old = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'supports.json'), 'utf8'));
    for (const s of old) {
      if (Array.isArray(s.events)) oldEventsById.set(s.id, s.events);
    }
  } catch {}

  const CONCURRENCY = 6;
  const DELAY_MS = 150;
  let idx = 0, fetched = 0, cached = 0, failed = 0;

  async function worker() {
    while (idx < supports.length) {
      const s = supports[idx++];
      if (oldEventsById.has(s.id)) {
        s.events = oldEventsById.get(s.id);
        cached++;
        continue;
      }
      try {
        const html = await fetchText(`https://gametora.com/umamusume/supports/${s.slug}`);
        s.events = extractEventsFromHtml(html);
        fetched++;
      } catch (err) {
        console.error('event fetch failed for', s.slug, '-', err.message);
        s.events = null; // retry on next run, don't cache a failure as "confirmed empty"
        failed++;
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log('events: fetched', fetched, 'reused from cache', cached, 'failed', failed);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Support card -> hint skill list, and skill names/activation conditions, both come from
  // UmaTools (github.com/daftuyda/UmaTools), which auto-scrapes GameTora every 1-3 days and
  // is far more current than uma-skill-tools' bundled skill_data.json (which stopped getting
  // new skills in March 2026).
  const [supportHints, skillsAll] = await Promise.all([
    fetchJson('https://raw.githubusercontent.com/daftuyda/UmaTools/main/assets/support_hints.json'),
    fetchJson('https://raw.githubusercontent.com/daftuyda/UmaTools/main/assets/skills_all.json')
  ]);

  // Course geometry/track names are static game data (doesn't change with content updates),
  // so they're just committed under source-data/ instead of re-fetched every run.
  const courseData = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'course_data.json'), 'utf8'));
  const trackNames = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'tracknames.json'), 'utf8'));

  const supports = supportHints.map(c => ({
    id: c.SupportId,
    slug: c.SupportSlug,
    ja: c.SupportNameJP,
    en: c.SupportName,
    rarity: c.SupportRarity,
    type: c.SupportType,
    hints: [...new Set(c.SupportHints.filter(h => h.SkillId).map(h => h.SkillId))]
  }));
  await fetchEventsForSupports(supports);
  writeJsonAndJs('supports', 'DATA_SUPPORTS', supports);
  console.log('supports:', supports.length);

  const refIds = new Set();
  supports.forEach(s => {
    s.hints.forEach(id => refIds.add(id));
    (s.events || []).forEach(ev => ev.choices.forEach(c => c.skillIds.forEach(id => refIds.add(id))));
  });
  console.log('referenced skill ids:', refIds.size);

  const skillsById = new Map(skillsAll.map(s => [String(s.id), s]));
  let missing = 0;
  const skills = {};
  for (const id of refIds) {
    const sd = skillsById.get(id);
    skills[id] = {
      ja: sd ? sd.jpname : ('(不明 ' + id + ')'),
      en: sd ? sd.enname : '',
      conditions: sd ? sd.condition_groups.map(g => g.condition).filter(Boolean) : []
    };
    if (!sd) missing++;
  }
  writeJsonAndJs('skills', 'DATA_SKILLS', skills);
  console.log('skills.json entries:', Object.keys(skills).length, 'missing condition data:', missing);

  const courses = {};
  for (const [id, c] of Object.entries(courseData)) {
    courses[id] = {
      raceTrackId: c.raceTrackId,
      distance: c.distance,
      distanceType: c.distanceType,
      surface: c.surface,
      turn: c.turn
    };
  }
  writeJsonAndJs('courses', 'DATA_COURSES', courses);
  console.log('courses:', Object.keys(courses).length);

  writeJsonAndJs('tracknames', 'DATA_TRACKNAMES', trackNames);

  console.log('sizes:');
  ['supports', 'skills', 'courses', 'tracknames'].forEach(f => {
    console.log(f + '.js', fs.statSync(path.join(DATA_DIR, f + '.js')).size);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
