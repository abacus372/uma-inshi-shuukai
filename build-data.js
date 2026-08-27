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
  writeJsonAndJs('supports', 'DATA_SUPPORTS', supports);
  console.log('supports:', supports.length);

  const refIds = new Set();
  supports.forEach(s => s.hints.forEach(id => refIds.add(id)));
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
