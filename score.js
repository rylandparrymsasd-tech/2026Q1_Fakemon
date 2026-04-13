// score.js
// ─────────────────────────────────────────────────────────────────────────────
// Fakemon Power Scorer
//
// Simulates N battles between the Fakemon and a fixed benchmark opponent.
// Win rate (0–100) is the power score. All 5 stats, type matchups, flinch,
// accuracy, and defense are implemented here to match the game engine exactly.
//
// MULTI-STATUS SUPPORT: moves may now have either:
//   - "status": "poison"  (single, old format — still works)
//   - "statuses": [ { "status":"poison", "statusChance":0.5 },
//                   { "status":"statdwn","statusChance":1.0,"statTarget":"speed" } ]
//
// FakemonScorer.calcPowerLevel(fakemon) → integer 0–100
// ─────────────────────────────────────────────────────────────────────────────

const FakemonScorer = (() => {

  const SIMULATIONS = 200;
  const MAX_TURNS   = 60;

  // ── Move speed: order and damage multiplier ───────────────────────────────
  const SPEED_MULT  = { fast: 1.15, medium: 1.0, slow: 0.88 };
  const SPEED_ORDER = { fast: 1, medium: 2, slow: 3 };

  // ── Type matchup table ────────────────────────────────────────────────────
  const TYPE_CHART = buildTypeChart();

  function buildTypeChart() {
    const strong = {
      Fire:     ['Air', 'Ice', 'Nature', 'Metal'],
      Water:    ['Fire', 'Earth'],
      Air:      ['Nature'],
      Earth:    ['Electric', 'Poison'],
      Electric: ['Water', 'Air'],
      Ice:      ['Nature'],
      Poison:   ['Nature'],
      Dark:     ['Ghost'],
      Ghost:    ['Ghost', 'Dark', 'Poison'],
      Metal:    ['Ice', 'Electric'],
      Nature:   ['Water', 'Earth'],
      Normal:   [],
    };
    const weak = {
      Fire:     ['Water', 'Ice'],
      Water:    ['Nature'],
      Air:      ['Electric'],
      Earth:    ['Water', 'Nature'],
      Electric: ['Earth', 'Metal'],
      Ice:      ['Fire', 'Metal'],
      Poison:   ['Ghost'],
      Dark:     [],
      Ghost:    ['Normal'],
      Metal:    ['Fire'],
      Nature:   ['Fire', 'Air', 'Ice', 'Poison'],
      Normal:   [],
    };

    const chart = {};
    const types = Object.keys(strong);
    for (const atk of types) {
      chart[atk] = {};
      for (const def of types) {
        if (strong[atk].includes(def)) chart[atk][def] = 2;
        else if (weak[atk].includes(def)) chart[atk][def] = 0.5;
        else chart[atk][def] = 1;
      }
    }
    return chart;
  }

  function typeMultiplier(attackerType, defenderType) {
    if (!attackerType || !defenderType) return 1;
    const row = TYPE_CHART[attackerType];
    if (!row) return 1;
    return row[defenderType] ?? 1;
  }

  // ── Primary statuses ──────────────────────────────────────────────────────
  const PRIMARY = ['poison', 'burn', 'paralyze', 'sleep'];

  // ── Normalise move statuses to a flat array ───────────────────────────────
  // Handles old single-status format AND new multi-status "statuses" array.
  function getMoveStatuses(move) {
    // New format: move.statuses = [ { status, statusChance, statTarget }, ... ]
    if (Array.isArray(move.statuses) && move.statuses.length > 0) {
      return move.statuses;
    }
    // Old format: move.status / move.statusChance / move.statTarget
    if (move.status) {
      return [{ status: move.status, statusChance: move.statusChance ?? 1.0, statTarget: move.statTarget ?? null }];
    }
    return [];
  }

  // ── Benchmark ─────────────────────────────────────────────────────────────
  const BENCHMARK = {
    id: '__benchmark__',
    name: 'Benchmark',
    type: 'Normal',
    hp: 100, atk: 100, speed: 90, defense: 10, accuracy: 90,
    moves: [
      { id:'b_atk',    speed:'medium', damage:[15,20], status:null,      statusChance:0,   statTarget:null },
      { id:'b_poison', speed:'medium', damage:[0,0],   status:'poison',  statusChance:0.6, statTarget:null },
      { id:'b_sleep',  speed:'slow',   damage:[0,0],   status:'sleep',   statusChance:0.7, statTarget:null },
      { id:'b_heal',   speed:'slow',   damage:[-20,-20],status:null,     statusChance:0,   statTarget:null },
    ],
  };

  // ── Fighter state ─────────────────────────────────────────────────────────
  function mkState(f) {
    // Support both "power" (old) and "atk" (new) field names
    const atkStat = f.atk ?? f.power ?? 100;
    return {
      hp:          f.hp       ?? 100,
      maxHp:       f.hp       ?? 100,
      atk:         atkStat,
      speed:       f.speed    ?? 90,
      defense:     f.defense  ?? 10,
      accuracy:    f.accuracy ?? 90,
      type:        f.type     || 'Normal',
      moves:       f.moves,
      atkMod:      0,
      speedMod:    0,
      defenseMod:  0,
      accuracyMod: 0,
      statuses:     [],
      sleepTurns:   0,
      confuseTurns: 0,
      // Per-stat statup/down tracking (one entry per stat type)
      statupTurns:  { atk: 0, speed: 0, defense: 0, accuracy: 0 },
      statdwnTurns: { atk: 0, speed: 0, defense: 0, accuracy: 0 },
      flinched:     false,
    };
  }

  // ── Status application ────────────────────────────────────────────────────
  function applyStatus(f, status, statTarget) {
    if (status === 'flinch') { f.flinched = true; return; }
    if (f.statuses.includes(status)) return;
    if (PRIMARY.includes(status) && PRIMARY.some(s => f.statuses.includes(s))) return;
    f.statuses.push(status);
    if (status === 'sleep')    { f.sleepTurns   = rng(2, 3); }
    if (status === 'confuse')  { f.confuseTurns = rng(2, 4); }
    if (status === 'paralyze') { f.speedMod    -= 30; }
    if (status === 'burn')     { f.atkMod      -= 20; }
    if (status === 'statup') {
      const t = statTarget || 'atk';
      if (t === 'atk' || t === 'power') { f.atkMod      += 20; f.statupTurns.atk      = 3; }
      if (t === 'speed')                { f.speedMod    += 20; f.statupTurns.speed    = 3; }
      if (t === 'defense')              { f.defenseMod  += 15; f.statupTurns.defense  = 3; }
      if (t === 'accuracy')             { f.accuracyMod += 15; f.statupTurns.accuracy = 3; }
      // Keep the 'statup' status label active if any stat is still boosted
    }
    if (status === 'statdwn') {
      const t = statTarget || 'atk';
      if (t === 'atk' || t === 'power') { f.atkMod      -= 20; f.statdwnTurns.atk      = 3; }
      if (t === 'speed')                { f.speedMod    -= 20; f.statdwnTurns.speed    = 3; }
      if (t === 'defense')              { f.defenseMod  -= 15; f.statdwnTurns.defense  = 3; }
      if (t === 'accuracy')             { f.accuracyMod -= 15; f.statdwnTurns.accuracy = 3; }
    }
  }

  function removeStatus(f, status) {
    f.statuses = f.statuses.filter(s => s !== status);
  }

  // ── Effective stats ────────────────────────────────────────────────────────
  const effAtk      = f => Math.max(10,  f.atk      + f.atkMod);
  const effSpeed    = f => Math.max(1,   f.speed    + f.speedMod);
  const effDefense  = f => Math.max(0,   Math.min(80, f.defense + f.defenseMod));
  const effAccuracy = f => Math.max(10,  Math.min(100, f.accuracy + f.accuracyMod));

  // ── Pre-action checks ─────────────────────────────────────────────────────
  function preActionChecks(f) {
    if (f.flinched) { f.flinched = false; return { blocked: true, selfDmg: 0 }; }
    if (f.statuses.includes('sleep')) {
      f.sleepTurns--;
      if (f.sleepTurns <= 0) removeStatus(f, 'sleep');
      else return { blocked: true, selfDmg: 0 };
    }
    if (f.statuses.includes('paralyze') && Math.random() < 0.35)
      return { blocked: true, selfDmg: 0 };
    if (f.statuses.includes('confuse') && Math.random() < 0.33)
      return { blocked: true, selfDmg: rng(8, 15) };
    return { blocked: false, selfDmg: 0 };
  }

  // ── Damage calculation ────────────────────────────────────────────────────
  function calcDamage(attacker, defender, base, moveSpeed) {
    const atkMult     = effAtk(attacker) / 100;
    const spdMult     = SPEED_MULT[moveSpeed] || 1.0;
    const typeMult    = typeMultiplier(attacker.type, defender.type);
    const defReduct   = 1 - effDefense(defender) / 100;
    return Math.max(1, Math.round(base * atkMult * spdMult * typeMult * defReduct));
  }

  // ── Execute one move ──────────────────────────────────────────────────────
  function executeMove(attacker, defender, move) {
    if (Math.random() * 100 > effAccuracy(attacker)) return;

    const isHeal = move.damage && move.damage[1] < 0;
    if (isHeal) {
      const amt = Math.abs(move.damage[0]);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + amt);
      return;
    }

    if (move.damage && move.damage[1] > 0) {
      const base = rng(move.damage[0], move.damage[1]);
      const dmg  = calcDamage(attacker, defender, base, move.speed);
      defender.hp = Math.max(0, defender.hp - dmg);
      // Apply all statuses from this move
      for (const se of getMoveStatuses(move)) {
        if (se.statusChance && Math.random() < se.statusChance) {
          const tgt = (se.status === 'statup') ? attacker : defender;
          applyStatus(tgt, se.status, se.statTarget || null);
        }
      }
      return;
    }

    // Pure status move — apply all statuses
    for (const se of getMoveStatuses(move)) {
      const tgt    = (se.status === 'statup') ? attacker : defender;
      const chance = se.statusChance ?? 1.0;
      if (Math.random() < chance) applyStatus(tgt, se.status, se.statTarget || null);
    }
  }

  // ── End-of-turn ticks ─────────────────────────────────────────────────────
  function endOfTurnTick(f) {
    if (f.statuses.includes('burn'))   f.hp = Math.max(0, f.hp - Math.round(f.maxHp * 0.06));
    if (f.statuses.includes('poison')) f.hp = Math.max(0, f.hp - Math.round(f.maxHp * 0.08));
    if (f.statuses.includes('confuse')) {
      f.confuseTurns--;
      if (f.confuseTurns <= 0) removeStatus(f, 'confuse');
    }

    // Per-stat statup decay
    let anyStatup = false;
    for (const stat of ['atk','speed','defense','accuracy']) {
      if (f.statupTurns[stat] > 0) {
        f.statupTurns[stat]--;
        anyStatup = true;
        if (f.statupTurns[stat] === 0) {
          if (stat === 'atk')      f.atkMod      = Math.max(0, f.atkMod      - 20);
          if (stat === 'speed')    f.speedMod    = Math.max(0, f.speedMod    - 20);
          if (stat === 'defense')  f.defenseMod  = Math.max(0, f.defenseMod  - 15);
          if (stat === 'accuracy') f.accuracyMod = Math.max(0, f.accuracyMod - 15);
        }
      }
    }
    if (!anyStatup) removeStatus(f, 'statup');

    // Per-stat statdwn decay
    let anyStatdwn = false;
    for (const stat of ['atk','speed','defense','accuracy']) {
      if (f.statdwnTurns[stat] > 0) {
        f.statdwnTurns[stat]--;
        anyStatdwn = true;
        if (f.statdwnTurns[stat] === 0) {
          if (stat === 'atk')      f.atkMod      = Math.min(0, f.atkMod      + 20);
          if (stat === 'speed')    f.speedMod    = Math.min(0, f.speedMod    + 20);
          if (stat === 'defense')  f.defenseMod  = Math.min(0, f.defenseMod  + 15);
          if (stat === 'accuracy') f.accuracyMod = Math.min(0, f.accuracyMod + 15);
        }
      }
    }
    if (!anyStatdwn) removeStatus(f, 'statdwn');
  }

  // ── AI move scorer ────────────────────────────────────────────────────────
  const STATUS_VALUE = { sleep:16, paralyze:14, burn:12, poison:10, statdwn:10, statup:10, confuse:8, flinch:6 };

  function scoreMoveForAI(move, self, opponent) {
    const isHeal = move.damage && move.damage[1] < 0;
    const hpFrac = self.hp / self.maxHp;

    if (isHeal) {
      if (hpFrac > 0.7) return -5;
      return Math.abs(move.damage[0]) * (1 - hpFrac) * 3;
    }

    let score = 0;
    if (move.damage && move.damage[1] > 0) {
      const mid  = (move.damage[0] + move.damage[1]) / 2;
      score += calcDamage(self, opponent, mid, move.speed);
    }
    for (const se of getMoveStatuses(move)) {
      if ((se.statusChance ?? 0) > 0) {
        const tgtSelf = se.status === 'statup';
        const tgt = tgtSelf ? self : opponent;
        if (!tgt.statuses.includes(se.status)) {
          score += (STATUS_VALUE[se.status] || 5) * se.statusChance;
        }
      }
    }
    return score;
  }

  function pickBestMove(self, opponent) {
    let best = self.moves[0], bestScore = -Infinity;
    for (const m of self.moves) {
      const s = scoreMoveForAI(m, self, opponent);
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  // ── One battle ────────────────────────────────────────────────────────────
  function runOneBattle(subject, benchDef) {
    const a = mkState(subject);
    const b = mkState(benchDef);

    for (let t = 0; t < MAX_TURNS; t++) {
      const mA = pickBestMove(a, b);
      const mB = pickBestMove(b, a);

      const tierA = SPEED_ORDER[mA.speed] || 2;
      const tierB = SPEED_ORDER[mB.speed] || 2;
      const aFirst = tierA < tierB || (tierA === tierB && effSpeed(a) >= effSpeed(b));

      const first  = aFirst ? [a, b, mA, true]  : [b, a, mB, false];
      const second = aFirst ? [b, a, mB, false] : [a, b, mA, true];

      for (const [attacker, defender, move, isSubject] of [first, second]) {
        const { blocked, selfDmg } = preActionChecks(attacker);
        attacker.hp = Math.max(0, attacker.hp - selfDmg);
        if (!blocked) {
          const hpBefore = defender.hp;
          executeMove(attacker, defender, move);
          const didDamage = defender.hp < hpBefore;
          // Flinch from damage moves still uses old single-status check for benchmark compat
          if (didDamage && move.status === 'flinch' && move.statusChance && Math.random() < move.statusChance) {
            defender.flinched = true;
          }
        }
        if (a.hp <= 0) return false;
        if (b.hp <= 0) return true;
      }

      endOfTurnTick(a);
      endOfTurnTick(b);
      if (a.hp <= 0) return false;
      if (b.hp <= 0) return true;
    }
    return false;
  }

  // ── Validation ────────────────────────────────────────────────────────────
  function validateFakemon(f) {
    const errors = [];
    const warnings = [];

    if (!f.id || typeof f.id !== 'string') errors.push('Missing or invalid "id" field (must be a string)');
    else if (/[\s\/\\'"{}]/.test(f.id)) errors.push(`id "${f.id}" contains invalid characters (no spaces, slashes, or quotes)`);

    if (!f.name || typeof f.name !== 'string') errors.push('Missing or invalid "name" field');
    if (!f.emoji || typeof f.emoji !== 'string') warnings.push('Missing "emoji" field — will show a placeholder');
    if (!f.type) errors.push('Missing "type" field');
    else {
      const VALID_TYPES = ['Fire','Water','Air','Earth','Electric','Ice','Poison','Dark','Ghost','Metal','Nature','Normal'];
      if (!VALID_TYPES.includes(f.type)) errors.push(`Unknown type "${f.type}" — valid types: ${VALID_TYPES.join(', ')}`);
    }

    const STAT_FIELDS = ['hp','speed','defense','accuracy'];
    for (const s of STAT_FIELDS) {
      if (f[s] === undefined) warnings.push(`Missing stat "${s}" — will use default`);
      else if (typeof f[s] !== 'number') errors.push(`Stat "${s}" must be a number, got ${typeof f[s]}`);
    }
    // ATK: accept either "atk" or "power"
    if (f.atk === undefined && f.power === undefined) warnings.push('Missing stat "atk" — will use default');
    else if (f.atk !== undefined && typeof f.atk !== 'number') errors.push(`Stat "atk" must be a number`);
    else if (f.power !== undefined && typeof f.power !== 'number') errors.push(`Stat "power" must be a number`);

    if (!Array.isArray(f.moves)) {
      errors.push('Missing or invalid "moves" array');
    } else {
      if (f.moves.length < 4) warnings.push(`Only ${f.moves.length} moves — guide recommends 4–8`);
      if (f.moves.length > 8) warnings.push(`${f.moves.length} moves — guide recommends max 8`);
      const hasDmg = f.moves.some(m => m.damage && m.damage[1] > 0);
      if (!hasDmg) warnings.push('No damage moves found — Fakemon may never finish a fight');

      const ids = new Set();
      const VALID_STATUSES = ['poison','burn','paralyze','sleep','confuse','flinch','statup','statdwn',null,undefined];
      const VALID_STAT_TARGETS = ['atk','power','speed','defense','accuracy',null,undefined];

      f.moves.forEach((m, i) => {
        const mLabel = `Move ${i+1} (${m.name || m.id || 'unnamed'})`;
        if (!m.id) errors.push(`${mLabel}: missing "id" field`);
        else if (ids.has(m.id)) errors.push(`Duplicate move id "${m.id}"`);
        else ids.add(m.id);

        if (!m.name) warnings.push(`${mLabel}: missing "name" field`);
        if (!['fast','medium','slow'].includes(m.speed)) errors.push(`${mLabel}: "speed" must be "fast", "medium", or "slow" — got "${m.speed}"`);
        if (!Array.isArray(m.damage) || m.damage.length !== 2) errors.push(`${mLabel}: "damage" must be an array of two numbers, e.g. [10, 20]`);
        else {
          if (typeof m.damage[0] !== 'number' || typeof m.damage[1] !== 'number') errors.push(`${mLabel}: both damage values must be numbers`);
          if (m.damage[0] > m.damage[1] && m.damage[1] > 0) warnings.push(`${mLabel}: damage min (${m.damage[0]}) is greater than max (${m.damage[1]})`);
        }

        // Validate statuses — supports both old (status field) and new (statuses array)
        if (Array.isArray(m.statuses)) {
          m.statuses.forEach((se, si) => {
            const seLabel = `${mLabel} status[${si}]`;
            if (!VALID_STATUSES.includes(se.status)) errors.push(`${seLabel}: unknown status "${se.status}"`);
            if (se.statusChance !== undefined && (typeof se.statusChance !== 'number' || se.statusChance < 0 || se.statusChance > 1))
              errors.push(`${seLabel}: "statusChance" must be a number 0–1`);
            if ((se.status === 'statup' || se.status === 'statdwn') && se.statTarget && !VALID_STAT_TARGETS.includes(se.statTarget))
              errors.push(`${seLabel}: "statTarget" must be one of: atk, speed, defense, accuracy`);
          });
        } else {
          if (m.statusChance !== undefined && (typeof m.statusChance !== 'number' || m.statusChance < 0 || m.statusChance > 1))
            errors.push(`${mLabel}: "statusChance" must be a number between 0 and 1`);
          if (!VALID_STATUSES.includes(m.status)) errors.push(`${mLabel}: unknown status "${m.status}"`);
          if ((m.status === 'statup' || m.status === 'statdwn') && m.statTarget && !VALID_STAT_TARGETS.includes(m.statTarget))
            errors.push(`${mLabel}: "statTarget" must be one of: atk, speed, defense, accuracy`);
        }
      });
    }

    if (!f.description) warnings.push('Missing "description" field');
    if (!f.createdBy) warnings.push('Missing "createdBy" field');

    return { errors, warnings, valid: errors.length === 0 };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function calcPowerLevel(fakemon) {
    let wins = 0;
    for (let i = 0; i < SIMULATIONS; i++) {
      if (runOneBattle(fakemon, BENCHMARK)) wins++;
    }
    return Math.round((wins / SIMULATIONS) * 100);
  }

  function rng(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

  return { calcPowerLevel, typeMultiplier, validateFakemon, getMoveStatuses };

})();