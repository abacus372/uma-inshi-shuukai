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
  let pickerRarity = 'ALL';
  let pickerType = 'ALL';

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
    const usedElsewhere = new Set(
      deckState[pickerTarget.deck].filter((id, idx) => idx !== pickerTarget.slot && id)
    );
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
      const disabled = usedElsewhere.has(s.id);
      const item = document.createElement('div');
      item.className = 'picker-item' + (disabled ? ' disabled' : '');
      item.title = disabled ? 'この編成の別の枠で使用中です' : '';
      item.innerHTML =
        `<img src="${thumbPath(s)}" alt="" loading="lazy">` +
        `<div class="picker-name">${s.ja}</div>` +
        `<div class="picker-type">${TYPE_LABEL[s.type] || s.type}</div>`;
      if (!disabled) {
        item.addEventListener('click', () => {
          deckState[pickerTarget.deck][pickerTarget.slot] = s.id;
          renderDeckSlots(pickerTarget.deck);
          closePicker();
        });
      }
      pickerGrid.appendChild(item);
    }
  }

  function openPicker(deckName, slotIdx) {
    pickerTarget = { deck: deckName, slot: slotIdx };
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

  function searchSkills(query) {
    const q = query.trim();
    if (!q) return [];
    const qLower = q.toLowerCase();
    const matches = Object.entries(DATA_SKILLS).filter(([, sk]) =>
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

  function addFactorsByNameTokens(text) {
    const tokens = text.split(/[\n,、]/).map(t => t.trim()).filter(Boolean);
    const added = [];
    const notFound = [];
    for (const token of tokens) {
      let hit = Object.entries(DATA_SKILLS).find(([, sk]) => sk.ja === token || sk.en === token);
      if (!hit) hit = Object.entries(DATA_SKILLS).find(([, sk]) => sk.ja && sk.ja.startsWith(token));
      if (hit) { addParentFactor(hit[0]); added.push(hit[1].ja); }
      else notFound.push(token);
    }
    return { added, notFound };
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

  // ---- UMACAPTURE import (experimental; untested against a real export) -----------
  // UMACAPTURE recognizes a parent uma's factors from a screenshot but identifies them by
  // its own internal factor id, not the game's skill id. DATA_FACTORMAP (built from
  // UMACAPTURE's own public master-data bundle) translates factor id -> real skill id, so a
  // pasted `{id, star}` style export can resolve to actual skills. Text that isn't valid
  // JSON at all just falls back to the same name-matching as the "まとめて追加" box.

  const factorCaptureInput = document.getElementById('factor-capture-input');
  const factorCaptureLoadBtn = document.getElementById('factor-capture-load-btn');
  const factorCaptureResult = document.getElementById('factor-capture-result');

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

  factorCaptureLoadBtn.addEventListener('click', () => {
    const text = factorCaptureInput.value.trim();
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

  function renderSkillItem(container, skillId, sources) {
    const skill = DATA_SKILLS[skillId];
    const row = document.createElement('div');
    row.className = 'skill-item';
    const name = document.createElement('div');
    name.innerHTML = `<span class="skill-name">${skill ? skill.ja : skillId}</span> ` +
      (skill && skill.en ? `<span class="skill-name-en">(${skill.en})</span>` : '');
    const src = document.createElement('div');
    src.className = 'skill-source';
    src.textContent = '出典: ' + Array.from(sources).join(', ');
    row.appendChild(name);
    row.appendChild(src);
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
