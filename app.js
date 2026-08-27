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
  }

  buildDeckSlots(document.querySelector('#deck-main .slots'), 'main');
  buildDeckSlots(document.querySelector('#deck-farm .slots'), 'farm');

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

  function hintMap(cards) {
    // skillId -> Set of contributing card ja names
    const map = new Map();
    for (const c of cards) {
      for (const skillId of c.hints) {
        if (!map.has(skillId)) map.set(skillId, new Set());
        map.get(skillId).add(c.ja);
      }
    }
    return map;
  }

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

    const mainHints = hintMap(mainCards);
    const farmHints = hintMap(farmCards);
    const ctx = buildContext(course);

    const valid = [];
    const excluded = [];
    const unresolved = [];

    for (const [skillId, sources] of farmHints) {
      if (mainHints.has(skillId)) continue; // obtainable from main deck too -> not interesting
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

  function saveState() {
    try {
      const state = {
        trackId: trackSelect.value,
        courseId: courseSelect.value,
        runningStyle: runningStyleSelect.value,
        season: seasonSelect.value,
        groundCondition: groundConditionSelect.value,
        weather: weatherSelect.value,
        main: deckState.main.slice(),
        farm: deckState.farm.slice()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveMsg.textContent = '保存しました';
      setTimeout(() => { saveMsg.textContent = ''; }, 2000);
    } catch (e) {
      saveMsg.textContent = '保存に失敗しました（ブラウザの設定でlocalStorageが無効かもしれません）';
    }
  }

  function loadState() {
    let state;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      state = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (state.trackId && coursesByTrack.has(Number(state.trackId))) {
      trackSelect.value = state.trackId;
      populateCourseSelect(state.trackId);
      if (state.courseId) courseSelect.value = state.courseId;
      updateCourseSummary();
    }
    if (state.runningStyle) runningStyleSelect.value = state.runningStyle;
    if (state.season) seasonSelect.value = state.season;
    if (state.groundCondition) groundConditionSelect.value = state.groundCondition;
    if (state.weather) weatherSelect.value = state.weather;
    ['main', 'farm'].forEach(deck => {
      const ids = state[deck] || [];
      for (let i = 0; i < 6; i++) {
        if (ids[i] && supportById.has(ids[i])) deckState[deck][i] = ids[i];
      }
      renderDeckSlots(deck);
    });
  }

  saveBtn.addEventListener('click', saveState);

  // ---- init -----------------------------------------------------------------------

  populateCourseSelect(trackSelect.value);
  loadState();
})();
