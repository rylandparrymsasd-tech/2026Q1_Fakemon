// score.js
// ─────────────────────────────────────────────────────────────────────────────
// Fakemon Power Scorer  — v2
//
// Scores a Fakemon 0–1000 using three components:
//   Win Rate      (0–600)  — % of simulated battles won vs the benchmark
//   Efficiency    (0–200)  — how quickly it wins (fewer turns = higher score)
//   Survivability (0–200)  — how much HP remains when it wins
//
// One-shot builds are valid and score high if they actually win fast.
// The AI plays like a real player: prioritise the highest expected damage
// move first, then status moves the opponent doesn't already have, then
// weaker damage moves, then buffs, then heals only when low.
//
// statup/statdwn stacking is capped per move application (max 3 per stat)
// to prevent 50-entry status arrays from soft-locking the simulation.
//
// PUBLIC API
//   FakemonScorer.calcPowerLevel(fakemon)          → integer 0–1000
//   FakemonScorer.validateFakemon(fakemon)         → { errors, warnings, valid }
//   FakemonScorer.typeMultiplier(atkType, defType) → number
//   FakemonScorer.getMoveStatuses(move)            → array
//
// ON-SCREEN DEBUG PANEL  (no console needed — works on Chromebooks)
//   FakemonScorer.attachDebugPanel(containerElement | id string)
//     • Injects a collapsible debug panel.
//     • Call BEFORE calcPowerLevel to capture scoring logs.
//     • The panel has filter tabs: ALL / INFO / WARN / ERROR / SIM
//     • Click the ✕ button or call detachDebugPanel() to hide it.
//   FakemonScorer.detachDebugPanel()
//   FakemonScorer.dbg(msg, level)   level = 'info'|'warn'|'error'|'sim'
//     • Emit a message to the panel from outside (e.g. the game engine).
// ─────────────────────────────────────────────────────────────────────────────

const FakemonScorer = (() => {

  // ── Config ────────────────────────────────────────────────────────────────
  const SIMULATIONS = 500;
  const MAX_TURNS   = 60;

  // Per-stat stack cap per move application — stops 50× statdwn arrays
  // from locking stats at floor/ceiling every turn.
  const STAT_STACK_CAP = 3;

  // Score weights
  const W_WIN  = 600;
  const W_EFF  = 200;
  const W_SURV = 200;

  // ── Move speed tables ─────────────────────────────────────────────────────
  const SPEED_MULT  = { fast: 1.15, medium: 1.0, slow: 0.88 };
  const SPEED_ORDER = { fast: 1, medium: 2, slow: 3 };

  // ── Type matchup table ────────────────────────────────────────────────────
  const TYPE_CHART = (() => {
    const strong = {
      Fire:     ['Air','Ice','Nature','Metal'],
      Water:    ['Fire','Earth'],
      Air:      ['Nature'],
      Earth:    ['Electric','Poison'],
      Electric: ['Water','Air'],
      Ice:      ['Nature'],
      Poison:   ['Nature'],
      Dark:     ['Ghost'],
      Ghost:    ['Ghost','Dark','Poison'],
      Metal:    ['Ice','Electric'],
      Nature:   ['Water','Earth'],
      Normal:   [],
    };
    const weak = {
      Fire:     ['Water','Ice'],
      Water:    ['Nature'],
      Air:      ['Electric'],
      Earth:    ['Water','Nature'],
      Electric: ['Earth','Metal'],
      Ice:      ['Fire','Metal'],
      Poison:   ['Ghost'],
      Dark:     [],
      Ghost:    ['Normal'],
      Metal:    ['Fire'],
      Nature:   ['Fire','Air','Ice','Poison'],
      Normal:   [],
    };
    const chart = {};
    for (const atk of Object.keys(strong)) {
      chart[atk] = {};
      for (const def of Object.keys(strong)) {
        if      (strong[atk].includes(def)) chart[atk][def] = 2;
        else if (weak[atk].includes(def))   chart[atk][def] = 0.5;
        else                                chart[atk][def] = 1;
      }
    }
    return chart;
  })();

  function typeMultiplier(attackerType, defenderType) {
    if (!attackerType || !defenderType) return 1;
    return (TYPE_CHART[attackerType] || {})[defenderType] ?? 1;
  }

  // ── Status helpers ────────────────────────────────────────────────────────
  const PRIMARY = ['poison','burn','paralyze','sleep'];

  // Normalise both old (move.status) and new (move.statuses[]) formats
  function getMoveStatuses(move) {
    if (Array.isArray(move.statuses) && move.statuses.length > 0) return move.statuses;
    if (move.status) {
      return [{ status: move.status, statusChance: move.statusChance ?? 1.0, statTarget: move.statTarget ?? null }];
    }
    return [];
  }

  // ── Benchmark opponent ────────────────────────────────────────────────────
  // A competent generalist: solid damage, debuffs, sleep, some healing.
  const BENCHMARK = {
    id: '__benchmark__',
    name: 'Benchmark',
    type: 'Normal',
    hp: 100, atk: 100, speed: 90, defense: 10, accuracy: 90,
    moves: [
      { id:'b_atk',    speed:'medium', damage:[15,20], status:null,     statusChance:0   },
      { id:'b_poison', speed:'medium', damage:[0,0],   status:'poison', statusChance:0.6 },
      { id:'b_sleep',  speed:'slow',   damage:[0,0],   status:'sleep',  statusChance:0.7 },
      { id:'b_heal',   speed:'slow',   damage:[-20,-20],status:null,    statusChance:0   },
    ],
  };

  // ── Fighter state factory ─────────────────────────────────────────────────
  function mkState(f) {
    return {
      hp:           f.hp       ?? 100,
      maxHp:        f.hp       ?? 100,
      atk:          f.atk ?? f.power ?? 100,
      speed:        f.speed    ?? 90,
      defense:      f.defense  ?? 10,
      accuracy:     f.accuracy ?? 90,
      type:         f.type     || 'Normal',
      moves:        f.moves,
      atkMod:       0, speedMod: 0, defenseMod: 0, accuracyMod: 0,
      statuses:     [],
      sleepTurns:   0,
      confuseTurns: 0,
      statupTurns:  { atk:0, speed:0, defense:0, accuracy:0 },
      statdwnTurns: { atk:0, speed:0, defense:0, accuracy:0 },
      flinched:     false,
    };
  }

  // ── Effective stats ───────────────────────────────────────────────────────
  const effAtk      = f => Math.max(10,  f.atk      + f.atkMod);
  const effSpeed    = f => Math.max(1,   f.speed    + f.speedMod);
  const effDefense  = f => Math.max(0,   Math.min(80, f.defense  + f.defenseMod));
  const effAccuracy = f => Math.max(10,  Math.min(100, f.accuracy + f.accuracyMod));

  // ── Status application ────────────────────────────────────────────────────
  function applyStatus(f, status, statTarget) {
    if (status === 'flinch') { f.flinched = true; return; }
    if (f.statuses.includes(status)) return;
    if (PRIMARY.includes(status) && PRIMARY.some(s => f.statuses.includes(s))) return;
    f.statuses.push(status);
    if (status === 'sleep')    { f.sleepTurns   = rng(2,3); }
    if (status === 'confuse')  { f.confuseTurns = rng(2,4); }
    if (status === 'paralyze') { f.speedMod    -= 30; }
    if (status === 'burn')     { f.atkMod      -= 20; }
    if (status === 'statup') {
      const t = statTarget || 'atk';
      if (t==='atk'||t==='power') { f.atkMod      += 20; f.statupTurns.atk      = 3; }
      if (t==='speed')            { f.speedMod    += 20; f.statupTurns.speed    = 3; }
      if (t==='defense')          { f.defenseMod  += 15; f.statupTurns.defense  = 3; }
      if (t==='accuracy')         { f.accuracyMod += 15; f.statupTurns.accuracy = 3; }
    }
    if (status === 'statdwn') {
      const t = statTarget || 'atk';
      if (t==='atk'||t==='power') { f.atkMod      -= 20; f.statdwnTurns.atk      = 3; }
      if (t==='speed')            { f.speedMod    -= 20; f.statdwnTurns.speed    = 3; }
      if (t==='defense')          { f.defenseMod  -= 15; f.statdwnTurns.defense  = 3; }
      if (t==='accuracy')         { f.accuracyMod -= 15; f.statdwnTurns.accuracy = 3; }
    }
  }

  function removeStatus(f, status) {
    f.statuses = f.statuses.filter(s => s !== status);
  }

  // ── Pre-action checks ─────────────────────────────────────────────────────
  function preActionChecks(f) {
    if (f.flinched) { f.flinched = false; return { blocked:true, selfDmg:0 }; }
    if (f.statuses.includes('sleep')) {
      f.sleepTurns--;
      if (f.sleepTurns <= 0) removeStatus(f,'sleep');
      else return { blocked:true, selfDmg:0 };
    }
    if (f.statuses.includes('paralyze') && Math.random() < 0.35)
      return { blocked:true, selfDmg:0 };
    if (f.statuses.includes('confuse') && Math.random() < 0.33)
      return { blocked:true, selfDmg: rng(8,15) };
    return { blocked:false, selfDmg:0 };
  }

  // ── Damage calculation ────────────────────────────────────────────────────
  // No artificial cap — one-shot builds that genuinely KO the opponent
  // in one turn will win quickly and score high on efficiency.
  function calcDamage(attacker, defender, base, moveSpeed) {
    const atkMult   = effAtk(attacker) / 100;
    const spdMult   = SPEED_MULT[moveSpeed] || 1.0;
    const typeMult  = typeMultiplier(attacker.type, defender.type);
    const defReduct = 1 - effDefense(defender) / 100;
    return Math.max(1, Math.round(base * atkMult * spdMult * typeMult * defReduct));
  }

  // ── Execute one move ──────────────────────────────────────────────────────
  function executeMove(attacker, defender, move) {
    if (Math.random() * 100 > effAccuracy(attacker)) return;

    // Heal move (negative damage values)
    if (move.damage && move.damage[1] < 0) {
      const amt = Math.abs(move.damage[0]);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + amt);
      return;
    }

    const defStatusBefore = defender.statuses.slice();

    // Damage move
    if (move.damage && move.damage[1] > 0) {
      const base = rng(move.damage[0], move.damage[1]);
      const dmg  = calcDamage(attacker, defender, base, move.speed);
      defender.hp = Math.max(0, defender.hp - dmg);
      _applyMoveStatuses(move, attacker, defender);
      _recordLandedStatuses(attacker, move, defStatusBefore, defender);
      return;
    }

    // Pure status move
    _applyMoveStatuses(move, attacker, defender);
    _recordLandedStatuses(attacker, move, defStatusBefore, defender);
  }

  // Helper: apply all statuses from a move with per-stat stack cap
  function _applyMoveStatuses(move, attacker, defender) {
    const statApplied = { atk:0, speed:0, defense:0, accuracy:0 };
    for (const se of getMoveStatuses(move)) {
      const chance = se.statusChance ?? 1.0;
      if (Math.random() >= chance) continue;
      const st = se.status;
      if (st === 'statup' || st === 'statdwn') {
        const key = se.statTarget || 'atk';
        if ((statApplied[key] || 0) >= STAT_STACK_CAP) continue;
        statApplied[key] = (statApplied[key] || 0) + 1;
      }
      const tgt = (st === 'statup') ? attacker : defender;
      applyStatus(tgt, st, se.statTarget || null);
    }
  }

  // ── End-of-turn ticks ─────────────────────────────────────────────────────
  function endOfTurnTick(f) {
    if (f.statuses.includes('burn'))   f.hp = Math.max(0, f.hp - Math.round(f.maxHp * 0.06));
    if (f.statuses.includes('poison')) f.hp = Math.max(0, f.hp - Math.round(f.maxHp * 0.08));
    if (f.statuses.includes('confuse')) {
      f.confuseTurns--;
      if (f.confuseTurns <= 0) removeStatus(f,'confuse');
    }
    // Decay statup boosts
    let anyStatup = false;
    for (const stat of ['atk','speed','defense','accuracy']) {
      if (f.statupTurns[stat] > 0) {
        f.statupTurns[stat]--;
        anyStatup = true;
        if (f.statupTurns[stat] === 0) {
          if (stat==='atk')      f.atkMod      = Math.max(0, f.atkMod      - 20);
          if (stat==='speed')    f.speedMod    = Math.max(0, f.speedMod    - 20);
          if (stat==='defense')  f.defenseMod  = Math.max(0, f.defenseMod  - 15);
          if (stat==='accuracy') f.accuracyMod = Math.max(0, f.accuracyMod - 15);
        }
      }
    }
    if (!anyStatup) removeStatus(f,'statup');
    // Decay statdwn penalties
    let anyStatdwn = false;
    for (const stat of ['atk','speed','defense','accuracy']) {
      if (f.statdwnTurns[stat] > 0) {
        f.statdwnTurns[stat]--;
        anyStatdwn = true;
        if (f.statdwnTurns[stat] === 0) {
          if (stat==='atk')      f.atkMod      = Math.min(0, f.atkMod      + 20);
          if (stat==='speed')    f.speedMod    = Math.min(0, f.speedMod    + 20);
          if (stat==='defense')  f.defenseMod  = Math.min(0, f.defenseMod  + 15);
          if (stat==='accuracy') f.accuracyMod = Math.min(0, f.accuracyMod + 15);
        }
      }
    }
    if (!anyStatdwn) removeStatus(f,'statdwn');
  }

  // ── AI move picker (plays like a real player) ─────────────────────────────
  //
  // All moves score on the same 0–∞ numeric scale. Highest score wins.
  // This avoids the hard-tier problem where status moves always beat damage.
  //
  // Scoring rules:
  //   Damage moves:    expected damage dealt
  //                    + 20% bonus if the move also inflicts a new useful status
  //                    + speed bonus (fast +15%, slow -12%) already in calcDamage
  //   Status moves:    STATUS_VALUE × chance  (only if status is new AND not yet
  //                    applied by this fighter this battle — no re-spam)
  //   Buff moves:      flat 25 (worth ~1–2 turns of mild damage, played at most once)
  //   Heal moves:      heal amount × (1 - hpFrac)²  — only below 50% HP
  //   Already-used / redundant moves: score 0 (filtered out)
  //
  // STATUS_VALUE is calibrated so that sleep (~80) beats a 70-damage hit but
  // loses to a 100-damage hit — matching real player intuition.

  // How many effective HP points each status is worth over its duration
  const STATUS_VALUE = { sleep:80, paralyze:60, burn:45, poison:40, confuse:30, statdwn:28, flinch:15 };

  function pickBestMove(self, opponent) {
    const moves  = self.moves;
    const hpFrac = self.hp / self.maxHp;

    if (!self._usedStatuses) self._usedStatuses = new Set();

    let bestMove  = moves[0];
    let bestScore = -Infinity;

    for (const move of moves) {
      const isDmg    = move.damage && move.damage[1] > 0;
      const isHeal   = move.damage && move.damage[1] < 0;
      const statList = getMoveStatuses(move);
      let score = 0;

      // ── Damage moves ──────────────────────────────────────────────────────
      if (isDmg) {
        const mid = (move.damage[0] + move.damage[1]) / 2;
        score = calcDamage(self, opponent, mid, move.speed);

        // Small bonus if this move also inflicts a useful new status
        for (const se of statList) {
          const st = se.status;
          if (!st || st === 'statup') continue;
          if (st !== 'flinch' && st !== 'statdwn' && opponent.statuses.includes(st)) continue;
          if (self._usedStatuses.has(st)) continue;
          const bonus = (STATUS_VALUE[st] || 5) * (se.statusChance ?? 1.0) * 0.2;
          score += bonus;
          break; // only count the best bonus
        }
      }

      // ── Pure status moves ─────────────────────────────────────────────────
      else if (!isHeal) {
        for (const se of statList) {
          const st = se.status;
          if (!st || st === 'statup') continue;
          if (st !== 'flinch' && st !== 'statdwn' && opponent.statuses.includes(st)) continue;
          if (self._usedStatuses.has(st)) continue;
          const val = (STATUS_VALUE[st] || 5) * (se.statusChance ?? 1.0);
          if (val > score) score = val;
        }
        // Pure buff (statup)
        if (score === 0 && statList.some(se => se.status === 'statup')) {
          const anyNew = statList.some(se =>
            se.status === 'statup' && self.statupTurns[se.statTarget || 'atk'] === 0
          );
          score = anyNew ? 25 : 0;
        }
      }

      // ── Heal moves ────────────────────────────────────────────────────────
      else if (isHeal) {
        if (hpFrac < 0.5) {
          // Value increases sharply when HP is very low
          score = Math.abs(move.damage[0]) * Math.pow(1 - hpFrac, 2) * 2;
        } else {
          score = 0; // never heal above 50%
        }
      }

      if (score > bestScore) { bestScore = score; bestMove = move; }
    }

    return bestMove;
  }

  // Called after executeMove to record which statuses were successfully landed.
  function _recordLandedStatuses(self, move, defStatusBefore, defender) {
    if (!self._usedStatuses) self._usedStatuses = new Set();
    for (const se of getMoveStatuses(move)) {
      const st = se.status;
      if (!st || st === 'statup' || st === 'flinch') continue;
      if (defender.statuses.includes(st) || st === 'statdwn') {
        self._usedStatuses.add(st);
      }
    }
  }

  // ── One battle simulation ─────────────────────────────────────────────────
  // Returns { won: bool, turns: number, hpRemaining: number }
  function runOneBattle(subject, benchDef) {
    const a = mkState(subject);
    const b = mkState(benchDef);

    for (let t = 1; t <= MAX_TURNS; t++) {
      const mA = pickBestMove(a, b);
      const mB = pickBestMove(b, a);

      const tierA = SPEED_ORDER[mA.speed] || 2;
      const tierB = SPEED_ORDER[mB.speed] || 2;
      const aFirst = tierA < tierB || (tierA === tierB && effSpeed(a) >= effSpeed(b));

      const order = aFirst
        ? [[a,b,mA,true],[b,a,mB,false]]
        : [[b,a,mB,false],[a,b,mA,true]];

      for (const [attacker, defender, move] of order) {
        const { blocked, selfDmg } = preActionChecks(attacker);
        attacker.hp = Math.max(0, attacker.hp - selfDmg);
        if (!blocked) executeMove(attacker, defender, move);
        if (a.hp <= 0) return { won:false, turns:t, hpRemaining:0 };
        if (b.hp <= 0) return { won:true,  turns:t, hpRemaining:a.hp };
      }

      endOfTurnTick(a);
      endOfTurnTick(b);
      if (a.hp <= 0) return { won:false, turns:t, hpRemaining:0 };
      if (b.hp <= 0) return { won:true,  turns:t, hpRemaining:a.hp };
    }
    return { won:false, turns:MAX_TURNS, hpRemaining:a.hp };
  }

  // ── calcPowerLevel ────────────────────────────────────────────────────────
  function calcPowerLevel(fakemon) {
    dbg(`━━ Scoring: ${fakemon.name} (${fakemon.id}) ━━`, 'info');
    dbg(`Stats — HP:${fakemon.hp ?? 100}  ATK:${fakemon.atk ?? fakemon.power ?? 100}  SPD:${fakemon.speed ?? 90}  DEF:${fakemon.defense ?? 10}  ACC:${fakemon.accuracy ?? 90}  TYPE:${fakemon.type}`, 'info');

    let wins = 0;
    let totalTurnsWon = 0;
    let totalHpRemainingPct = 0;

    for (let i = 0; i < SIMULATIONS; i++) {
      const { won, turns, hpRemaining } = runOneBattle(fakemon, BENCHMARK);
      if (won) {
        wins++;
        totalTurnsWon += turns;
        totalHpRemainingPct += hpRemaining / (fakemon.hp ?? 100);
      }
      if (i < 3) {
        dbg(`  sim ${i+1}: ${won ? '✅ WIN' : '❌ LOSS'} in ${turns} turns, HP left: ${hpRemaining}`, 'sim');
      }
    }

    const winRate = wins / SIMULATIONS;  // 0–1

    // Efficiency: average turns to win. Fewer turns = higher score.
    // 1 turn → 1.0, MAX_TURNS turns → ~0.0
    const avgTurns = wins > 0 ? totalTurnsWon / wins : MAX_TURNS;
    const effScore = wins > 0 ? Math.max(0, 1 - (avgTurns - 1) / (MAX_TURNS - 1)) : 0;

    // Survivability: average remaining HP% when winning
    const survScore = wins > 0 ? totalHpRemainingPct / wins : 0;

    const raw = winRate * W_WIN + effScore * W_EFF + survScore * W_SURV;
    const final = Math.round(Math.min(1000, Math.max(0, raw)));

    dbg(`Results — wins:${wins}/${SIMULATIONS} (${(winRate*100).toFixed(1)}%)  avgTurns:${avgTurns.toFixed(1)}  avgHp%:${(survScore*100).toFixed(1)}%`, 'info');
    dbg(`Score components — Win:${Math.round(winRate*W_WIN)}  Eff:${Math.round(effScore*W_EFF)}  Surv:${Math.round(survScore*W_SURV)}  → TOTAL: ${final}`, 'info');

    return final;
  }

  // ── Validation ────────────────────────────────────────────────────────────
  function validateFakemon(f) {
    const errors = [], warnings = [];

    if (!f.id || typeof f.id !== 'string')
      errors.push('Missing or invalid "id" field (must be a string)');
    else if (/[\s\/\\'"{}]/.test(f.id))
      errors.push(`id "${f.id}" contains invalid characters (no spaces, slashes, or quotes)`);

    if (!f.name || typeof f.name !== 'string')
      errors.push('Missing or invalid "name" field');
    if (!f.emoji || typeof f.emoji !== 'string')
      warnings.push('Missing "emoji" field — will show a placeholder');

    if (!f.type) {
      errors.push('Missing "type" field');
    } else {
      const VALID_TYPES = ['Fire','Water','Air','Earth','Electric','Ice','Poison','Dark','Ghost','Metal','Nature','Normal'];
      if (!VALID_TYPES.includes(f.type))
        errors.push(`Unknown type "${f.type}" — valid types: ${VALID_TYPES.join(', ')}`);
    }

    for (const s of ['hp','speed','defense','accuracy']) {
      if (f[s] === undefined)              warnings.push(`Missing stat "${s}" — will use default`);
      else if (typeof f[s] !== 'number')   errors.push(`Stat "${s}" must be a number, got ${typeof f[s]}`);
    }
    if (f.atk === undefined && f.power === undefined)
      warnings.push('Missing stat "atk" — will use default');
    else if (f.atk !== undefined && typeof f.atk !== 'number')
      errors.push('Stat "atk" must be a number');

    if (!Array.isArray(f.moves)) {
      errors.push('Missing or invalid "moves" array');
    } else {
      if (f.moves.length < 4) warnings.push(`Only ${f.moves.length} moves — guide recommends 4–8`);
      if (f.moves.length > 8) warnings.push(`${f.moves.length} moves — guide recommends max 8`);
      if (!f.moves.some(m => m.damage && m.damage[1] > 0))
        warnings.push('No damage moves found — Fakemon may never finish a fight');

      const ids = new Set();
      const VALID_STATUSES   = ['poison','burn','paralyze','sleep','confuse','flinch','statup','statdwn',null,undefined];
      const VALID_STAT_TGTS  = ['atk','power','speed','defense','accuracy',null,undefined];

      f.moves.forEach((m, i) => {
        const lbl = `Move ${i+1} (${m.name || m.id || 'unnamed'})`;
        if (!m.id)              errors.push(`${lbl}: missing "id" field`);
        else if (ids.has(m.id)) errors.push(`Duplicate move id "${m.id}"`);
        else ids.add(m.id);

        if (!m.name) warnings.push(`${lbl}: missing "name" field`);
        if (!['fast','medium','slow'].includes(m.speed))
          errors.push(`${lbl}: "speed" must be "fast", "medium", or "slow" — got "${m.speed}"`);
        if (!Array.isArray(m.damage) || m.damage.length !== 2)
          errors.push(`${lbl}: "damage" must be an array of two numbers, e.g. [10, 20]`);
        else {
          if (typeof m.damage[0] !== 'number' || typeof m.damage[1] !== 'number')
            errors.push(`${lbl}: both damage values must be numbers`);
          if (m.damage[0] > m.damage[1] && m.damage[1] > 0)
            warnings.push(`${lbl}: damage min (${m.damage[0]}) is greater than max (${m.damage[1]})`);
        }

        if (Array.isArray(m.statuses)) {
          m.statuses.forEach((se, si) => {
            const sel = `${lbl} status[${si}]`;
            if (!VALID_STATUSES.includes(se.status))
              errors.push(`${sel}: unknown status "${se.status}"`);
            if (se.statusChance !== undefined && (typeof se.statusChance !== 'number' || se.statusChance < 0 || se.statusChance > 1))
              errors.push(`${sel}: "statusChance" must be a number 0–1`);
            if ((se.status==='statup'||se.status==='statdwn') && se.statTarget && !VALID_STAT_TGTS.includes(se.statTarget))
              errors.push(`${sel}: "statTarget" must be one of: atk, speed, defense, accuracy`);
          });
        } else {
          if (m.status && !VALID_STATUSES.includes(m.status))
            errors.push(`${lbl}: unknown status "${m.status}"`);
          if (m.statusChance !== undefined && (typeof m.statusChance !== 'number' || m.statusChance < 0 || m.statusChance > 1))
            errors.push(`${lbl}: "statusChance" must be a number between 0 and 1`);
          if ((m.status==='statup'||m.status==='statdwn') && m.statTarget && !VALID_STAT_TGTS.includes(m.statTarget))
            errors.push(`${lbl}: "statTarget" must be one of: atk, speed, defense, accuracy`);
        }
      });
    }

    if (!f.description) warnings.push('Missing "description" field');
    if (!f.createdBy)   warnings.push('Missing "createdBy" field');

    return { errors, warnings, valid: errors.length === 0 };
  }

  // ── Utility ───────────────────────────────────────────────────────────────
  function rng(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

  // ═══════════════════════════════════════════════════════════════════════════
  // ON-SCREEN DEBUG PANEL
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Because students are on Chromebooks and cannot open DevTools, all debug
  // output goes to a floating panel rendered directly on the page.
  //
  // Usage (from fakemon-battle.html or anywhere on the page):
  //
  //   FakemonScorer.attachDebugPanel('debug-container');
  //     → pass any element id (or the element itself) to anchor the panel.
  //       If omitted the panel is appended to document.body.
  //
  //   FakemonScorer.dbg('Something happened', 'warn');
  //     → levels: 'info' | 'warn' | 'error' | 'sim'
  //
  //   FakemonScorer.detachDebugPanel();
  //     → removes the panel from the DOM.
  //
  // The panel is HIDDEN BY DEFAULT and only becomes visible after
  // attachDebugPanel() is called. It has filter tabs and a clear button.
  // ═══════════════════════════════════════════════════════════════════════════

  let _panel  = null;
  let _logEl  = null;
  let _logBuf = [];          // buffer messages before panel is attached
  let _filter = 'all';

  const LEVEL_COLORS = {
    info:  '#aef',
    warn:  '#fe8',
    error: '#f77',
    sim:   '#cfc',
  };

  function dbg(msg, level = 'info') {
    const entry = { msg: String(msg), level, ts: new Date().toLocaleTimeString() };
    _logBuf.push(entry);
    if (_logEl) _renderEntry(entry);
  }

  function _renderEntry(entry) {
    if (_filter !== 'all' && _filter !== entry.level) return;
    const row = document.createElement('div');
    row.dataset.level = entry.level;
    row.style.cssText = `
      padding: 2px 4px;
      border-bottom: 1px solid #333;
      color: ${LEVEL_COLORS[entry.level] || '#eee'};
      font-size: 11px;
      font-family: monospace;
      word-break: break-all;
    `;
    row.textContent = `[${entry.ts}] [${entry.level.toUpperCase()}] ${entry.msg}`;
    _logEl.appendChild(row);
    _logEl.scrollTop = _logEl.scrollHeight;
  }

  function _rebuildLog() {
    if (!_logEl) return;
    _logEl.innerHTML = '';
    for (const entry of _logBuf) _renderEntry(entry);
  }

  function attachDebugPanel(anchor) {
    if (_panel) return;  // already attached

    // Resolve anchor element
    let anchorEl = null;
    if (typeof anchor === 'string') anchorEl = document.getElementById(anchor);
    else if (anchor instanceof Element) anchorEl = anchor;
    if (!anchorEl) anchorEl = document.body;

    // Build panel
    _panel = document.createElement('div');
    _panel.id = 'fakemon-debug-panel';
    _panel.style.cssText = `
      position: fixed;
      bottom: 12px;
      right: 12px;
      width: 480px;
      max-height: 320px;
      background: #1a1a2e;
      border: 2px solid #444;
      border-radius: 8px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      font-family: monospace;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    `;

    // Header bar
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: #0f3460;
      border-radius: 6px 6px 0 0;
      cursor: move;
      user-select: none;
    `;

    const title = document.createElement('span');
    title.style.cssText = 'color:#7ef;font-weight:bold;font-size:12px;flex:1;';
    title.textContent = '🐛 Fakemon Debug Panel';

    // Filter tabs
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:3px;';
    for (const lvl of ['all','info','warn','error','sim']) {
      const btn = document.createElement('button');
      btn.textContent = lvl;
      btn.dataset.filterVal = lvl;
      btn.style.cssText = `
        padding: 1px 6px;
        font-size: 10px;
        border-radius: 3px;
        border: 1px solid #555;
        background: ${lvl === 'all' ? '#336' : '#222'};
        color: #ccc;
        cursor: pointer;
      `;
      btn.addEventListener('click', () => {
        _filter = lvl;
        tabs.querySelectorAll('button').forEach(b => {
          b.style.background = b.dataset.filterVal === lvl ? '#336' : '#222';
        });
        _rebuildLog();
      });
      tabs.appendChild(btn);
    }

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '🗑';
    clearBtn.title = 'Clear log';
    clearBtn.style.cssText = 'padding:1px 5px;font-size:11px;border:1px solid #555;border-radius:3px;background:#222;color:#ccc;cursor:pointer;';
    clearBtn.addEventListener('click', () => { _logBuf = []; if (_logEl) _logEl.innerHTML = ''; });

    // Minimise toggle
    let minimised = false;
    const minBtn = document.createElement('button');
    minBtn.textContent = '▼';
    minBtn.title = 'Minimise';
    minBtn.style.cssText = 'padding:1px 5px;font-size:11px;border:1px solid #555;border-radius:3px;background:#222;color:#ccc;cursor:pointer;';
    minBtn.addEventListener('click', () => {
      minimised = !minimised;
      _logEl.style.display   = minimised ? 'none' : 'block';
      footer.style.display   = minimised ? 'none' : 'flex';
      minBtn.textContent     = minimised ? '▲' : '▼';
      _panel.style.maxHeight = minimised ? 'none' : '320px';
    });

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close panel';
    closeBtn.style.cssText = 'padding:1px 5px;font-size:11px;border:1px solid #555;border-radius:3px;background:#400;color:#f99;cursor:pointer;';
    closeBtn.addEventListener('click', detachDebugPanel);

    header.append(title, tabs, clearBtn, minBtn, closeBtn);

    // Log area
    _logEl = document.createElement('div');
    _logEl.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 4px;
      background: #0d0d1a;
      max-height: 240px;
    `;

    // Footer — shows count
    const footer = document.createElement('div');
    footer.style.cssText = 'padding:3px 8px;font-size:10px;color:#888;background:#111;border-radius:0 0 6px 6px;display:flex;justify-content:space-between;';

    const countSpan = document.createElement('span');
    footer.appendChild(countSpan);
    const hint = document.createElement('span');
    hint.textContent = 'score.js debug panel — FakemonScorer.dbg(msg, level)';
    footer.appendChild(hint);

    // Update count on every new message
    const origDbg = dbg;
    setInterval(() => {
      countSpan.textContent = `${_logBuf.length} entries`;
    }, 500);

    _panel.append(header, _logEl, footer);
    anchorEl.appendChild(_panel);

    // Flush buffer
    _rebuildLog();

    // Draggable
    let dx = 0, dy = 0, dragging = false;
    header.addEventListener('mousedown', e => {
      dragging = true;
      dx = e.clientX - _panel.getBoundingClientRect().left;
      dy = e.clientY - _panel.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      _panel.style.left   = (e.clientX - dx) + 'px';
      _panel.style.top    = (e.clientY - dy) + 'px';
      _panel.style.right  = 'auto';
      _panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    dbg('Debug panel attached. Use FakemonScorer.dbg(msg, level) to log messages here.', 'info');
    dbg('Levels: info | warn | error | sim', 'info');
  }

  function detachDebugPanel() {
    if (_panel) {
      _panel.remove();
      _panel  = null;
      _logEl  = null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    calcPowerLevel,
    validateFakemon,
    typeMultiplier,
    getMoveStatuses,
    attachDebugPanel,
    detachDebugPanel,
    dbg,
  };

})();