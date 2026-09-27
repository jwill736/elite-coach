/* Elite Coach OS plan builder, running entirely in the browser.
 *
 * A line-for-line port of api/planner.py in the app, checked against it by a
 * parity test: the same answers give the same plan. Nothing typed on the page
 * is sent anywhere.
 */
(function (root) {
  "use strict";

  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const GOALS = {
    marathon: { label: "Marathon", miles: 26.2 },
    half: { label: "Half marathon", miles: 13.1 },
    "10k": { label: "10K", miles: 6.2 },
    "5k": { label: "5K", miles: 3.1 },
    consistency: { label: "Just run consistently", miles: null },
  };
  const BUILD_LEN = { marathon: 18, half: 12, "10k": 10, "5k": 8 };
  const MIN_BUILD = { marathon: 12, half: 8, "10k": 6, "5k": 4 };
  const TAPER = { marathon: [0.84, 0.64], half: [0.72], "10k": [], "5k": [] };
  const RACE_WEEK = { marathon: 0.33, half: 0.45, "10k": 0.6, "5k": 0.6 };
  const RAMP = { gentle: 0.07, balanced: 0.10, aggressive: 0.13 };
  const CUTBACK_EVERY = { gentle: 3, balanced: 4, aggressive: 4 };
  const CUTBACK = 0.8, BUILD_START = 0.65, RETURN_GAP = 14, CONSISTENCY_WEEKS = 16;
  const PEAK = {
    marathon: { gentle: [1.05, 30, 45], balanced: [1.25, 35, 55], aggressive: [1.55, 40, 65] },
    half: { gentle: [1.0, 20, 35], balanced: [1.2, 25, 42], aggressive: [1.4, 28, 50] },
    "10k": { gentle: [1.0, 15, 28], balanced: [1.15, 18, 35], aggressive: [1.3, 20, 42] },
    "5k": { gentle: [1.0, 12, 25], balanced: [1.1, 15, 30], aggressive: [1.25, 18, 38] },
  };
  const CONSISTENCY_TARGET = { gentle: 20, balanced: 25, aggressive: 30 };
  const LONG = {
    marathon: [0.36, { gentle: 18, balanced: 20, aggressive: 20 }],
    half: [0.33, { gentle: 12, balanced: 13, aggressive: 14 }],
    "10k": [0.30, { gentle: 8, balanced: 9, aggressive: 10 }],
    "5k": [0.28, { gentle: 6, balanced: 7, aggressive: 8 }],
    consistency: [0.30, { gentle: 8, balanced: 10, aggressive: 12 }],
  };
  const LONG_MAX = { marathon: 22, half: 15, "10k": 12, "5k": 10, consistency: 14 };
  const TUNE_UP = { marathon: ["half marathon", 13.1], half: ["10K", 6.2], "10k": ["5K", 3.1], "5k": ["5K", 3.1] };
  const RECOVERY = { marathon: [0.2, 0.35], half: [0.4], "10k": [], "5k": [] };
  const FOCUS = {
    return: "Coming back. Every run easy; showing up is the whole job.",
    base: "Build the habit and the engine. Easy miles, conversation pace.",
    build: "Workouts get real. Easy days stay easy so the hard ones land.",
    "race-specific": "Race-shaped work. The long runs are the priority.",
    cutback: "Cutback week. Absorb the work — this is where you get fitter.",
    "tune-up": "Tune-up race this week. The result sets your race pace.",
    taper: "Taper. Less volume, same sharpness. Trust the work.",
    race: "Race week. Rest, eat, and go get it.",
    recovery: "Recovery. Walk every day; jog only if the legs say yes.",
    hold: "Holding steady. Consistency is the training.",
  };

  // Python's round(): halves go to the even neighbour.
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  // Python's round(x, 1) rounds the exact stored value; toFixed does too,
  // except on true ties (x.25, x.75), where Python goes to the even digit.
  function round1(x) {
    if (Number.isInteger(x * 4) && !Number.isInteger(x * 2)) return pyRound(x * 10) / 10;
    return parseFloat(x.toFixed(1));
  }
  const r = (x) => pyRound(x * 2) / 2;
  const mod = (a, n) => ((a % n) + n) % n;

  // Dates as whole days since 1970 (UTC), so time zones never shift a day.
  const toDay = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  const toIso = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
  const weekday = (day) => mod(new Date(day * 86400000).getUTCDay() + 6, 7);   // Monday = 0
  const monday = (day) => day - weekday(day);

  function validate(raw) {
    raw = raw || {};
    const p = { goal: "consistency", race_date: null, race_name: "", goal_time: "",
                run_days: ["mon", "tue", "thu", "sat"], long_day: "sat", group_run: null,
                style: "balanced", tone: "direct" };
    if (GOALS[raw.goal]) p.goal = raw.goal;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.race_date || "") && !isNaN(toDay(raw.race_date))) p.race_date = raw.race_date;
    if (typeof raw.race_name === "string") p.race_name = raw.race_name.trim().slice(0, 80);
    const days = DAYS.filter((d) => (raw.run_days || []).includes(d));
    if (days.length >= 3 && days.length <= 6) p.run_days = days;
    if (DAYS.includes(raw.long_day)) p.long_day = raw.long_day;
    if (!p.run_days.includes(p.long_day)) p.run_days = DAYS.filter((d) => p.run_days.includes(d) || d === p.long_day);
    const g = raw.group_run;
    if (g && DAYS.includes(g.day)) {
      p.group_run = { day: g.day, name: String(g.name || "Group run").slice(0, 40), quality: g.quality !== false };
      if (!p.run_days.includes(g.day)) p.run_days = DAYS.filter((d) => p.run_days.includes(d) || d === g.day);
    }
    if (RAMP[raw.style] !== undefined) p.style = raw.style;
    if (p.goal === "consistency") p.race_date = null;
    return p;
  }

  function peakMiles(goal, style, best) {
    const [mult, lo, hi] = PEAK[goal][style];
    return pyRound(Math.max(lo, Math.min(best * mult, hi)));
  }

  function startMiles(fit, runDays, style) {
    const floor = 2.0 * runDays, cur = fit.current_weekly || 0, best = fit.best_week || 0;
    const gap = fit.days_since_last_run;
    if (gap == null || gap >= RETURN_GAP) return r(Math.max(floor, Math.min(best * 0.4, 15)));
    return r(Math.max(floor, Math.min(cur * (1 + RAMP[style]), best || cur)));
  }

  function ramp(start, target, n, style) {
    const out = []; let full = null;
    for (let i = 0; i < n; i++) {
      if (full !== null && (i + 1) % CUTBACK_EVERY[style] === 0) { out.push([r(full * CUTBACK), true]); continue; }
      full = full === null ? start : Math.min(Math.max(target, start), full * (1 + RAMP[style]));
      out.push([r(full), false]);
    }
    return out;
  }

  function buildSeries(goal, style, peak) {
    const n = BUILD_LEN[goal], taper = TAPER[goal], climb = n - taper.length - 1, every = CUTBACK_EVERY[style];
    const cut = new Set();
    for (let i = 0; i < climb - 1; i++) if ((i + 1) % every === 0) cut.add(i);
    let fullCount = 0;
    for (let i = 0; i < climb; i++) if (!cut.has(i)) fullCount++;
    const steps = Math.max(fullCount - 1, 1);
    const growth = Math.min(Math.pow(1 / BUILD_START, 1 / steps), 1 + RAMP[style]);
    const start = peak / Math.pow(growth, steps);
    let tune = null;
    if (cut.size && TUNE_UP[goal]) {
      for (const i of [...cut].sort((a, b) => a - b)) {
        // Nearest 60% of the way in; on a tie the later one (ascending loop, <=).
        if (tune === null || Math.abs(i - climb * 0.6) <= Math.abs(tune - climb * 0.6)) tune = i;
      }
    }
    const weeks = []; let full = null;
    for (let i = 0; i < climb; i++) {
      if (cut.has(i)) { weeks.push({ miles: r(full * CUTBACK), kind: i === tune ? "tune-up" : "cutback" }); continue; }
      full = full === null ? start : full * growth;
      const kind = i < climb * 0.35 ? "base" : (i < climb * 0.75 ? "build" : "race-specific");
      weeks.push({ miles: r(full), kind });
    }
    weeks[weeks.length - 1].miles = r(peak);
    for (const f of taper) weeks.push({ miles: r(peak * f), kind: "taper" });
    weeks.push({ miles: r(peak * RACE_WEEK[goal]), kind: "race" });
    return weeks;
  }

  function qualityDay(p) {
    const others = p.run_days.filter((d) => d !== p.long_day);
    const group = p.group_run ? p.group_run.day : null;
    const li = DAYS.indexOf(p.long_day);
    const near = new Set([DAYS[mod(li - 1, 7)], DAYS[mod(li + 1, 7)]]);
    for (const d of (others.includes("tue") ? ["tue"] : []).concat(others)) if (d !== group && !near.has(d)) return d;
    return others.find((d) => d !== group) || null;
  }

  function run(miles, label, quality) {
    const m = round1(miles);
    const e = { miles: m, label: miles ? `${label} · ${m} mi` : label };
    if (quality) e.quality = true;
    return e;
  }

  function qualityLabel(kind, goal, style, p) {
    if (kind === "cutback" || kind === "tune-up") return ["Easy + 6×20s strides", false];
    if (kind === "taper") return goal === "marathon" || goal === "half"
      ? ["Easy + 3 mi at race pace", true] : ["Easy + 4×400 m at race pace", true];
    if (kind === "base" || goal === "consistency") {
      const hills = style === "aggressive" && Math.trunc(p * 20) % 2 === 1;
      return [hills ? "Easy + 8×45s hill repeats" : "Easy + 6×20s strides", false];
    }
    if (style === "gentle" && Math.trunc(p * 20) % 2 === 1) return ["Easy + 6×20s strides", false];
    if (goal === "marathon" || goal === "half") return [`Tempo · ${pyRound(2 + p * (goal === "marathon" ? 5 : 3))} mi steady inside the run`, true];
    if (goal === "10k") return [`Intervals · ${4 + pyRound(p * 3)}×1 km at 10K pace`, true];
    return [`Intervals · ${5 + pyRound(p * 3)}×800 m at 5K pace`, true];
  }

  function longLabel(kind, goal, style, p) {
    if ((kind === "race-specific" || kind === "build") && (goal === "marathon" || goal === "half") && style !== "gentle" && p > 0.4) {
      const n = goal === "marathon" ? 2 + pyRound(p * (style === "aggressive" ? 6 : 4)) : 1 + pyRound(p * 3);
      return [`Long run, last ${n} mi at race pace`, true];
    }
    return ["Long run easy", false];
  }

  function layout(p, weekMi, kind, goal, style, progress, race) {
    const runDays = p.run_days, longDay = p.long_day, group = p.group_run;
    const days = {}; DAYS.forEach((d) => { days[d] = { miles: 0, label: "Rest" }; });
    const afterLong = DAYS[mod(DAYS.indexOf(longDay) + 1, 7)];
    if (!runDays.includes(afterLong)) days[afterLong] = { miles: 0, label: "Walk 30–45 min" };

    if (kind === "race" && race) {
      const wd = weekday(race.day), raceDay = DAYS[wd], before = DAYS[mod(wd - 1, 7)];
      const easy = runDays.filter((d) => d !== raceDay && d !== before).slice(0, 3);
      const each = weekMi / Math.max(easy.length + 1, 1);
      easy.forEach((d) => { days[d] = run(each, "Easy"); });
      days[before] = run(Math.min(each, 2.0), "Shakeout");
      days[raceDay] = run(GOALS[goal].miles, `🏁 ${race.name || GOALS[goal].label}`, true);
      return days;
    }
    const [frac, caps] = LONG[LONG[goal] ? goal : "consistency"];
    const avg = weekMi / Math.max(runDays.length, 1);
    let longMi = Math.min(Math.max(weekMi * frac, avg * 1.3), caps[style]);
    if (longMi < avg * 1.15) longMi = Math.min(avg * 1.3, LONG_MAX[LONG_MAX[goal] ? goal : "consistency"]);
    const tune = kind === "tune-up" ? TUNE_UP[goal] : null;
    if (tune) longMi = tune[1] + (tune[1] > 10 ? 1.0 : 2.0);
    const others = runDays.filter((d) => d !== longDay);
    const q = qualityDay(p);
    const weights = {};
    others.forEach((d) => { weights[d] = d === q ? 1.1 : (DAYS[mod(DAYS.indexOf(d) + 1, 7)] === longDay ? 0.8 : 1.0); });
    const rest = Math.max(weekMi - longMi, 0);
    const tot = others.reduce((a, d) => a + weights[d], 0) || 1;
    let easySeen = 0;
    for (const d of others) {
      const mi = rest * weights[d] / tot;
      if (group && d === group.day) {
        const hard = !!group.quality && style !== "gentle" && kind !== "cutback" && kind !== "taper";
        days[d] = run(mi, group.name + (hard ? " · quality" : " · keep it controlled"), hard);
      } else if (d === q) {
        const [label, hard] = qualityLabel(kind, goal, style, progress);
        days[d] = run(mi, label, hard);
      } else {
        let label = "Easy";
        if (easySeen < 2 && kind !== "taper") label += " + strength 20 min";
        easySeen++;
        days[d] = run(mi, label);
      }
    }
    if (tune) days[longDay] = run(longMi, `🔬 Tune-up ${tune[0]} — race it, with warm-up and cool-down`, true);
    else { const [label, hard] = longLabel(kind, goal, style, progress); days[longDay] = run(longMi, label, hard); }
    return days;
  }

  function week(ws, miles, kind, label, p, goal, style, progress, race) {
    const phase = kind === "race" && race ? `race week · ${race.name || GOALS[goal].label}` : kind;
    return { week_start: toIso(ws), week_end: toIso(ws + 6), target_miles: miles, phase, label,
             focus: FOCUS[kind] || "", sessions: layout(p, miles, kind, goal, style, progress, race) };
  }

  function generate(p, fit, todayIso) {
    const goal = p.goal, style = p.style, nDays = p.run_days.length;
    const best = Math.max(fit.best_week || 0, fit.current_weekly || 0, 2.0 * nDays);
    const gap = fit.days_since_last_run;
    const comeback = gap == null || gap >= RETURN_GAP;
    const start = startMiles(fit, nDays, style);
    const thisMonday = monday(toDay(todayIso));
    const weeks = [], warnings = [];
    let race = null, summary;
    if (BUILD_LEN[goal] && p.race_date) {
      race = { day: toDay(p.race_date), name: p.race_name || "" };
      if (monday(race.day) < thisMonday) { warnings.push("That race date has passed, so this is a plan without a race."); race = null; }
    }
    if (race) {
      const n = BUILD_LEN[goal], peak = peakMiles(goal, style, best), build = buildSeries(goal, style, peak);
      const bstart = monday(race.day) - 7 * (n - 1);
      let first = 0, reached;
      if (bstart > thisMonday) {
        const nb = Math.floor((bstart - thisMonday) / 7);
        const base = ramp(start, build[0].miles, nb, style);
        base.forEach(([mi, cut], i) => {
          const kind = cut ? "cutback" : (comeback && i < 4 ? "return" : "base");
          weeks.push(week(thisMonday + 7 * i, mi, kind, `Base · week ${i + 1} of ${nb}`, p, goal, style, 0.0));
        });
        const fulls = base.filter(([, cut]) => !cut).map(([mi]) => mi);
        reached = fulls.length ? Math.max(...fulls) : start;
      } else {
        first = Math.floor((thisMonday - bstart) / 7);
        reached = start;
        if (n - first < MIN_BUILD[goal]) warnings.push(`Only ${n - first} weeks to race day — a ${GOALS[goal].label.toLowerCase()} build needs at least ${MIN_BUILD[goal]}. A later race would serve you better.`);
      }
      const need = Math.max(...build.slice(first, first + 2).map((w) => w.miles));
      const ceiling = bstart > thisMonday ? reached * (1 + RAMP[style]) : start;
      const scale = need ? Math.min(1.0, ceiling / need) : 1.0;
      if (scale < 0.9) warnings.push(`Your running right now is below what this build starts at, so it's scaled to ${pyRound(scale * 100)}%. More time before race day would let you build more.`);
      const climb = n - TAPER[goal].length - 1;
      for (let i = first; i < n; i++) {
        const w = build[i];
        weeks.push(week(bstart + 7 * i, r(w.miles * scale), w.kind, `${GOALS[goal].label} build · week ${i + 1} of ${n}`,
                        p, goal, style, Math.min(i / Math.max(climb - 1, 1), 1.0), race));
      }
      RECOVERY[goal].forEach((f, j) => {
        weeks.push(week(monday(race.day) + 7 * (j + 1), r(peak * scale * f), "recovery", "Recovery", p, "consistency", "gentle", 0.0));
      });
      summary = { peak: r(peak * scale), build_start: toIso(bstart), race_date: toIso(race.day) };
    } else {
      const target = Math.max(start, Math.min(best * 0.9, CONSISTENCY_TARGET[style]));
      ramp(start, target, CONSISTENCY_WEEKS, style).forEach(([mi, cut], i) => {
        const kind = cut ? "cutback" : (comeback && i < 4 ? "return" : (mi >= target ? "hold" : "base"));
        weeks.push(week(thisMonday + 7 * i, mi, kind, `Week ${i + 1}`, p, "consistency", style, i / CONSISTENCY_WEEKS));
      });
      summary = { peak: r(target), build_start: null, race_date: null };
    }
    let longest = 0;
    for (const w of weeks) if (w.phase !== "recovery") longest = Math.max(longest, w.sessions[p.long_day].miles);
    Object.assign(summary, { weeks: weeks.length, start: weeks.length ? weeks[0].target_miles : start,
                             longest_run: longest, comeback });
    return { weeks, summary, warnings };
  }

  const api = { DAYS, GOALS, validate, generate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Planner = api;
})(this);
