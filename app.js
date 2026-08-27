(function () {
  'use strict';

  const DIRT_GRADE_TRACKS = [10101, 10103, 10104, 10105];
  const DISTANCE_TYPE_LABEL = { 1: '短距離', 2: 'マイル', 3: '中距離', 4: '長距離' };
  const TURN_LABEL = { 1: '右回り', 2: '左回り', 4: '直線' };
  const SURFACE_LABEL = { 1: '芝', 2: 'ダート' };
  const STORAGE_KEY = 'uma-inshi-shuukai-state-v1';

  // ---- build lookup structures -------------------------------------------------

  const supportById = new Map(DATA_SUPPORTS.map(s => [s.id, s]));
  const RARITY_ORDER = { SSR: 0, SR: 1, R: 2 };
  const TYPE_LABEL = { Speed: 'スピード', Stamina: 'スタミナ', Power: 'パワー', Guts: '根性', Wit: '賢さ', Friend: '友人', Group: 'グループ' };
  const thumbPath = s => `data/thumbs/${s.slug}.png`;
  const deckState = { main: ['', '', '', '', '', ''], farm: ['', '', '', '', '', ''] };
  let parentFactors = []; // skill ids manually added for the factor-farming parents' inherited white factors
  const eventChoiceState = {}; // cardId -> { eventId: chosenChoiceIndex }

  const coursesByTrack = new Map();
  for (const [courseId, c] of Object.entries(DATA_COURSES)) {
    const list = coursesByTrack.get(c.raceTrackId) || [];
    list.push({ id: courseId, ...c });
    coursesByTrack.set(c.raceTrackId, list);
  }
  for (const list of coursesByTrack.values()) {
    list.sort((a, b) => a.surface - b.surface || a.distance - b.distance);
  }

  function courseLabel(c) {
    return `${SURFACE_LABEL[c.surface] || c.surface} ${c.distance}m (${TURN_LABEL[c.turn] || c.turn})`;
  }

  // ---- DOM refs ------------------------------------------------------------------

  const trackSelect = document.getElementById('track-select');
  const courseSelect = document.getElementById('course-select');
  const courseSummary = document.getElementById('course-summary');
  const runningStyleSelect = document.getElementById('running-style-select');
  const seasonSelect = document.getElementById('season-select');
  const groundConditionSelect = document.getElementById('ground-condition-select');
  const weatherSelect = document.getElementById('weather-select');
  const runBtn = document.getElementById('run-btn');
  const saveBtn = document.getElementById('save-btn');
  const saveMsg = document.getElementById('save-msg');
  const resultSection = document.getElementById('result-section');
  const resultList = document.getElementById('result-list');
  const excludedList = document.getElementById('excluded-list');
  const unresolvedList = document.getElementById('unresolved-list');

  // ---- populate track / course selects --------------------------------------------

  const trackIds = Object.keys(DATA_TRACKNAMES)
    .filter(id => coursesByTrack.has(Number(id)))
    .sort((a, b) => Number(a) - Number(b));

  for (const id of trackIds) {
    const [ja] = DATA_TRACKNAMES[id];
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = ja;
    trackSelect.appendChild(opt);
  }

  function populateCourseSelect(trackId) {
    courseSelect.innerHTML = '';
    const list = coursesByTrack.get(Number(trackId)) || [];
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = courseLabel(c);
      courseSelect.appendChild(opt);
    }
    updateCourseSummary();
  }

  function currentCourse() {
    return DATA_COURSES[courseSelect.value];
  }

  function updateCourseSummary() {
    const c = currentCourse();
    if (!c) { courseSummary.textContent = ''; return; }
    const isDirtGrade = DIRT_GRADE_TRACKS.includes(c.raceTrackId);
    courseSummary.textContent =
      `${SURFACE_LABEL[c.surface]} / ${c.distance}m / ${DISTANCE_TYPE_LABEL[c.distanceType]} / ${TURN_LABEL[c.turn]}` +
      (isDirtGrade ? ' / 地方ダート扱い' : '');
  }

  trackSelect.addEventListener('change', () => populateCourseSelect(trackSelect.value));
  courseSelect.addEventListener('change', updateCourseSummary);

  // ---- deck slot UI: image-grid picker (553 cards, many sharing name+rarity+type, so plain text is ambiguous) --

  function buildDeckSlots(container, deckName) {
    container.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'slot-box';
      box.dataset.deck = deckName;
      box.dataset.slot = String(i);
      box.addEventListener('click', () => openPicker(deckName, i));
      container.appendChild(box);
    }
    renderDeckSlots(deckName);
  }

  function renderDeckSlots(deckName) {
    const boxes = document.querySelectorAll(`.slot-box[data-deck="${deckName}"]`);
    boxes.forEach((box, i) => {
      const s = supportById.get(deckState[deckName][i]);
      if (s) {
        box.classList.add('filled');
        box.innerHTML =
          `<img src="${thumbPath(s)}" alt="" loading="lazy">` +
          `<div class="slot-name">${s.ja}</div>` +
          `<div class="slot-hints">${s.hints.length} 種のヒント</div>` +
          `<span class="slot-clear" title="この枠をクリア">×</span>`;
        box.querySelector('.slot-clear').addEventListener('click', (e) => {
          e.stopPropagation();
          deckState[deckName][i] = '';
          renderDeckSlots(deckName);
        });
      } else {
        box.classList.remove('filled');
        box.innerHTML = `<div class="slot-empty">＋<br>サポカ ${i + 1}</div>`;
      }
    });
    renderEventChoicePanel();
  }

  function getDeckCards(deckName) {
    return deckState[deckName].map(id => supportById.get(id)).filter(Boolean);
  }

  // ---- picker modal ---------------------------------------------------------------

  const pickerModal = document.getElementById('picker-modal');
  const pickerSearch = document.getElementById('picker-search');
  const pickerGrid = document.getElementById('picker-grid');
  const pickerRarityFilters = document.getElementById('picker-rarity-filters');
  const pickerTypeFilters = document.getElementById('picker-type-filters');
  const pickerClose = document.getElementById('picker-close');

  let pickerTarget = null; // { deck, slot }
  let pickerChainMode = false; // true while filling empty slots one after another without closing
  let pickerRarity = 'ALL';
  let pickerType = 'ALL';

  const characterName = s => s.ja.replace(/\s*\([^)]*\)\s*$/, ''); // "スペシャルウィーク (SSR)" -> "スペシャルウィーク"

  function makeChip(label, value, currentGetter, setter) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.addEventListener('click', () => {
      setter(value);
      renderPickerChips();
      renderPickerGrid();
    });
    return chip;
  }

  function renderPickerChips() {
    pickerRarityFilters.innerHTML = '';
    [['全部', 'ALL'], ['SSR', 'SSR'], ['SR', 'SR'], ['R', 'R']].forEach(([label, value]) => {
      const chip = makeChip(label, value, () => pickerRarity, v => { pickerRarity = v; });
      if (pickerRarity === value) chip.classList.add('active');
      pickerRarityFilters.appendChild(chip);
    });
    pickerTypeFilters.innerHTML = '';
    [['全部', 'ALL']].concat(Object.entries(TYPE_LABEL).map(([k, v]) => [v, k])).forEach(([label, value]) => {
      const chip = makeChip(label, value, () => pickerType, v => { pickerType = v; });
      if (pickerType === value) chip.classList.add('active');
      pickerTypeFilters.appendChild(chip);
    });
  }

  function renderPickerGrid() {
    if (!pickerTarget) return;
    const otherCards = deckState[pickerTarget.deck]
      .filter((id, idx) => idx !== pickerTarget.slot && id)
      .map(id => supportById.get(id))
      .filter(Boolean);
    const usedIds = new Set(otherCards.map(s => s.id));
    const usedNames = new Set(otherCards.map(characterName));

    const q = pickerSearch.value.trim();
    const qLower = q.toLowerCase();
    let list = DATA_SUPPORTS.filter(s => {
      if (pickerRarity !== 'ALL' && s.rarity !== pickerRarity) return false;
      if (pickerType !== 'ALL' && s.type !== pickerType) return false;
      if (q && !(s.ja.includes(q) || s.en.toLowerCase().includes(qLower))) return false;
      return true;
    });
    list.sort((a, b) => {
      const ar = RARITY_ORDER[a.rarity] ?? 9, br = RARITY_ORDER[b.rarity] ?? 9;
      if (ar !== br) return ar - br;
      return a.ja.localeCompare(b.ja, 'ja');
    });

    pickerGrid.innerHTML = '';
    if (list.length === 0) {
      pickerGrid.innerHTML = '<p class="empty-msg">該当するサポカがありません</p>';
      return;
    }
    for (const s of list) {
      const sameCharacterUsed = !usedIds.has(s.id) && usedNames.has(characterName(s));
      const disabled = usedIds.has(s.id) || sameCharacterUsed;
      const item = document.createElement('div');
      item.className = 'picker-item' + (disabled ? ' disabled' : '');
      item.title = disabled
        ? (sameCharacterUsed ? 'この編成に同じウマ娘のカードが既にあります' : 'この編成の別の枠で使用中です')
        : '';
      item.innerHTML =
        `<img src="${thumbPath(s)}" alt="" loading="lazy">` +
        `<div class="picker-name">${s.ja}</div>` +
        `<div class="picker-type">${TYPE_LABEL[s.type] || s.type}</div>`;
      if (!disabled) {
        item.addEventListener('click', () => {
          deckState[pickerTarget.deck][pickerTarget.slot] = s.id;
          renderDeckSlots(pickerTarget.deck);
          if (pickerChainMode) {
            const nextEmpty = deckState[pickerTarget.deck].findIndex(id => !id);
            if (nextEmpty === -1) { closePicker(); return; }
            pickerTarget = { deck: pickerTarget.deck, slot: nextEmpty };
            pickerSearch.value = '';
            renderPickerGrid();
          } else {
            closePicker();
          }
        });
      }
      pickerGrid.appendChild(item);
    }
  }

  const pickerChainHint = document.getElementById('picker-chain-hint');

  function openPicker(deckName, slotIdx) {
    pickerTarget = { deck: deckName, slot: slotIdx };
    pickerChainMode = !deckState[deckName][slotIdx]; // started from an empty slot: keep filling the rest
    pickerChainHint.hidden = !pickerChainMode;
    pickerRarity = 'ALL';
    pickerType = 'ALL';
    pickerSearch.value = '';
    renderPickerChips();
    renderPickerGrid();
    pickerModal.hidden = false;
    pickerSearch.focus();
  }

  function closePicker() {
    pickerModal.hidden = true;
    pickerTarget = null;
    pickerChainMode = false;
  }

  pickerSearch.addEventListener('input', renderPickerGrid);
  pickerClose.addEventListener('click', closePicker);
  pickerModal.addEventListener('click', (e) => {
    if (e.target === pickerModal) closePicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pickerModal.hidden) closePicker();
  });

  // ---- support card events (choice-dependent hint skills) -------------------------

  function eventSkillsForCard(card) {
    const result = [];
    for (const ev of card.events || []) {
      const perCard = eventChoiceState[card.id] || {};
      const idx = perCard[ev.id] ?? 0; // default: top choice
      const choice = ev.choices[idx] || ev.choices[0];
      if (choice) result.push(...choice.skillIds);
    }
    return result;
  }

  function skillPool(cards) {
    // skillId -> Set of contributing source labels (card name, or card's event name)
    const map = new Map();
    function add(skillId, label) {
      if (!map.has(skillId)) map.set(skillId, new Set());
      map.get(skillId).add(label);
    }
    for (const c of cards) {
      for (const skillId of c.hints) add(skillId, c.ja);
      for (const skillId of eventSkillsForCard(c)) add(skillId, `${c.ja}のイベント`);
    }
    return map;
  }

  const eventChoiceSection = document.getElementById('event-choice-section');
  const eventChoiceList = document.getElementById('event-choice-list');

  function renderEventChoicePanel() {
    const seen = new Map();
    for (const c of [...getDeckCards('main'), ...getDeckCards('farm')]) {
      if (!seen.has(c.id) && c.events && c.events.length) seen.set(c.id, c);
    }
    const cards = [...seen.values()];
    eventChoiceList.innerHTML = '';
    eventChoiceSection.hidden = cards.length === 0;
    if (cards.length === 0) return;

    for (const card of cards) {
      const box = document.createElement('div');
      box.className = 'event-card';
      const h4 = document.createElement('h4');
      h4.textContent = card.ja;
      box.appendChild(h4);

      if (!eventChoiceState[card.id]) eventChoiceState[card.id] = {};

      for (const ev of card.events) {
        const evDiv = document.createElement('div');
        evDiv.className = 'event-item';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'event-item-name';
        nameDiv.textContent = ev.name;
        evDiv.appendChild(nameDiv);

        const currentIdx = eventChoiceState[card.id][ev.id] ?? 0;
        ev.choices.forEach((choice, idx) => {
          const row = document.createElement('label');
          row.className = 'event-choice-row';
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = `event-${card.id}-${ev.id}`;
          radio.checked = idx === currentIdx;
          radio.addEventListener('change', () => {
            eventChoiceState[card.id][ev.id] = idx;
          });
          row.appendChild(radio);
          const textSpan = document.createElement('span');
          textSpan.textContent = choice.text || `(選択肢${idx + 1})`;
          row.appendChild(textSpan);
          if (choice.skillIds.length) {
            const skillsSpan = document.createElement('span');
            skillsSpan.className = 'event-choice-skills';
            skillsSpan.textContent = '→ ' + choice.skillIds.map(id => (DATA_SKILLS[id] ? DATA_SKILLS[id].ja : id)).join('、');
            row.appendChild(skillsSpan);
          }
          evDiv.appendChild(row);
        });
        box.appendChild(evDiv);
      }
      eventChoiceList.appendChild(box);
    }
  }

  // ---- parent factors (manual skill add) -------------------------------------------

  const factorSearchInput = document.getElementById('factor-search');
  const factorSearchResults = document.getElementById('factor-search-results');
  const factorChipsEl = document.getElementById('factor-chips');
  const factorBulkInput = document.getElementById('factor-bulk-input');
  const factorBulkAddBtn = document.getElementById('factor-bulk-add-btn');
  const factorBulkResult = document.getElementById('factor-bulk-result');

  // This whole section is specifically for white factors (因子周回親の白因子): a gold
  // skill is what a white skill becomes after being combined with specific other factors,
  // and its factor card doesn't display under the gold skill's own name -- so matching a
  // typed/pasted/OCR'd name against gold (or unique) skill entries here can only ever be
  // wrong, never a legitimate find. Restricting every name-based lookup in this section to
  // rarity 1 removes that as a source of bad matches entirely, rather than just letting it
  // occasionally win a fuzzy match by accident.
  const whiteSkillEntries = Object.entries(DATA_SKILLS).filter(([, sk]) => sk.rarity === 1);

  function searchSkills(query) {
    const q = query.trim();
    if (!q) return [];
    const qLower = q.toLowerCase();
    const matches = whiteSkillEntries.filter(([, sk]) =>
      (sk.ja && sk.ja.includes(q)) || (sk.en && sk.en.toLowerCase().includes(qLower))
    );
    matches.sort((a, b) => a[1].ja.localeCompare(b[1].ja, 'ja'));
    return matches.slice(0, 30);
  }

  function addParentFactor(id) {
    if (!parentFactors.includes(id)) parentFactors.push(id);
  }

  function renderFactorChips() {
    factorChipsEl.innerHTML = '';
    if (parentFactors.length === 0) {
      factorChipsEl.innerHTML = '<span class="hint-text">まだ追加されていません</span>';
      return;
    }
    for (const id of parentFactors) {
      const sk = DATA_SKILLS[id];
      const chip = document.createElement('span');
      chip.className = 'chip removable';
      chip.innerHTML = `${sk ? sk.ja : id} <span class="chip-x">×</span>`;
      chip.querySelector('.chip-x').addEventListener('click', () => {
        parentFactors = parentFactors.filter(x => x !== id);
        renderFactorChips();
      });
      factorChipsEl.appendChild(chip);
    }
  }

  document.getElementById('factor-clear-all-btn').addEventListener('click', () => {
    if (parentFactors.length === 0) return;
    if (!confirm(`因子周回親の白因子を全て削除します（${parentFactors.length}件）。よろしいですか？`)) return;
    parentFactors = [];
    renderFactorChips();
  });

  factorSearchInput.addEventListener('input', () => {
    const matches = searchSkills(factorSearchInput.value);
    factorSearchResults.innerHTML = '';
    if (matches.length === 0) {
      factorSearchResults.hidden = true;
      return;
    }
    for (const [id, sk] of matches) {
      const item = document.createElement('div');
      item.className = 'combo-item';
      item.textContent = sk.ja + (sk.en ? ` (${sk.en})` : '');
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        addParentFactor(id);
        renderFactorChips();
        factorSearchInput.value = '';
        factorSearchResults.hidden = true;
      });
      factorSearchResults.appendChild(item);
    }
    factorSearchResults.hidden = false;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#parent-factors-section')) factorSearchResults.hidden = true;
  });
  factorSearchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const matches = searchSkills(factorSearchInput.value);
    if (matches.length === 0) return;
    const [id] = matches[0];
    addParentFactor(id);
    renderFactorChips();
    factorSearchInput.value = '';
    factorSearchResults.hidden = true;
  });

  function addFactorsByNameTokens(text) {
    const tokens = text.split(/[\n,、]/).map(t => t.trim()).filter(Boolean);
    const added = [];
    const notFound = [];
    for (const token of tokens) {
      let hit = whiteSkillEntries.find(([, sk]) => sk.ja === token || sk.en === token);
      if (!hit) hit = whiteSkillEntries.find(([, sk]) => sk.ja && sk.ja.startsWith(token));
      if (hit) { addParentFactor(hit[0]); added.push(hit[1].ja); }
      else notFound.push(token);
    }
    return { added, notFound };
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[n];
  }

  // OCR-only: garbled game-UI text tends to be off by one or two characters (a misread
  // kanji, a stray symbol from an icon). Exact/prefix matching (as used everywhere else)
  // would just drop these; nearest-neighbor-by-edit-distance rescues most of them, at the
  // cost of an occasional wrong guess -- which is why fuzzy hits are called out separately
  // in the result message rather than silently mixed in with confident matches.
  const skillEntries = whiteSkillEntries;
  const SKILL_NAME_CHARSET = [...new Set(skillEntries.map(([, sk]) => sk.ja).join(''))].join('');

  // Short words need proportionally more slack than long ones: two substitutions in a
  // 4-character name is a completely typical OCR miss ("滾る想い" -> "涼る起い") but is
  // already 50% of the string, so a flat 30% cutoff would reject it outright.
  function fuzzyThreshold(len) {
    return Math.max(1, Math.round(len * 0.4));
  }

  function fuzzyFindSkillScored(token) {
    if (!token) return null;
    let best = null, bestDist = Infinity;
    for (const entry of skillEntries) {
      const d = levenshtein(token, entry[1].ja);
      if (d < bestDist) { bestDist = d; best = entry; }
    }
    return best ? { entry: best, dist: bestDist } : null;
  }

  function fuzzyFindSkill(token) {
    if (!token || token.length < 2) return null;
    const scored = fuzzyFindSkillScored(token);
    if (!scored) return null;
    const threshold = fuzzyThreshold(Math.max(token.length, scored.entry[1].ja.length));
    return scored.dist <= threshold ? scored.entry : null;
  }

  // Scanning every substring against the dictionary (below) multiplies the number of
  // chances for an accidental near-match compared to a single whole-token comparison, and
  // short skill names are the most exposed: two 4-character names sharing a real 3-character
  // prefix by pure naming coincidence (e.g. "プランX" and "プランチャ☆ガナドール", one a
  // real skill and one a character-unique factor this tool doesn't track) are only one edit
  // apart, well inside a normal fuzzy tolerance. Requiring near-exact agreement for short
  // names -- while still allowing the usual slack for longer ones, where a coincidental
  // near-match across that many characters is far less likely -- keeps the fused-line
  // recovery without resurrecting short unrelated names.
  function extractionThreshold(len) {
    // Note this doesn't fully solve short-name false positives: "中盤巧者" (a real,
    // wanted catch) and "プランX" (a coincidental false one pulled from unrelated
    // out-of-scope text) are both exactly 4 characters, one edit away from their OCR
    // substring, and otherwise indistinguishable by length/distance alone. Capping well
    // below the whole-token fuzzy ratio still meaningfully cuts the false-positive rate
    // for longer short names (a 6-character name no longer tolerates 2 edits), and every
    // extracted match is surfaced as "要確認" specifically because this residual risk
    // can't be fully engineered away without more signal than length and edit distance.
    if (len <= 6) return 1;
    return fuzzyThreshold(len);
  }

  // A dense grid of short list rows sometimes gets OCR'd with the line break dropped
  // entirely, so a blob can be: two fused factor names ("中蟹巧者涼る起い"), or a real
  // skill fused with something out of scope (a race-name factor like "JDダービー", which
  // isn't a skill at all and will never be in the dictionary). Rather than requiring the
  // whole blob to decompose into exactly two dictionary hits, find whichever contiguous
  // substring best matches some skill, extract it, and recurse on what's left on each
  // side -- that recovers a real skill wherever it sits, and simply gives up on the
  // remainder if it's genuine noise (or out-of-scope text) instead of failing the whole
  // token because of it.
  function extractKnownSkillsFromBlob(token, depth) {
    if (!token || token.length < 3 || depth > 4) return [];
    let best = null; // { start, end, entry, dist }
    const maxLen = Math.min(token.length, 12);
    for (let len = maxLen; len >= 3; len--) {
      for (let start = 0; start + len <= token.length; start++) {
        const sub = token.slice(start, start + len);
        const scored = fuzzyFindSkillScored(sub);
        if (!scored) continue;
        const threshold = extractionThreshold(scored.entry[1].ja.length);
        if (scored.dist > threshold) continue;
        if (!best || scored.dist < best.dist || (scored.dist === best.dist && len > best.end - best.start)) {
          best = { start, end: start + len, entry: scored.entry, dist: scored.dist };
        }
      }
    }
    if (!best) return [];
    const before = extractKnownSkillsFromBlob(token.slice(0, best.start), depth + 1);
    const after = extractKnownSkillsFromBlob(token.slice(best.end), depth + 1);
    return [...before, best.entry, ...after];
  }

  function cleanOcrToken(token) {
    // Game UI renders a small circular bullet before each factor name, which OCR often
    // turns into leading/trailing punctuation noise ("。", ")", "|", etc.) rather than
    // dropping it -- strip that before either exact or fuzzy matching sees the token.
    return token.replace(/^[\s。、・.)）|｜「『]+/, '').replace(/[\s。、・.)）|｜」』]+$/, '');
  }

  function addFactorsFromOcrText(text) {
    // OCR sometimes renders what was a line break as a stray pipe/bullet character
    // instead of an actual "\n" (e.g. "マイルコーナー〇|。ギアシフト" for two list rows),
    // so those are treated as separators here too, unlike the plain-text paste paths.
    const tokens = text.split(/[\n,、|｜•]/).map(t => cleanOcrToken(t.trim())).filter(Boolean);
    const added = [];
    const fuzzyAdded = [];
    const notFound = [];
    for (const token of tokens) {
      let hit = skillEntries.find(([, sk]) => sk.ja === token || sk.en === token);
      if (!hit) hit = skillEntries.find(([, sk]) => sk.ja && sk.ja.startsWith(token));
      if (hit) { addParentFactor(hit[0]); added.push(hit[1].ja); continue; }
      const fuzzy = fuzzyFindSkill(token);
      if (fuzzy) { addParentFactor(fuzzy[0]); fuzzyAdded.push(`${token}→${fuzzy[1].ja}`); continue; }
      const extracted = extractKnownSkillsFromBlob(token, 0);
      if (extracted.length > 0) {
        for (const entry of extracted) addParentFactor(entry[0]);
        fuzzyAdded.push(`${token}→${extracted.map(e => e[1].ja).join('+')}`);
        continue;
      }
      notFound.push(token);
    }
    return { added, fuzzyAdded, notFound };
  }

  factorBulkAddBtn.addEventListener('click', () => {
    const { added, notFound } = addFactorsByNameTokens(factorBulkInput.value);
    renderFactorChips();
    let msg = '';
    if (added.length) msg += `${added.length}件追加しました。`;
    if (notFound.length) msg += ` 見つからなかったもの: ${notFound.join('、')}`;
    factorBulkResult.textContent = msg;
    if (added.length && notFound.length === 0) factorBulkInput.value = '';
  });

  // ---- OCR from screenshot (experimental) ------------------------------------------
  // Runs entirely in the browser via Tesseract.js (CDN-loaded); nothing is uploaded
  // anywhere. No region selection, no manual color pick, no manual height measurement:
  // the small circular bullet icon at the left edge of every factor card is a fixed,
  // distinctive color regardless of which factor the card holds, so scanning the whole
  // image for blobs of that color and reconstructing each card's box from proportions
  // measured once against data/templates/factor_card_blank.png locates every card
  // automatically. Each candidate card is then classified white/not-white by its own
  // background color, and only white (common skill factor) cards are OCR'd, each one
  // completely separately so two cards can never fuse into one blob.

  const factorOcrFileInput = document.getElementById('factor-ocr-file');
  const factorOcrDropzone = document.getElementById('factor-ocr-dropzone');
  const factorOcrCanvasesContainer = document.getElementById('factor-ocr-canvases');
  const factorOcrRunCardsBtn = document.getElementById('factor-ocr-run-cards-btn');
  const factorOcrRunFullBtn = document.getElementById('factor-ocr-run-full-btn');
  const factorOcrClearBtn = document.getElementById('factor-ocr-clear-btn');
  const factorOcrProgress = document.getElementById('factor-ocr-progress');
  const factorOcrResult = document.getElementById('factor-ocr-result');

  // One entry per loaded image: { img, fullCanvas (natural resolution, used for
  // detection/OCR), previewCanvas (scaled-down, shown to the user + overlay), scale }.
  // Several screenshots (e.g. one per parent uma) can be loaded and processed together
  // in a single pass, with all of their factors added at once.
  let factorOcrEntries = [];

  // Measured once from data/templates/factor_card_blank.png (302x63px; the bullet icon is
  // a ~19px-diameter blob centered at (23,27)). Expressed relative to the icon's own
  // diameter/center rather than as fixed pixel sizes, so detection works regardless of
  // the screenshot's actual resolution.
  const CARD_TEMPLATE = {
    widthPerIconDiameter: 302 / 19,
    heightPerIconDiameter: 63 / 19,
    iconCenterXFrac: 23 / 302,
    iconCenterYFrac: 27 / 63
  };

  function drawOcrEntryCanvas(entry) {
    entry.ctx.clearRect(0, 0, entry.previewCanvas.width, entry.previewCanvas.height);
    entry.ctx.drawImage(entry.img, 0, 0, entry.previewCanvas.width, entry.previewCanvas.height);
  }

  function loadOcrImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxW = 460;
          const scale = Math.min(1, maxW / img.naturalWidth);
          const previewCanvas = document.createElement('canvas');
          previewCanvas.className = 'factor-ocr-preview-canvas';
          previewCanvas.width = Math.round(img.naturalWidth * scale);
          previewCanvas.height = Math.round(img.naturalHeight * scale);

          const fullCanvas = document.createElement('canvas');
          fullCanvas.width = img.naturalWidth;
          fullCanvas.height = img.naturalHeight;
          fullCanvas.getContext('2d').drawImage(img, 0, 0);

          const entry = { img, fullCanvas, previewCanvas, ctx: previewCanvas.getContext('2d'), scale };
          drawOcrEntryCanvas(entry);
          resolve(entry);
        };
        img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
      reader.readAsDataURL(file);
    });
  }

  function updateOcrDropzoneLabel() {
    factorOcrDropzone.textContent = factorOcrEntries.length === 0
      ? 'クリックしてから画像を貼り付け'
      : `画像を${factorOcrEntries.length}枚読み込み済み（クリックしてさらに追加で貼り付け）`;
    factorOcrDropzone.classList.toggle('has-image', factorOcrEntries.length > 0);
    factorOcrClearBtn.disabled = factorOcrEntries.length === 0;
  }

  // Each call adds to the existing set rather than replacing it, so loading factors from
  // several screenshots (one per parent uma, say) is just "select/paste again" repeated,
  // not something that has to happen all in one selection.
  async function loadOcrFiles(files) {
    const imageFiles = Array.from(files).filter(f => f.type && f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    factorOcrRunCardsBtn.disabled = true;
    factorOcrRunFullBtn.disabled = true;
    factorOcrResult.textContent = '';
    factorOcrDropzone.textContent = '読み込み中…';

    const newEntries = await Promise.all(imageFiles.map(loadOcrImageFile));

    factorOcrEntries = factorOcrEntries.concat(newEntries);
    for (const entry of newEntries) factorOcrCanvasesContainer.appendChild(entry.previewCanvas);

    updateOcrDropzoneLabel();
    factorOcrRunCardsBtn.disabled = false;
    factorOcrRunFullBtn.disabled = false;
  }

  function clearOcrEntries() {
    factorOcrEntries = [];
    factorOcrCanvasesContainer.innerHTML = '';
    factorOcrResult.textContent = '';
    factorOcrRunCardsBtn.disabled = true;
    factorOcrRunFullBtn.disabled = true;
    updateOcrDropzoneLabel();
  }

  factorOcrFileInput.addEventListener('change', () => {
    loadOcrFiles(factorOcrFileInput.files);
    factorOcrFileInput.value = ''; // otherwise re-selecting the same file(s) again wouldn't fire 'change'
  });
  factorOcrDropzone.addEventListener('click', () => factorOcrDropzone.focus());
  factorOcrDropzone.addEventListener('paste', (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const files = items.filter(it => it.type && it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
    if (files.length === 0) return;
    loadOcrFiles(files);
  });
  factorOcrClearBtn.addEventListener('click', clearOcrEntries);

  // ---- automatic card detection -------------------------------------------------

  // The icon is a saturated blue-lavender circle; "blue channel clearly dominant" is a
  // structural rule (not a fixed RGB match) so it tolerates compression/scaling
  // differences across different screenshots better than an exact color distance would.
  function isIconBlue(r, g, b) {
    return b - r > 25 && b > 150 && g >= r - 5;
  }

  // The card's own background is a near-white light gray in the template; classifying by
  // "bright and channels close together" separates it from green/blue/pink category cards
  // without needing the user to calibrate a reference color by hand.
  function isCardWhite(r, g, b) {
    const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
    return maxC > 195 && (maxC - minC) < 22;
  }

  // Connected-component labeling (flood fill, 4-connectivity) over a boolean mask,
  // returning each blob's pixel count and bounding box.
  function findBlobs(mask, width, height) {
    const visited = new Uint8Array(width * height);
    const blobs = [];
    const stack = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!mask[idx] || visited[idx]) continue;
        let minX = x, maxX = x, minY = y, maxY = y, count = 0;
        stack.push(idx);
        visited[idx] = 1;
        while (stack.length) {
          const cur = stack.pop();
          const cx = cur % width, cy = (cur / width) | 0;
          count++;
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
          if (cx > 0 && !visited[cur - 1] && mask[cur - 1]) { visited[cur - 1] = 1; stack.push(cur - 1); }
          if (cx < width - 1 && !visited[cur + 1] && mask[cur + 1]) { visited[cur + 1] = 1; stack.push(cur + 1); }
          if (cur - width >= 0 && !visited[cur - width] && mask[cur - width]) { visited[cur - width] = 1; stack.push(cur - width); }
          if (cur + width < mask.length && !visited[cur + width] && mask[cur + width]) { visited[cur + width] = 1; stack.push(cur + width); }
        }
        blobs.push({ minX, maxX, minY, maxY, count });
      }
    }
    return blobs;
  }

  // Averages a small patch of pixels instead of a single point, so one unlucky pixel
  // (dithering, JPEG block noise) landing on a slightly-off color doesn't flip the
  // white/not-white classification of an otherwise-uniform card background.
  function sampleAreaColor(ctx, cx, cy, radius, maxW, maxH) {
    const x0 = Math.max(0, Math.round(cx - radius));
    const y0 = Math.max(0, Math.round(cy - radius));
    const w = Math.min(maxW - x0, radius * 2);
    const h = Math.min(maxH - y0, radius * 2);
    if (w <= 0 || h <= 0) return [255, 255, 255];
    const data = ctx.getImageData(x0, y0, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    return [r / n, g / n, b / n];
  }

  // Scans the whole image for icon-colored blobs, reconstructs each one's full card box
  // from the template proportions, and classifies each by its own sampled background
  // color. Returns every detected card (both white and not), so the caller can report
  // what was found and excluded, not just what got OCR'd.
  function detectCards(fullCanvas) {
    const w = fullCanvas.width, h = fullCanvas.height;
    // A full desktop/game screenshot is mostly unrelated UI at a resolution where the
    // factor list's own icons are tiny (often well under 30px across); downscaling much
    // further than that before color-thresholding blurs exactly the small blobs that
    // matter most, while big background UI elements survive the blur just fine -- which
    // in practice showed up as real cards going undetected while unrelated menu icons
    // got picked up instead. So detection only downscales for genuinely huge screenshots,
    // and even then keeps most of the resolution.
    const detectScale = Math.min(1, 1800 / w);
    const dw = Math.max(1, Math.round(w * detectScale));
    const dh = Math.max(1, Math.round(h * detectScale));
    const small = document.createElement('canvas');
    small.width = dw;
    small.height = dh;
    const sctx = small.getContext('2d');
    sctx.drawImage(fullCanvas, 0, 0, dw, dh);
    const data = sctx.getImageData(0, 0, dw, dh).data;

    const mask = new Uint8Array(dw * dh);
    for (let i = 0; i < dw * dh; i++) {
      const o = i * 4;
      if (isIconBlue(data[o], data[o + 1], data[o + 2])) mask[i] = 1;
    }

    const blobs = findBlobs(mask, dw, dh)
      .map(b => ({
        w: b.maxX - b.minX + 1,
        h: b.maxY - b.minY + 1,
        cx: (b.minX + b.maxX) / 2,
        cy: (b.minY + b.maxY) / 2,
        count: b.count
      }))
      // keep roughly circular, plausibly-icon-sized blobs; discard specks and stray edges.
      // A busy screenshot's incidental blue patches (sky, distant scenery, gradient UI
      // chrome) tend to be thin slivers or irregular blotches rather than a filled disc,
      // so also requiring most of the bounding box to actually be filled (count/(w*h),
      // ~0.785 for a perfect circle) screens out a lot of those before they ever reach
      // the column/pitch check below.
      .filter(b => b.count >= 6 && b.w >= 3 && b.h >= 3 && b.w <= 80 && b.h <= 80 &&
        Math.max(b.w, b.h) / Math.min(b.w, b.h) <= 1.8 &&
        b.count / (b.w * b.h) >= 0.55);

    const fullCtx = fullCanvas.getContext('2d');
    let candidates = [];
    for (const blob of blobs) {
      const diameter = (blob.w + blob.h) / 2 / detectScale;
      const cx = blob.cx / detectScale;
      const cy = blob.cy / detectScale;
      const cardW = diameter * CARD_TEMPLATE.widthPerIconDiameter;
      const cardH = diameter * CARD_TEMPLATE.heightPerIconDiameter;
      const x = Math.max(0, Math.round(cx - CARD_TEMPLATE.iconCenterXFrac * cardW));
      const y = Math.max(0, Math.round(cy - CARD_TEMPLATE.iconCenterYFrac * cardH));
      const cw = Math.min(w - x, Math.round(cardW));
      const ch = Math.min(h - y, Math.round(cardH));
      if (cw < 10 || ch < 10) continue;
      candidates.push({ x, y, w: cw, h: ch, iconX: cx, iconDiameter: diameter });
    }

    // Anti-aliasing can split one real icon into two adjacent blobs; collapse duplicates
    // whose reconstructed card boxes are near-identical before continuing.
    const deduped = [];
    for (const c of candidates) {
      const ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
      const dup = deduped.find(d => Math.abs((d.x + d.w / 2) - ccx) < d.w * 0.3 && Math.abs((d.y + d.h / 2) - ccy) < d.h * 0.3);
      if (!dup) deduped.push(c);
    }
    candidates = deduped;

    // A real factor list is a column of several cards stacked at one consistent pitch
    // (each card's own height). Just requiring "some other similarly-sized blob at
    // roughly the same x" isn't a strong enough test on a busy screenshot -- a game's
    // side menu is itself a column of repeated buttons, and even scenery can coincidentally
    // line up a pair. Requiring at least two *other* candidates at that same x whose
    // vertical offset is close to a whole multiple of the card height is a much rarer
    // coincidence, so it's a far more reliable signal that this is really part of a list.
    const survivors = candidates.filter(c => {
      let partners = 0;
      for (const o of candidates) {
        if (o === c) continue;
        if (Math.abs(o.iconX - c.iconX) >= c.iconDiameter * 1.2) continue;
        if (Math.abs(o.iconDiameter - c.iconDiameter) >= c.iconDiameter * 0.4) continue;
        const dy = Math.abs(o.y - c.y);
        const steps = dy / c.h;
        if (Math.abs(steps - Math.round(steps)) < 0.25 && Math.round(steps) >= 1) partners++;
      }
      return partners >= 2;
    });

    return survivors.map(c => {
      // Sample the background away from both the icon (far left) and the star row
      // (center-right): the upper-right quadrant is clear of both on the template.
      const sampleX = Math.min(w - 1, Math.round(c.x + c.w * 0.62));
      const sampleY = Math.min(h - 1, Math.round(c.y + c.h * 0.25));
      const [r, g, b] = sampleAreaColor(fullCtx, sampleX, sampleY, Math.max(2, Math.round(c.h * 0.08)), w, h);
      return { x: c.x, y: c.y, w: c.w, h: c.h, isWhite: isCardWhite(r, g, b) };
    });
  }

  factorOcrRunCardsBtn.addEventListener('click', async () => {
    if (factorOcrEntries.length === 0) return;
    if (typeof Tesseract === 'undefined') {
      factorOcrResult.textContent = 'OCRライブラリを読み込めませんでした（オフライン、または通信環境の問題の可能性があります）';
      return;
    }
    factorOcrRunCardsBtn.disabled = true;
    factorOcrRunFullBtn.disabled = true;
    factorOcrResult.textContent = '';
    factorOcrProgress.textContent = 'カードを検出中…';

    // Detection runs per image (each has its own resolution/scale), but every white card
    // found across every loaded image is queued into one flat list so a single Tesseract
    // worker can be reused for all of them instead of spinning one up per image.
    let totalExcluded = 0;
    const queue = []; // { entry, card }
    for (const entry of factorOcrEntries) {
      const allCards = detectCards(entry.fullCanvas);
      drawOcrEntryCanvas(entry);
      for (const c of allCards) {
        entry.ctx.strokeStyle = c.isWhite ? '#2fa84f' : '#999999';
        entry.ctx.lineWidth = 2;
        entry.ctx.strokeRect(c.x * entry.scale, c.y * entry.scale, c.w * entry.scale, c.h * entry.scale);
        if (c.isWhite) queue.push({ entry, card: c });
        else totalExcluded++;
      }
    }

    if (queue.length === 0) {
      factorOcrProgress.textContent = '';
      factorOcrResult.textContent = totalExcluded === 0
        ? 'カードを検出できませんでした。画像全体をそのまま読み取るか、別の画像で試してください。'
        : `カードを検出しましたが、白背景と判定できるものがありませんでした。`;
      factorOcrRunCardsBtn.disabled = false;
      factorOcrRunFullBtn.disabled = false;
      return;
    }

    const upscale = 3;
    try {
      const worker = await Tesseract.createWorker('jpn');
      // PSM 7 ("single text line"): each crop is exactly one card now, not a multi-row
      // composite, so this is a closer match than the multi-row PSM 4 used elsewhere.
      await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: SKILL_NAME_CHARSET });
      const lines = [];
      for (let i = 0; i < queue.length; i++) {
        factorOcrProgress.textContent = `認識中… (${i + 1}/${queue.length}枚目)`;
        const { entry, card: c } = queue[i];
        const crop = document.createElement('canvas');
        crop.width = c.w * upscale;
        crop.height = c.h * upscale;
        const cropCtx = crop.getContext('2d');
        cropCtx.imageSmoothingEnabled = false;
        cropCtx.drawImage(entry.fullCanvas, c.x, c.y, c.w, c.h, 0, 0, crop.width, crop.height);
        const { data } = await worker.recognize(crop.toDataURL());
        lines.push(data.text.replace(/\s+/g, ''));
      }
      await worker.terminate();
      factorOcrProgress.textContent = '';
      const { added, fuzzyAdded, notFound } = addFactorsFromOcrText(lines.join('\n'));
      renderFactorChips();
      const imageNote = factorOcrEntries.length > 1 ? `画像${factorOcrEntries.length}枚 / ` : '';
      let msg = `[自動検出: ${imageNote}白背景${queue.length}枚 / 除外${totalExcluded}枚] OCR結果から${added.length}件追加しました。`;
      if (fuzzyAdded.length) msg += ` あいまい一致で追加（要確認）: ${fuzzyAdded.join('、')}`;
      if (notFound.length) msg += ` 対応するスキルが見つからなかった行: ${notFound.join('、')}`;
      factorOcrResult.textContent = msg;
    } catch (err) {
      factorOcrProgress.textContent = '';
      factorOcrResult.textContent = 'OCRに失敗しました: ' + err.message;
    } finally {
      factorOcrRunCardsBtn.disabled = false;
      factorOcrRunFullBtn.disabled = false;
    }
  });

  factorOcrRunFullBtn.addEventListener('click', async () => {
    if (factorOcrEntries.length === 0) return;
    if (typeof Tesseract === 'undefined') {
      factorOcrResult.textContent = 'OCRライブラリを読み込めませんでした（オフライン、または通信環境の問題の可能性があります）';
      return;
    }
    factorOcrRunCardsBtn.disabled = true;
    factorOcrRunFullBtn.disabled = true;
    factorOcrProgress.textContent = '認識中…（初回は言語データのダウンロードで時間がかかります）';
    factorOcrResult.textContent = '';
    try {
      const worker = await Tesseract.createWorker('jpn');
      await worker.setParameters({ tessedit_pageseg_mode: '4', tessedit_char_whitelist: SKILL_NAME_CHARSET });
      const allText = [];
      for (let i = 0; i < factorOcrEntries.length; i++) {
        if (factorOcrEntries.length > 1) factorOcrProgress.textContent = `認識中…（画像 ${i + 1}/${factorOcrEntries.length}）`;
        // Use the original image at its natural resolution, not the (possibly downscaled)
        // preview canvas -- feeding OCR an already-shrunk copy only makes small text worse.
        const { data } = await worker.recognize(factorOcrEntries[i].fullCanvas.toDataURL());
        allText.push(data.text.split('\n').map(line => line.replace(/\s+/g, '')).join('\n'));
      }
      await worker.terminate();
      factorOcrProgress.textContent = '';
      const { added, fuzzyAdded, notFound } = addFactorsFromOcrText(allText.join('\n'));
      renderFactorChips();
      let msg = `OCR結果から${added.length}件追加しました。`;
      if (fuzzyAdded.length) msg += ` あいまい一致で追加（要確認）: ${fuzzyAdded.join('、')}`;
      if (notFound.length) msg += ` 対応するスキルが見つからなかった行: ${notFound.join('、')}`;
      factorOcrResult.textContent = msg;
    } catch (err) {
      factorOcrProgress.textContent = '';
      factorOcrResult.textContent = 'OCRに失敗しました: ' + err.message;
    } finally {
      factorOcrRunCardsBtn.disabled = false;
      factorOcrRunFullBtn.disabled = false;
    }
  });

  // ---- browse-and-multi-select list for parent factors -----------------------------

  const factorListOpenBtn = document.getElementById('factor-list-open-btn');
  const factorListModal = document.getElementById('factor-list-modal');
  const factorListSearch = document.getElementById('factor-list-search');
  const factorListItems = document.getElementById('factor-list-items');
  const factorListClose = document.getElementById('factor-list-close');

  const allSkillEntriesSorted = whiteSkillEntries.slice().sort((a, b) => a[1].ja.localeCompare(b[1].ja, 'ja'));

  function renderFactorListItems() {
    const q = factorListSearch.value.trim();
    const qLower = q.toLowerCase();
    const list = q
      ? allSkillEntriesSorted.filter(([, sk]) => sk.ja.includes(q) || (sk.en && sk.en.toLowerCase().includes(qLower)))
      : allSkillEntriesSorted;

    factorListItems.innerHTML = '';
    if (list.length === 0) {
      factorListItems.innerHTML = '<p class="empty-msg">該当するスキルがありません</p>';
      return;
    }
    for (const [id, sk] of list) {
      const selected = parentFactors.includes(id);
      const [badgeLabel, badgeClass] = SKILL_RARITY_BADGE[sk.rarity] || ['?', 'unknown'];
      const item = document.createElement('div');
      item.className = 'factor-list-item' + (selected ? ' selected' : '');
      item.innerHTML =
        `<span class="factor-list-item-check">${selected ? '✓' : ''}</span>` +
        `<span class="skill-rarity-badge skill-rarity-${badgeClass} factor-list-item-badge">${badgeLabel}</span>` +
        `<span class="factor-list-item-name">${sk.ja}</span>` +
        (sk.en ? `<span class="factor-list-item-en">(${sk.en})</span>` : '');
      item.addEventListener('click', () => {
        if (parentFactors.includes(id)) {
          parentFactors = parentFactors.filter(x => x !== id);
        } else {
          addParentFactor(id);
        }
        renderFactorChips();
        renderFactorListItems();
      });
      factorListItems.appendChild(item);
    }
  }

  factorListOpenBtn.addEventListener('click', () => {
    factorListSearch.value = '';
    renderFactorListItems();
    factorListModal.hidden = false;
    factorListSearch.focus();
  });
  factorListSearch.addEventListener('input', renderFactorListItems);
  factorListClose.addEventListener('click', () => { factorListModal.hidden = true; });
  factorListModal.addEventListener('click', (e) => {
    if (e.target === factorListModal) factorListModal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !factorListModal.hidden) factorListModal.hidden = true;
  });

  // ---- UMACAPTURE import (experimental; untested against a real export) -----------
  // UMACAPTURE recognizes a parent uma's factors from a screenshot but identifies them by
  // its own internal factor id, not the game's skill id. DATA_FACTORMAP (built from
  // UMACAPTURE's own public master-data bundle) translates factor id -> real skill id, so a
  // pasted `{id, star}` style export can resolve to actual skills. Text that isn't valid
  // JSON at all just falls back to the same name-matching as the "まとめて追加" box.

  const factorCaptureInput = document.getElementById('factor-capture-input');
  const factorCaptureLoadBtn = document.getElementById('factor-capture-load-btn');
  const factorCaptureResult = document.getElementById('factor-capture-result');
  const factorCaptureDropzone = document.getElementById('factor-capture-dropzone');
  const factorCaptureFileInput = document.getElementById('factor-capture-file');

  function findCaptureFactorIds(node, found) {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object' && !Array.isArray(item) && 'id' in item && 'star' in item) {
          found.push(item.id);
        } else {
          findCaptureFactorIds(item, found);
        }
      }
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) findCaptureFactorIds(v, found);
    }
    return found;
  }

  function loadFactorCaptureText(text) {
    text = text.trim();
    if (!text) return;

    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON, fall through to name matching */ }

    if (json) {
      const factorIds = findCaptureFactorIds(json, []);
      if (factorIds.length === 0) {
        factorCaptureResult.textContent = 'JSONとしては読み込めましたが、因子データ（id/starを持つ項目）が見つかりませんでした。';
        return;
      }
      const uniqueExcludedSet = new Set((typeof DATA_FACTORMAP_UNIQUE_EXCLUDED !== 'undefined' ? DATA_FACTORMAP_UNIQUE_EXCLUDED : []).map(String));
      const added = [];
      const uniqueSkipped = [];
      const unresolved = [];
      for (const fid of factorIds) {
        const gid = DATA_FACTORMAP[String(fid)];
        if (gid && DATA_SKILLS[gid]) { addParentFactor(gid); added.push(DATA_SKILLS[gid].ja); }
        else if (uniqueExcludedSet.has(String(fid))) uniqueSkipped.push(fid);
        else unresolved.push(fid);
      }
      renderFactorChips();
      let msg = `JSONとして読み込み: ${added.length}件追加しました。`;
      if (uniqueSkipped.length) msg += ` 固有スキルの因子のため除外: ${uniqueSkipped.join('、')}`;
      if (unresolved.length) msg += ` 対応するスキルが見つからなかった因子ID: ${unresolved.join('、')}`;
      factorCaptureResult.textContent = msg;
      if (unresolved.length === 0 && uniqueSkipped.length === 0) factorCaptureInput.value = '';
      return;
    }

    const { added, notFound } = addFactorsByNameTokens(text);
    renderFactorChips();
    let msg = `名前の一覧として読み込み: ${added.length}件追加しました。`;
    if (notFound.length) msg += ` 見つからなかったもの: ${notFound.join('、')}`;
    factorCaptureResult.textContent = msg;
  }

  factorCaptureLoadBtn.addEventListener('click', () => loadFactorCaptureText(factorCaptureInput.value));

  function loadFactorCaptureFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      factorCaptureInput.value = reader.result;
      loadFactorCaptureText(reader.result);
    };
    reader.onerror = () => { factorCaptureResult.textContent = 'ファイルの読み込みに失敗しました'; };
    reader.readAsText(file);
  }

  factorCaptureDropzone.addEventListener('click', () => factorCaptureFileInput.click());
  factorCaptureDropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); factorCaptureFileInput.click(); }
  });
  factorCaptureFileInput.addEventListener('change', () => {
    loadFactorCaptureFile(factorCaptureFileInput.files[0]);
    factorCaptureFileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(evt => {
    factorCaptureDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      factorCaptureDropzone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    factorCaptureDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      factorCaptureDropzone.classList.remove('drag-over');
    });
  });
  factorCaptureDropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    loadFactorCaptureFile(file);
  });

  renderFactorChips();

  // ---- condition evaluation ------------------------------------------------------
  // Course fields (surface/distance/track/turn) are always fixed once a course is chosen.
  // Running style / season / ground condition / weather are optional user choices: left
  // unspecified (null), they never disqualify a skill (treated as "could go either way").

  function styleMatches(userStyle, condStyle) {
    if (userStyle === condStyle) return true;
    return (userStyle === 1 && condStyle === 5) || (userStyle === 5 && condStyle === 1); // Nige <-> Oonige
  }

  function buildContext(course) {
    return {
      surface: course.surface,
      distanceType: course.distanceType,
      distance: course.distance,
      raceTrackId: course.raceTrackId,
      turn: course.turn,
      isDirtGrade: DIRT_GRADE_TRACKS.includes(course.raceTrackId) ? 1 : 0,
      runningStyle: runningStyleSelect.value ? parseInt(runningStyleSelect.value, 10) : null,
      season: seasonSelect.value ? parseInt(seasonSelect.value, 10) : null,
      groundCondition: groundConditionSelect.value ? parseInt(groundConditionSelect.value, 10) : null,
      weather: weatherSelect.value ? parseInt(weatherSelect.value, 10) : null
    };
  }

  function evalTerm(term, ctx) {
    const m = term.match(/^([a-z_]+)(==|!=|<=|>=|<|>)(\d+)$/);
    if (!m) return true; // unrecognized shape: don't block on it
    const [, varName, op, rawVal] = m;
    const val = parseInt(rawVal, 10);

    if (varName === 'running_style') {
      if (ctx.runningStyle == null) return true;
      const matches = styleMatches(ctx.runningStyle, val);
      return op === '!=' ? !matches : matches; // running_style conditions only ever use == or !=
    }

    let actual;
    switch (varName) {
      case 'ground_type': actual = ctx.surface; break;
      case 'distance_type': actual = ctx.distanceType; break;
      case 'course_distance': actual = ctx.distance; break;
      case 'track_id': actual = ctx.raceTrackId; break;
      case 'rotation': actual = ctx.turn; break;
      case 'is_dirtgrade': actual = ctx.isDirtGrade; break;
      case 'season': actual = ctx.season; break;
      case 'ground_condition': actual = ctx.groundCondition; break;
      case 'weather': actual = ctx.weather; break;
      default: return true; // not fixed by the course/user choices (order, hp, pace, luck...): assume possible
    }
    if (actual == null) return true; // user left this one unspecified
    switch (op) {
      case '==': return actual === val;
      case '!=': return actual !== val;
      case '<': return actual < val;
      case '<=': return actual <= val;
      case '>': return actual > val;
      case '>=': return actual >= val;
      default: return true;
    }
  }

  function conditionSatisfiable(condStr, ctx) {
    if (!condStr) return true;
    return condStr.split('@').some(group => group.split('&').every(term => evalTerm(term, ctx)));
  }

  function skillValidAtCourse(skill, ctx) {
    if (!skill.conditions || skill.conditions.length === 0) return null; // unknown
    return skill.conditions.some(cond => conditionSatisfiable(cond, ctx));
  }

  // ---- main compute + render -----------------------------------------------------

  const SKILL_RARITY_BADGE = { 1: ['白', 'white'], 2: ['金', 'gold'], 3: ['固有', 'unique'], 4: ['固有', 'unique'], 5: ['固有', 'unique'] };

  function renderSkillItem(container, skillId, sources) {
    const skill = DATA_SKILLS[skillId];
    const row = document.createElement('div');
    row.className = 'skill-item';

    const header = document.createElement('div');
    header.className = 'skill-item-header';
    const name = document.createElement('div');
    const [badgeLabel, badgeClass] = SKILL_RARITY_BADGE[skill && skill.rarity] || ['?', 'unknown'];
    name.innerHTML =
      `<span class="skill-rarity-badge skill-rarity-${badgeClass}">${badgeLabel}</span> ` +
      `<span class="skill-name">${skill ? skill.ja : skillId}</span> ` +
      (skill && skill.en ? `<span class="skill-name-en">(${skill.en})</span>` : '');
    const src = document.createElement('div');
    src.className = 'skill-source';
    src.textContent = '出典: ' + Array.from(sources).join(', ');
    header.appendChild(name);
    header.appendChild(src);
    row.appendChild(header);

    if (skill && skill.desc) {
      const desc = document.createElement('div');
      desc.className = 'skill-desc';
      desc.textContent = skill.desc;
      row.appendChild(desc);
    }
    container.appendChild(row);
  }

  function runDiff() {
    const course = currentCourse();
    if (!course) { alert('レース場（競馬場・コース）を選択してください'); return; }

    const mainCards = getDeckCards('main');
    const farmCards = getDeckCards('farm');
    if (mainCards.length === 0 || farmCards.length === 0) {
      alert('本育成用・因子周回用、両方の編成に最低1枚はサポカを設定してください');
      return;
    }

    const mainPool = skillPool(mainCards);
    const farmPool = skillPool(farmCards);
    for (const id of parentFactors) {
      if (!farmPool.has(id)) farmPool.set(id, new Set());
      farmPool.get(id).add('因子（手動指定）');
    }
    const ctx = buildContext(course);

    const valid = [];
    const excluded = [];
    const unresolved = [];

    for (const [skillId, sources] of farmPool) {
      if (mainPool.has(skillId)) continue; // obtainable from main deck too -> not interesting
      const skill = DATA_SKILLS[skillId];
      const verdict = skill ? skillValidAtCourse(skill, ctx) : null;
      if (verdict === true) valid.push([skillId, sources]);
      else if (verdict === false) excluded.push([skillId, sources]);
      else unresolved.push([skillId, sources]);
    }

    const byName = (a, b) => {
      const sa = DATA_SKILLS[a[0]], sb = DATA_SKILLS[b[0]];
      return (sa ? sa.ja : a[0]).localeCompare(sb ? sb.ja : b[0], 'ja');
    };
    valid.sort(byName);
    excluded.sort(byName);
    unresolved.sort(byName);

    resultList.innerHTML = '';
    if (valid.length === 0) {
      resultList.innerHTML = '<p class="empty-msg">因子周回編成だけが持つ、このレース場で有効なスキルはありませんでした。</p>';
    } else {
      for (const [skillId, sources] of valid) renderSkillItem(resultList, skillId, sources);
    }

    excludedList.innerHTML = '';
    if (excluded.length === 0) {
      excludedList.innerHTML = '<p class="empty-msg">該当なし</p>';
    } else {
      for (const [skillId, sources] of excluded) renderSkillItem(excludedList, skillId, sources);
    }

    unresolvedList.innerHTML = '';
    if (unresolved.length === 0) {
      unresolvedList.innerHTML = '<p class="empty-msg">該当なし</p>';
    } else {
      for (const [skillId, sources] of unresolved) renderSkillItem(unresolvedList, skillId, sources);
    }

    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  runBtn.addEventListener('click', runDiff);

  // ---- persistence (localStorage) -------------------------------------------------

  function buildStateSnapshot() {
    return {
      trackId: trackSelect.value,
      courseId: courseSelect.value,
      runningStyle: runningStyleSelect.value,
      season: seasonSelect.value,
      groundCondition: groundConditionSelect.value,
      weather: weatherSelect.value,
      main: deckState.main.slice(),
      farm: deckState.farm.slice(),
      parentFactors: parentFactors.slice(),
      eventChoiceState: JSON.parse(JSON.stringify(eventChoiceState))
    };
  }

  function applyState(state) {
    if (state.trackId && coursesByTrack.has(Number(state.trackId))) {
      trackSelect.value = state.trackId;
      populateCourseSelect(state.trackId);
      if (state.courseId) courseSelect.value = state.courseId;
      updateCourseSummary();
    }
    runningStyleSelect.value = state.runningStyle || '';
    seasonSelect.value = state.season || '';
    groundConditionSelect.value = state.groundCondition || '';
    weatherSelect.value = state.weather || '';
    ['main', 'farm'].forEach(deck => {
      deckState[deck] = ['', '', '', '', '', ''];
      const ids = state[deck] || [];
      for (let i = 0; i < 6; i++) {
        if (ids[i] && supportById.has(ids[i])) deckState[deck][i] = ids[i];
      }
    });
    parentFactors = Array.isArray(state.parentFactors) ? state.parentFactors.filter(id => DATA_SKILLS[id]) : [];
    renderFactorChips();
    for (const key of Object.keys(eventChoiceState)) delete eventChoiceState[key];
    if (state.eventChoiceState && typeof state.eventChoiceState === 'object') {
      Object.assign(eventChoiceState, state.eventChoiceState);
    }
    renderDeckSlots('main');
    renderDeckSlots('farm');
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildStateSnapshot()));
      saveMsg.textContent = '保存しました';
      setTimeout(() => { saveMsg.textContent = ''; }, 2000);
    } catch (e) {
      saveMsg.textContent = '保存に失敗しました（ブラウザの設定でlocalStorageが無効かもしれません）';
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      applyState(JSON.parse(raw));
    } catch (e) { /* ignore corrupt/missing autosave */ }
  }

  saveBtn.addEventListener('click', saveState);

  // ---- named presets (whole setup: course + both decks + factors + event choices) --

  const PRESETS_KEY = 'uma-inshi-shuukai-presets-v1';
  const presetSelect = document.getElementById('preset-select');
  const presetLoadBtn = document.getElementById('preset-load-btn');
  const presetDeleteBtn = document.getElementById('preset-delete-btn');
  const presetNameInput = document.getElementById('preset-name-input');
  const presetSaveBtn = document.getElementById('preset-save-btn');
  const presetMsg = document.getElementById('preset-msg');

  function loadPresets() {
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function savePresets(presets) {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  }

  function renderPresetOptions(selectedName) {
    const presets = loadPresets();
    const names = Object.keys(presets).sort((a, b) => a.localeCompare(b, 'ja'));
    presetSelect.innerHTML = '<option value="">(選択してください)</option>';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      presetSelect.appendChild(opt);
    }
    if (selectedName && names.includes(selectedName)) presetSelect.value = selectedName;
  }

  presetSaveBtn.addEventListener('click', () => {
    const name = presetNameInput.value.trim();
    if (!name) {
      presetMsg.textContent = '保存する名前を入力してください';
      return;
    }
    try {
      const presets = loadPresets();
      const isOverwrite = name in presets;
      presets[name] = buildStateSnapshot();
      savePresets(presets);
      renderPresetOptions(name);
      presetNameInput.value = '';
      presetMsg.textContent = `「${name}」を${isOverwrite ? '上書き保存' : '保存'}しました`;
    } catch (e) {
      presetMsg.textContent = '保存に失敗しました（ブラウザの設定でlocalStorageが無効かもしれません）';
    }
  });

  presetLoadBtn.addEventListener('click', () => {
    const name = presetSelect.value;
    if (!name) return;
    const presets = loadPresets();
    if (!presets[name]) {
      presetMsg.textContent = 'そのプリセットは見つかりませんでした';
      return;
    }
    applyState(presets[name]);
    presetMsg.textContent = `「${name}」を読み込みました`;
  });

  presetDeleteBtn.addEventListener('click', () => {
    const name = presetSelect.value;
    if (!name) return;
    const presets = loadPresets();
    delete presets[name];
    savePresets(presets);
    renderPresetOptions();
    presetMsg.textContent = `「${name}」を削除しました`;
  });

  renderPresetOptions();

  // ---- init -----------------------------------------------------------------------

  populateCourseSelect(trackSelect.value);
  buildDeckSlots(document.querySelector('#deck-main .slots'), 'main');
  buildDeckSlots(document.querySelector('#deck-farm .slots'), 'farm');
  loadState();
})();
