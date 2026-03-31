import { supabase } from './supabase.js'
import { checkAuth, getCurrentProfile, signOut as authSignOut } from './auth.js'

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let currentUid = null
let currentProfile = null

// In-memory caches to avoid redundant round-trips during a single page session
let _sessionsCache = null
let _racesCache = null
let _checkinsCache = null
let _sleepCache = null
let _exercisesCache = null

// ═══════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════
export function showToast(msg, type = 'info') {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.className = 'toast-container'
    container.id = 'toast-container'
    document.body.appendChild(container)
  }
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'
  toast.innerHTML = `<span style="font-weight:700">${icon}</span><span>${msg}</span>`
  container.appendChild(toast)
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300) }, 3500)
}

export function showLoading(pageEl) {
  if (!pageEl) return
  const overlay = document.createElement('div')
  overlay.className = 'loading-overlay'
  overlay.id = 'loading-overlay'
  overlay.innerHTML = '<div class="spinner"></div>'
  pageEl.style.position = 'relative'
  pageEl.appendChild(overlay)
}

export function hideLoading(pageEl) {
  if (!pageEl) return
  const overlay = pageEl.querySelector('#loading-overlay')
  if (overlay) overlay.remove()
}

// ═══════════════════════════════════════════════════════
// DATA SHAPE CONVERSION HELPERS
// ═══════════════════════════════════════════════════════

// Convert flat DB session rows (+ sleep data merged separately) into the
// {date, sessions:[], sleep:{}} format the rest of the code expects.
function dbRowsToLocalFormat(sessionRows, sleepRows, exerciseRows = []) {
  const dayMap = {}

  for (const row of sessionRows) {
    const d = row.date
    if (!dayMap[d]) dayMap[d] = { date: d, sessions: [], sleep: {} }
    dayMap[d].sessions.push({
      id: row.id,
      type: row.type,
      pieceType: row.piece_type || '',
      distance: row.distance_km != null ? String(row.distance_km) : '',
      split: row.split_text || '',
      splitSecs: row.split_secs || null,
      rate: row.stroke_rate != null ? String(row.stroke_rate) : '',
      rpe: row.rpe != null ? String(row.rpe) : '',
      notes: row.notes || '',
      exercises: exerciseRows
        .filter(ex => ex.session_id === row.id)
        .map(ex => ({
          name: ex.name || '',
          sets: ex.sets != null ? String(ex.sets) : '',
          reps: ex.reps != null ? String(ex.reps) : '',
          weight: ex.weight_kg != null ? String(ex.weight_kg) : ''
        }))
    })
    // Sort sessions within a day by session_number
    dayMap[d].sessions.sort((a, b) => {
      const an = sessionRows.find(r => r.id === a.id)?.session_number ?? 0
      const bn = sessionRows.find(r => r.id === b.id)?.session_number ?? 0
      return an - bn
    })
  }

  if (sleepRows) {
    for (const sl of sleepRows) {
      const d = sl.date
      if (!dayMap[d]) dayMap[d] = { date: d, sessions: [], sleep: {} }
      dayMap[d].sleep = {
        bedtime: sl.bedtime || '',
        wakeTime: sl.wake_time || '',
        hours: sl.hours_slept != null ? sl.hours_slept : null,
        quality: sl.quality != null ? sl.quality : null
      }
    }
  }

  return Object.values(dayMap).sort((a, b) => a.date < b.date ? 1 : -1)
}

// Flatten a day's sessions array to DB rows
function localFormatToDbRows(day, userId) {
  return day.sessions.map((s, i) => {
    const row = {
      user_id: userId,
      date: day.date,
      session_number: i + 1,
      type: s.type,
      piece_type: s.pieceType || null,
      distance_km: s.distance ? parseFloat(s.distance) : null,
      split_text: s.split || null,
      split_secs: parseSplit(s.split) || s.splitSecs || null,
      stroke_rate: s.rate ? parseInt(s.rate) : null,
      rpe: s.rpe ? parseInt(s.rpe) : null,
      notes: s.notes || null,
      tss: null
    }
    // Only include id if it already exists (existing DB row) — omitting it
    // lets Postgres auto-generate a UUID via gen_random_uuid()
    if (s.id) row.id = s.id
    return row
  })
}

// ═══════════════════════════════════════════════════════
// DATA LAYER (Supabase)
// ═══════════════════════════════════════════════════════
async function getSessionRows() {
  if (_sessionsCache) return _sessionsCache
  const uid = currentUid || (await supabase.auth.getUser()).data.user?.id
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', uid)
    .order('date', { ascending: false })
  if (error) { showToast('Error loading sessions: ' + error.message, 'error'); return [] }
  _sessionsCache = data || []
  return _sessionsCache
}

async function getExerciseRows() {
  if (_exercisesCache) return _exercisesCache
  const uid = currentUid || (await supabase.auth.getUser()).data.user?.id
  const { data, error } = await supabase
    .from('exercises')
    .select('*')
    .eq('user_id', uid)
  if (error) { console.error('Error loading exercises:', error); return [] }
  _exercisesCache = data || []
  return _exercisesCache
}

async function getSleepRows() {
  if (_sleepCache) return _sleepCache
  const uid = currentUid || (await supabase.auth.getUser()).data.user?.id
  const { data, error } = await supabase
    .from('sleep_logs')
    .select('*')
    .eq('user_id', uid)
    .order('date', { ascending: false })
  if (error) { showToast('Error loading sleep: ' + error.message, 'error'); return [] }
  _sleepCache = data || []
  return _sleepCache
}

async function getAllSessions() {
  const [sessionRows, sleepRows, exerciseRows] = await Promise.all([
    getSessionRows(),
    getSleepRows(),
    getExerciseRows()
  ])
  return dbRowsToLocalFormat(sessionRows, sleepRows, exerciseRows)
}

async function getDay(date) {
  const all = await getAllSessions()
  return all.find(d => d.date === date) || null
}

async function upsertDay(day) {
  // Always fetch uid fresh from auth to avoid stale currentUid issues
  const { data: { user } } = await supabase.auth.getUser()
  const uid = user?.id || currentUid
  if (!uid) { showToast('Not authenticated', 'error'); return false }

  // 1. Delete existing session rows for this date
  await supabase.from('sessions').delete().eq('user_id', uid).eq('date', day.date)

  // 2. Insert new session rows
  const rows = localFormatToDbRows(day, uid)
  if (rows.length > 0) {
    const { data: inserted, error: sesErr } = await supabase.from('sessions').insert(rows).select()
    if (sesErr) { showToast('Error saving sessions: ' + sesErr.message, 'error'); return false }

    // 3. Handle S&C exercises
    for (let i = 0; i < day.sessions.length; i++) {
      const s = day.sessions[i]
      if (s.type === 'S&C' && s.exercises && s.exercises.length > 0) {
        const sessionId = inserted[i]?.id
        if (!sessionId) continue
        const exRows = s.exercises.map(ex => ({
          session_id: sessionId,
          user_id: uid,
          name: ex.name || 'Exercise',
          sets: ex.sets ? parseInt(ex.sets) : null,
          reps: ex.reps ? parseInt(ex.reps) : null,
          weight_kg: ex.weight ? parseFloat(ex.weight) : null
        }))
        await supabase.from('exercises').insert(exRows)
      }
    }
  }

  // 4. Upsert sleep log if present
  if (day.sleep && (day.sleep.hours != null || day.sleep.bedtime)) {
    const sleepRow = {
      user_id: uid,
      date: day.date,
      bedtime: day.sleep.bedtime || null,
      wake_time: day.sleep.wakeTime || null,
      hours_slept: day.sleep.hours != null ? parseFloat(day.sleep.hours) : null,
      quality: day.sleep.quality != null ? parseInt(day.sleep.quality) : null
    }
    const { error: slErr } = await supabase.from('sleep_logs').upsert(sleepRow, { onConflict: 'user_id,date' })
    if (slErr) { showToast('Error saving sleep: ' + slErr.message, 'error'); return false }
  }

  // Invalidate caches
  _sessionsCache = null
  _sleepCache = null
  _exercisesCache = null
  return true
}

async function getRaces() {
  if (_racesCache) return _racesCache
  const uid = currentUid || (await supabase.auth.getUser()).data.user?.id
  const { data, error } = await supabase
    .from('races')
    .select('*')
    .eq('user_id', uid)
    .order('date', { ascending: false })
  if (error) { showToast('Error loading races: ' + error.message, 'error'); return [] }
  _racesCache = data || []
  return _racesCache
}

async function saveRace(race) {
  const { data: { user } } = await supabase.auth.getUser()
  const uid = user?.id || currentUid
  const row = {
    user_id: uid,
    name: race.name,
    date: race.date,
    event: race.event || null,
    category: race.category || null,
    notes: race.notes || null,
    result_split: race.result || null,
    race_placing: race.placing || null
  }
  if (race.id && !race.id.toString().includes('-')) {
    // Legacy numeric id (from localStorage migration) — treat as new
    delete row.id
  } else if (race.id) {
    row.id = race.id
  }
  const { error } = await supabase.from('races').upsert(row)
  if (error) { showToast('Error saving race: ' + error.message, 'error'); return false }
  _racesCache = null
  return true
}

async function deleteRaceById(id) {
  const { data: { user } } = await supabase.auth.getUser()
  const uid = user?.id || currentUid
  const { error } = await supabase.from('races').delete().eq('id', id).eq('user_id', uid)
  if (error) { showToast('Error deleting race: ' + error.message, 'error'); return false }
  _racesCache = null
  return true
}

async function getCheckins() {
  if (_checkinsCache) return _checkinsCache
  const uid = currentUid || (await supabase.auth.getUser()).data.user?.id
  const { data, error } = await supabase
    .from('checkins')
    .select('*')
    .eq('user_id', uid)
    .order('date', { ascending: false })
  if (error) { showToast('Error loading check-ins: ' + error.message, 'error'); return [] }
  _checkinsCache = data || []
  return _checkinsCache
}

async function getCheckin(date) {
  const all = await getCheckins()
  return all.find(c => c.date === date) || null
}

async function upsertCheckin(ci) {
  const { data: { user } } = await supabase.auth.getUser()
  const uid = user?.id || currentUid
  if (!uid) { showToast('Not authenticated', 'error'); return false }
  const row = {
    user_id: uid,
    date: ci.date,
    fatigue: ci.fatigue,
    mood: ci.mood,
    soreness: ci.soreness,
    stress: ci.stress,
    hrv: ci.hrv || null,
    readiness_score: ci.readinessScore,
    traffic_light: ci.trafficLight
  }
  const { error } = await supabase.from('checkins').upsert(row, { onConflict: 'user_id,date' })
  if (error) { showToast('Error saving check-in: ' + error.message, 'error'); return false }
  _checkinsCache = null
  return true
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
const SESSION_TYPES = ['Race','Water Session','Pieces on Water','Erg UT2','Erg Threshold','Erg Intervals','S&C','Rest','Other']
const PIECE_TYPES = ['2k','5k','500m','1k','30 min','60 min','3x10 min','Other']
const ERG_TYPES = ['Erg UT2','Erg Threshold','Erg Intervals']

const TYPE_CHIP = {
  'Race':'chip-race','Water Session':'chip-water','Pieces on Water':'chip-pieces',
  'Erg UT2':'chip-ut2','Erg Threshold':'chip-threshold','Erg Intervals':'chip-intervals',
  'S&C':'chip-sc','Rest':'chip-rest','Other':'chip-other'
}

const TYPE_COLOR = {
  'Race':'#B83232','Water Session':'#2A6EA0','Pieces on Water':'#1A7888',
  'Erg UT2':'#2E7A4A','Erg Threshold':'#A86020','Erg Intervals':'#C96340',
  'S&C':'#6040A0','Rest':'#8C7660','Other':'#607080'
}

const INTENSITY_FACTOR = {
  'Race':1.5,'Water Session':0.6,'Pieces on Water':0.8,
  'Erg UT2':0.4,'Erg Threshold':1.0,'Erg Intervals':1.2,
  'S&C':0.5,'Rest':0,'Other':0.6
}

function chip(type) { return `<span class="chip ${TYPE_CHIP[type]||'chip-other'}">${type}</span>` }

function today() { return new Date().toISOString().slice(0,10) }

function dateAdd(d, days) {
  const dt = new Date(d+'T12:00:00')
  dt.setDate(dt.getDate()+days)
  return dt.toISOString().slice(0,10)
}

function dateDiff(a, b) {
  return Math.round((new Date(b)-new Date(a))/(1000*86400))
}

function parseSplit(s) {
  if(!s||!s.toString().trim()) return null
  s = s.toString().trim()
  const m = s.match(/^(\d+):(\d+\.?\d*)$/)
  if(!m) return null
  return parseInt(m[1])*60 + parseFloat(m[2])
}

function formatSplit(secs) {
  if(!secs||secs<=0) return '—'
  const m = Math.floor(secs/60)
  const s = (secs%60).toFixed(1).padStart(4,'0')
  return `${m}:${s}`
}

function formatDate(d) {
  if(!d) return ''
  const dt = new Date(d+'T12:00:00')
  return dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
}

function formatDateShort(d) {
  if(!d) return ''
  const dt = new Date(d+'T12:00:00')
  return dt.toLocaleDateString('en-GB',{day:'numeric',month:'short'})
}

function weekStart(d) {
  const dt = new Date(d+'T12:00:00')
  const day = dt.getDay()
  const diff = (day===0?-6:1-day)
  dt.setDate(dt.getDate()+diff)
  return dt.toISOString().slice(0,10)
}

// ═══════════════════════════════════════════════════════
// CALCULATIONS
// ═══════════════════════════════════════════════════════
function dayTSS(day) {
  if(!day||!day.sessions) return 0
  return day.sessions.reduce((sum,s) => {
    if(s.type==='Rest') return sum
    const dist = s.type==='S&C' ? 10 : (parseFloat(s.distance)||0)
    const rpe = parseFloat(s.rpe)||1
    const intensity = INTENSITY_FACTOR[s.type]??0.6
    return sum + dist * rpe * intensity
  }, 0)
}

function buildFitnessData(sessions, days=90) {
  const sessionMap = {}
  sessions.forEach(d => { sessionMap[d.date] = dayTSS(d) })

  const end = today()
  const displayStart = dateAdd(end, -days)

  const allDates = Object.keys(sessionMap).sort()
  const warmupStart = allDates.length
    ? dateAdd(allDates[0], -42)
    : dateAdd(displayStart, -42)

  const result = []
  let ctl=0, atl=0
  const ctlDecay = Math.exp(-1/42)
  const atlDecay = Math.exp(-1/7)

  let cursor = warmupStart
  while(cursor <= end) {
    const tss = sessionMap[cursor]||0
    ctl = ctl * ctlDecay + tss * (1 - ctlDecay)
    atl = atl * atlDecay + tss * (1 - atlDecay)
    if(cursor >= displayStart) {
      result.push({ date:cursor, tss, ctl:+ctl.toFixed(1), atl:+atl.toFixed(1), tsb:+(ctl-atl).toFixed(1) })
    }
    cursor = dateAdd(cursor, 1)
  }
  return result
}

function getWeeklyData(sessions, weeks=12) {
  const weekMap = {}
  sessions.forEach(day => {
    const w = weekStart(day.date)
    if(!weekMap[w]) weekMap[w]={ total:0, types:{} }
    day.sessions.forEach(s => {
      if(s.type==='Rest') return
      const dist = s.type==='S&C' ? 10 : (parseFloat(s.distance)||0)
      weekMap[w].total += dist
      weekMap[w].types[s.type] = (weekMap[w].types[s.type]||0)+dist
    })
  })

  const result = []
  for(let i=weeks-1; i>=0; i--) {
    const w = weekStart(dateAdd(today(),-i*7))
    result.push({ week:w, ...(weekMap[w]||{total:0,types:{}}) })
  }
  return result
}

function getPBs(sessions) {
  const pbs = {}
  sessions.forEach(day => {
    day.sessions.forEach(s => {
      if(!s.pieceType) return
      const pt = s.pieceType
      if(pt==='30 min'||pt==='60 min') {
        const dist = parseFloat(s.distance)||0
        if(!pbs[pt]||dist>pbs[pt].distance) {
          pbs[pt]={ distance:dist, date:day.date, splitSecs:null }
        }
      } else {
        const ss = parseSplit(s.split)||s.splitSecs
        if(!ss) return
        if(!pbs[pt]||ss<pbs[pt].splitSecs) {
          pbs[pt]={ splitSecs:ss, date:day.date, distance:null, prev: pbs[pt]||null }
        }
      }
    })
  })
  return pbs
}

function getYTDDistance(sessions) {
  const yr = today().slice(0,4)
  const ytdDays = sessions.filter(d=>d.date.startsWith(yr))
  const actual = ytdDays.reduce((sum,d) =>
    sum+d.sessions.reduce((s2,s) => (s.type==='S&C'||s.type==='Rest'||ERG_TYPES.includes(s.type))?s2:s2+(parseFloat(s.distance)||0), 0)
  , 0)
  const weighted = ytdDays.reduce((sum,d) =>
    sum+d.sessions.reduce((s2,s) => {
      if(s.type==='Rest') return s2
      if(s.type==='S&C') return s2+10
      return s2+(parseFloat(s.distance)||0)
    }, 0)
  , 0)
  return { actual, weighted }
}

function getThisWeekSessions(sessions) {
  const w = weekStart(today())
  const week = sessions.filter(d=>weekStart(d.date)===w)
  const distWater = week.reduce((s,d)=>s+d.sessions.reduce((s2,s3)=>(s3.type==='S&C'||s3.type==='Rest'||ERG_TYPES.includes(s3.type))?s2:s2+(parseFloat(s3.distance)||0), 0), 0)
  const distErg = week.reduce((s,d)=>s+d.sessions.reduce((s2,s3)=>ERG_TYPES.includes(s3.type)?s2+(parseFloat(s3.distance)||0):s2, 0), 0)
  const distWeighted = week.reduce((s,d)=>s+d.sessions.reduce((s2,s3)=>{
    if(s3.type==='Rest') return s2
    if(s3.type==='S&C') return s2+10
    return s2+(parseFloat(s3.distance)||0)
  }, 0), 0)
  return {
    count: week.reduce((s,d)=>s+d.sessions.filter(s2=>s2.type!=='Rest').length, 0),
    distWater,
    distErg,
    distWeighted
  }
}

function getNextRace(races) {
  const t = today()
  const upcoming = races.filter(r=>r.date>=t).sort((a,b)=>a.date<b.date?-1:1)
  if(!upcoming.length) return null
  return { ...upcoming[0], daysLeft: dateDiff(t, upcoming[0].date) }
}

function getRecentPBs(sessions) {
  const pbs = getPBs(sessions)
  const recent = []
  const cutoff = dateAdd(today(),-14)
  sessions.filter(d=>d.date>=cutoff).forEach(day => {
    day.sessions.forEach(s => {
      if(!s.pieceType) return
      const pb = pbs[s.pieceType]
      if(!pb) return
      if(pb.date===day.date) {
        recent.push({ type:s.pieceType, date:day.date, splitSecs:pb.splitSecs, distance:pb.distance })
      }
    })
  })
  return recent
}

function getSleepStats(sessions) {
  const days = sessions.filter(d=>d.sleep&&d.sleep.hours).sort((a,b)=>a.date<b.date?-1:1)
  if(!days.length) return { avgHrs:null, debtHrs:null, consistency:null, avgQuality:null }
  const last7 = days.filter(d=>d.date>=dateAdd(today(),-6))
  const debt = last7.reduce((s,d)=>s+Math.max(0,8-parseFloat(d.sleep.hours)), 0)
  const avgHrs = days.reduce((s,d)=>s+parseFloat(d.sleep.hours), 0)/days.length
  const last14 = days.filter(d=>d.date>=dateAdd(today(),-13)&&d.sleep.bedtime)
  let consistency = null
  if(last14.length>=3) {
    const mins = last14.map(d => {
      const [h,m] = d.sleep.bedtime.split(':').map(Number)
      return h<12 ? h*60+m+1440 : h*60+m
    })
    const mean = mins.reduce((s,v)=>s+v,0)/mins.length
    const sd = Math.sqrt(mins.reduce((s,v)=>s+(v-mean)**2,0)/mins.length)
    consistency = Math.max(1, Math.round(10 - sd/6))
  }
  const withQuality = days.filter(d=>d.sleep.quality)
  const avgQuality = withQuality.length ? withQuality.reduce((s,d)=>s+parseFloat(d.sleep.quality),0)/withQuality.length : null
  return { avgHrs, debtHrs:debt, consistency, avgQuality }
}

function getSleepNightlyData(sessions, n=28) {
  const result = []
  for(let i=n-1; i>=0; i--) {
    const date = dateAdd(today(),-i)
    const day = sessions.find(d=>d.date===date)
    const hrs = day&&day.sleep&&day.sleep.hours ? parseFloat(day.sleep.hours) : null
    const quality = day&&day.sleep&&day.sleep.quality ? parseFloat(day.sleep.quality) : null
    result.push({ date, hrs, quality })
  }
  return result
}

function sleepHrsScore(hrs) {
  if(!hrs) return 5
  const h = parseFloat(hrs)
  if(h>=8&&h<=9) return 10
  if(h>=7&&h<8) return 7 + (h-7)*3
  if(h>9&&h<=10) return 10 - (h-9)*3
  if(h>=6&&h<7) return 4 + (h-6)*3
  if(h>10) return Math.max(4, 10-(h-10)*3)
  return Math.max(0, h/6*4)
}

function calcReadinessScore(ci, tsb) {
  const tsbScore = Math.min(100, Math.max(0, ((tsb+30)/50)*100))
  const sleepHrs = sleepHrsScore(ci.sleepHrs) * 10
  const sleepQual = ci.sleepQuality ? ((parseFloat(ci.sleepQuality)/10)*100) : 50
  const wellness = (
    ((11 - (parseFloat(ci.fatigue)||5)) / 10 * 100) +
    ((parseFloat(ci.mood)||5) / 10 * 100) +
    ((11 - (parseFloat(ci.soreness)||5)) / 10 * 100) +
    ((11 - (parseFloat(ci.stress)||5)) / 10 * 100)
  ) / 4
  return Math.round(tsbScore*0.30 + sleepHrs*0.25 + sleepQual*0.20 + wellness*0.25)
}

function getTrafficLight(score) {
  if(score>=75) return 'green'
  if(score>=50) return 'amber'
  return 'red'
}

function getReadinessTrendData(sessions, checkins, n=28) {
  const fitness = buildFitnessData(sessions, n+10)
  const result = []
  for(let i=n-1; i>=0; i--) {
    const date = dateAdd(today(),-i)
    const ci = checkins.find(c=>c.date===date)
    const fit = fitness.find(f=>f.date===date)
    const tsb = fit ? fit.tsb : 0
    if(ci) {
      const prevDayDate = dateAdd(date,-1)
      const prevDay = sessions.find(d=>d.date===prevDayDate)
      const sleepHrs = prevDay&&prevDay.sleep ? prevDay.sleep.hours : null
      const sleepQuality = prevDay&&prevDay.sleep ? prevDay.sleep.quality : null
      const score = calcReadinessScore({ fatigue:ci.fatigue, mood:ci.mood, soreness:ci.soreness, stress:ci.stress, sleepHrs, sleepQuality }, tsb)
      result.push({ date, score, light: getTrafficLight(score) })
    } else {
      result.push({ date, score:null, light:null })
    }
  }
  return result
}

function getWeeklySummary(sessions, checkins) {
  const trendData = getReadinessTrendData(sessions, checkins, 7)
  const withScores = trendData.filter(d=>d.score!==null)
  if(!withScores.length) return null
  const avg = Math.round(withScores.reduce((s,d)=>s+d.score,0)/withScores.length)
  const light = getTrafficLight(avg)
  const fitness = buildFitnessData(sessions, 7)
  const todayFit = fitness[fitness.length-1]||{ctl:0,atl:0,tsb:0}
  let recommendation = ''
  if(light==='green') recommendation = 'Conditions look good — train hard, push quality sessions.'
  else if(light==='amber') recommendation = 'Mixed signals — keep intensity moderate and monitor recovery.'
  else recommendation = 'Signs of fatigue — prioritise sleep and consider a recovery day.'
  return { avg, light, recommendation, tsb: todayFit.tsb, ctl: todayFit.ctl }
}

// ═══════════════════════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════════════════════
const charts = {}
function mkChart(id, cfg) {
  if(charts[id]){ charts[id].destroy(); delete charts[id] }
  const el = document.getElementById(id)
  if(!el) return null
  charts[id] = new Chart(el, cfg)
  return charts[id]
}

Chart.defaults.color = '#8C7660'
Chart.defaults.borderColor = '#DDD4C4'
Chart.defaults.font.family = "'IBM Plex Mono', monospace"
Chart.defaults.font.size = 11

function renderFitnessChart(sessions) {
  const data = buildFitnessData(sessions, 90)
  mkChart('chart-fitness', {
    type:'line',
    data:{
      labels: data.map(d=>formatDateShort(d.date)),
      datasets:[
        { label:'CTL (Fitness)',data:data.map(d=>d.ctl),borderColor:'#C96340',backgroundColor:'rgba(201,99,64,0.07)',fill:true,tension:0.3,pointRadius:0,borderWidth:2 },
        { label:'ATL (Fatigue)',data:data.map(d=>d.atl),borderColor:'#A86020',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5 },
        { label:'TSB (Form)',data:data.map(d=>d.tsb),borderColor:'#2E7A4A',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5 }
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:true,aspectRatio:2,
      plugins:{ legend:{display:false}, tooltip:{mode:'index',intersect:false,backgroundColor:'#FDFAF6',borderColor:'#DDD4C4',titleColor:'#2C1F14',bodyColor:'#8C7660',borderWidth:1,padding:10} },
      scales:{
        x:{ grid:{color:'rgba(180,160,140,0.2)'}, ticks:{maxTicksLimit:10,maxRotation:0} },
        y:{ grid:{color:'rgba(180,160,140,0.2)'} }
      },
      interaction:{ mode:'nearest',axis:'x',intersect:false }
    }
  })
}

function renderWeeklyChart(sessions, checkins) {
  const data = getWeeklyData(sessions, 12)
  const types = ['Race','Pieces on Water','Water Session','Erg Intervals','Erg Threshold','Erg UT2','S&C']
  const readinessByWeek = data.map(d => {
    const weekDays = []
    for(let i=0;i<7;i++) {
      const date = dateAdd(d.week,i)
      const ci = checkins.find(c=>c.date===date)
      if(ci) {
        const day = sessions.find(s=>s.date===date)
        const fit = buildFitnessData(sessions, 14).find(f=>f.date===date)
        const tsb = fit?fit.tsb:0
        const score = calcReadinessScore({ fatigue:ci.fatigue,mood:ci.mood,soreness:ci.soreness,stress:ci.stress, sleepHrs:day&&day.sleep?day.sleep.hours:null, sleepQuality:day&&day.sleep?day.sleep.quality:null }, tsb)
        weekDays.push(score)
      }
    }
    return weekDays.length ? Math.round(weekDays.reduce((s,v)=>s+v,0)/weekDays.length) : null
  })

  mkChart('chart-weekly', {
    type:'bar',
    data:{
      labels: data.map(d=>formatDateShort(d.week)),
      datasets: [
        ...types.map(t=>({
          label:t,
          data: data.map(d=>(d.types&&d.types[t])||0),
          backgroundColor: TYPE_COLOR[t]+'99',
          borderColor: TYPE_COLOR[t],
          borderWidth:1,
          borderRadius:2,
          stack:'dist',
          yAxisID:'y'
        })),
        {
          label:'Readiness',
          type:'line',
          data: readinessByWeek,
          borderColor:'#C96340',
          backgroundColor:'transparent',
          pointBackgroundColor: readinessByWeek.map(v=>v===null?'transparent':v>=75?'#2E7A4A':v>=50?'#A86020':'#B83232'),
          pointRadius:5,
          pointBorderColor:'#FDFAF6',
          pointBorderWidth:1.5,
          borderWidth:2,
          tension:0.3,
          spanGaps:true,
          yAxisID:'y2',
          stack:undefined
        }
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:true,aspectRatio:2,
      plugins:{ legend:{display:false}, tooltip:{mode:'index',intersect:false,backgroundColor:'#FDFAF6',borderColor:'#DDD4C4',titleColor:'#2C1F14',bodyColor:'#8C7660',borderWidth:1} },
      scales:{
        x:{ stacked:true,grid:{display:false},ticks:{maxRotation:0} },
        y:{ stacked:true,grid:{color:'rgba(180,160,140,0.2)'},title:{display:true,text:'km',color:'#8C7660'} },
        y2:{ position:'right',min:0,max:100,grid:{display:false},title:{display:true,text:'Readiness',color:'#C96340'},ticks:{color:'#C96340',callback(v){return v+'%'}} }
      }
    }
  })
}

function renderReadinessTrendChart(canvasId, sessions, checkins) {
  const data = getReadinessTrendData(sessions, checkins, 28)
  mkChart(canvasId, {
    type:'line',
    data:{
      labels: data.map(d=>formatDateShort(d.date)),
      datasets:[{
        label:'Readiness',
        data: data.map(d=>d.score),
        borderColor:'rgba(201,99,64,0.5)',
        backgroundColor:'transparent',
        pointBackgroundColor: data.map(d=>d.light==='green'?'#2E7A4A':d.light==='amber'?'#A86020':d.light==='red'?'#B83232':'transparent'),
        pointRadius: data.map(d=>d.score!==null?5:0),
        pointBorderColor:'#FDFAF6',
        pointBorderWidth:1.5,
        borderWidth:1.5,
        tension:0.3,
        spanGaps:true
      }]
    },
    options:{
      responsive:true,maintainAspectRatio:true,aspectRatio:2,
      plugins:{
        legend:{display:false},
        tooltip:{backgroundColor:'#FDFAF6',borderColor:'#DDD4C4',titleColor:'#2C1F14',bodyColor:'#8C7660',borderWidth:1,callbacks:{label(ctx){return ctx.raw!==null?' Readiness: '+ctx.raw+'/100':' No check-in'}}}
      },
      scales:{
        x:{ grid:{color:'rgba(180,160,140,0.2)'},ticks:{maxTicksLimit:8,maxRotation:0} },
        y:{ min:0,max:100,grid:{color:'rgba(180,160,140,0.2)'},ticks:{callback(v){return v+'%'}} }
      }
    }
  })
}

function renderErgProgressChart(canvasId, pieceType, sessions) {
  const pts = []
  sessions.forEach(day => {
    day.sessions.forEach(s => {
      if(s.pieceType===pieceType&&s.split) {
        const ss = parseSplit(s.split)||s.splitSecs
        if(ss) pts.push({ x:day.date, y:ss })
      }
    })
  })
  pts.sort((a,b)=>a.x<b.x?-1:1)

  mkChart(canvasId, {
    type:'line',
    data:{
      labels:pts.map(p=>formatDateShort(p.x)),
      datasets:[{ label:`${pieceType} Split`,data:pts.map(p=>p.y),borderColor:'#C96340',backgroundColor:'rgba(201,99,64,0.07)',fill:true,tension:0.2,pointRadius:4,pointBackgroundColor:'#C96340',pointBorderColor:'#FDFAF6',pointBorderWidth:1.5,borderWidth:2 }]
    },
    options:{
      responsive:true,maintainAspectRatio:true,aspectRatio:2,
      plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'#FDFAF6',borderColor:'#DDD4C4',titleColor:'#2C1F14',bodyColor:'#8C7660',borderWidth:1,callbacks:{ label(ctx){ return ' '+formatSplit(ctx.parsed.y) } } } },
      scales:{
        x:{ grid:{color:'rgba(180,160,140,0.2)'}, ticks:{maxTicksLimit:8,maxRotation:0} },
        y:{ reverse:true, grid:{color:'rgba(180,160,140,0.2)'}, ticks:{ callback(v){ return formatSplit(v) } } }
      }
    }
  })
}

function renderSleepNightlyChart(canvasId, sessions) {
  const data = getSleepNightlyData(sessions, 28)
  mkChart(canvasId, {
    type:'bar',
    data:{
      labels: data.map(d=>formatDateShort(d.date)),
      datasets:[
        {
          label:'Sleep hrs',
          data: data.map(d=>d.hrs),
          backgroundColor: data.map(d=>d.hrs===null?'transparent':d.hrs>=8?'rgba(46,122,74,0.6)':d.hrs>=7?'rgba(168,96,32,0.6)':'rgba(184,50,50,0.6)'),
          borderColor: data.map(d=>d.hrs===null?'transparent':d.hrs>=8?'#2E7A4A':d.hrs>=7?'#A86020':'#B83232'),
          borderWidth:1,
          borderRadius:2,
          yAxisID:'y'
        },
        {
          label:'Quality',
          type:'line',
          data: data.map(d=>d.quality),
          borderColor:'#6040A0',
          backgroundColor:'transparent',
          pointBackgroundColor:'#6040A0',
          pointRadius:3,
          pointBorderColor:'#FDFAF6',
          pointBorderWidth:1,
          borderWidth:1.5,
          tension:0.3,
          spanGaps:true,
          yAxisID:'y2'
        },
        {
          label:'8hr target',
          type:'line',
          data: data.map(()=>8),
          borderColor:'rgba(201,99,64,0.4)',
          borderWidth:1,
          borderDash:[4,4],
          pointRadius:0,
          yAxisID:'y'
        }
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:true,aspectRatio:2,
      plugins:{ legend:{display:false}, tooltip:{mode:'index',intersect:false,backgroundColor:'#FDFAF6',borderColor:'#DDD4C4',titleColor:'#2C1F14',bodyColor:'#8C7660',borderWidth:1} },
      scales:{
        x:{ grid:{display:false},ticks:{maxTicksLimit:8,maxRotation:0} },
        y:{ min:0,max:12,grid:{color:'rgba(180,160,140,0.2)'},ticks:{callback(v){return v+'h'}} },
        y2:{ position:'right',min:0,max:10,grid:{display:false},ticks:{color:'#6040A0',callback(v){return v}} }
      }
    }
  })
}

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
function renderReadinessRingHTML(score, light) {
  const r=46, circ=2*Math.PI*r
  const dash=(score/100)*circ
  const color=light==='green'?'#2E7A4A':light==='amber'?'#A86020':'#B83232'
  return `<div class="readiness-ring">
    <svg viewBox="0 0 100 100" style="transform:rotate(-90deg)">
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--bg2)" stroke-width="8"/>
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="8"
        stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" stroke-linecap="round"/>
    </svg>
    <div class="readiness-ring-inner">
      <div style="font-size:22px;font-weight:700;color:${color};line-height:1">${score}</div>
      <div style="font-size:9px;color:var(--text2);text-transform:uppercase;letter-spacing:1px">readiness</div>
    </div>
  </div>`
}

async function renderDashboard() {
  const page = document.getElementById('page-dashboard')
  showLoading(page)
  try {
    const [sessions, races, checkins] = await Promise.all([getAllSessions(), getRaces(), getCheckins()])
    const ytd = getYTDDistance(sessions)
    const week = getThisWeekSessions(sessions)
    const nextRace = getNextRace(races)
    const recentPBs = getRecentPBs(sessions)
    const fitness = buildFitnessData(sessions, 90)
    const todayFit = fitness[fitness.length-1]||{ctl:0,atl:0,tsb:0}
    const todayCheckin = checkins.find(c=>c.date===today())
    const summary = getWeeklySummary(sessions, checkins)
    const sleepStats = getSleepStats(sessions)
    const hasTodayCheckin = !!todayCheckin

    let todayScore = null, todayLight = null
    if(todayCheckin) {
      const prevDay = sessions.find(d=>d.date===dateAdd(today(),-1))
      todayScore = calcReadinessScore({
        fatigue:todayCheckin.fatigue, mood:todayCheckin.mood, soreness:todayCheckin.soreness, stress:todayCheckin.stress,
        sleepHrs: prevDay&&prevDay.sleep ? prevDay.sleep.hours : null,
        sleepQuality: prevDay&&prevDay.sleep ? prevDay.sleep.quality : null
      }, todayFit.tsb)
      todayLight = getTrafficLight(todayScore)
    }

    // Check for localStorage migration data
    const lsData = localStorage.getItem('rowlog_sessions')
    const migrationBanner = lsData && JSON.parse(lsData).length > 0 ? `
      <div class="migration-banner">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2E7A4A" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <div style="flex:1">
          <div style="font-size:12px;font-weight:600;color:var(--green)">Local data found</div>
          <div style="font-size:11px;color:var(--text2)">You have localStorage data from the old RowLog. Import it to your account?</div>
        </div>
        <button class="btn btn-sm" style="background:var(--green);color:#fff;border:none" onclick="migrateLocalStorageData()">Import Now</button>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.migration-banner').remove()">Dismiss</button>
      </div>
    ` : ''

    page.innerHTML = `
      ${migrationBanner}
      ${!hasTodayCheckin ? `
      <div class="checkin-banner">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        <span>No morning check-in today — log your readiness for personalised insights.</span>
        <button class="btn btn-sm" onclick="navigate('checkin')" style="margin-left:auto;background:var(--accent);color:#fff;border:none">Check in now</button>
      </div>
      ` : ''}

      <h2>Dashboard</h2>

      ${summary ? `
      <div class="summary-card traffic-${summary.light}" style="margin-bottom:16px">
        ${todayScore!==null ? renderReadinessRingHTML(todayScore, todayLight) : ''}
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin-bottom:4px">Weekly Readiness Summary</div>
          <div style="font-size:15px;color:var(--bright);font-weight:500">${summary.recommendation}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:6px">7-day avg readiness <strong>${summary.avg}/100</strong> · TSB <strong style="color:${summary.tsb>=0?'var(--green)':'var(--red)'}">${summary.tsb>0?'+':''}${summary.tsb}</strong> · CTL <strong>${summary.ctl}</strong></div>
        </div>
        <div class="summary-metric">
          <div class="traffic-light traffic-${summary.light}">${summary.light.toUpperCase()}</div>
        </div>
      </div>
      ` : ''}

      <div class="stat-bar">
        <div class="stat-item">
          <div class="stat-val">${ytd.weighted.toFixed(0)}<span style="font-size:14px;color:var(--text2)">km</span></div>
          <div class="stat-label">YTD Distance</div>
          <div class="stat-sub">${ytd.actual.toFixed(0)} km on water</div>
        </div>
        <div class="stat-item">
          <div class="stat-val">${week.count}</div>
          <div class="stat-label">Sessions This Week</div>
          <div class="stat-sub">${week.distWater.toFixed(1)} km water · ${week.distErg.toFixed(1)} km erg</div>
        </div>
        <div class="stat-item">
          <div class="stat-val ${todayFit.tsb>=0?'text-green':'text-red'}">${todayFit.tsb>0?'+':''}${todayFit.tsb}</div>
          <div class="stat-label">Form (TSB)</div>
          <div class="stat-sub" style="color:var(--text2)">CTL ${todayFit.ctl} · ATL ${todayFit.atl}</div>
        </div>
        <div class="stat-item">
          ${nextRace
            ? `<div class="stat-val text-accent">${nextRace.daysLeft}d</div>
               <div class="stat-label">Next Race</div>
               <div class="stat-sub">${nextRace.name}</div>`
            : `<div class="stat-val text-muted">—</div><div class="stat-label">Next Race</div><div class="stat-sub" style="color:var(--text3)">None scheduled</div>`
          }
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="flex-between" style="margin-bottom:10px">
            <h3 style="margin:0">Fitness / Fatigue / Form</h3>
            <div class="chart-legend">
              <div class="legend-item"><div class="legend-dot" style="background:#C96340"></div>CTL</div>
              <div class="legend-item"><div class="legend-dot" style="background:#A86020"></div>ATL</div>
              <div class="legend-item"><div class="legend-dot" style="background:#2E7A4A"></div>TSB</div>
            </div>
          </div>
          <div class="chart-wrap"><canvas id="chart-fitness"></canvas></div>
        </div>
        <div class="card">
          <div class="flex-between" style="margin-bottom:10px">
            <h3 style="margin:0">Weekly Distance + Readiness</h3>
            <div style="display:flex;gap:12px;flex-wrap:wrap">
              ${['Race','Pieces on Water','Erg Intervals','Erg UT2'].map(t=>`<div class="legend-item"><div class="legend-dot" style="background:${TYPE_COLOR[t]}"></div><span>${t}</span></div>`).join('')}
              <div class="legend-item"><div class="legend-dot" style="background:#C96340"></div>Readiness</div>
            </div>
          </div>
          <div class="chart-wrap"><canvas id="chart-weekly"></canvas></div>
        </div>
      </div>

      <div class="card mt-16">
        <h3>Readiness Trend — 28 days</h3>
        <div class="chart-wrap"><canvas id="chart-readiness-trend"></canvas></div>
      </div>

      <div class="grid grid-2 mt-16">
        <div class="card">
          <h3>Erg Progression — 2k</h3>
          <div class="chart-wrap"><canvas id="chart-erg-dash"></canvas></div>
        </div>
        <div class="card">
          <div class="flex-between" style="margin-bottom:10px">
            <h3 style="margin:0">Sleep — 28 nights</h3>
            <div style="display:flex;gap:12px">
              <div class="legend-item"><div class="legend-dot" style="background:#2E7A4A"></div>≥8h</div>
              <div class="legend-item"><div class="legend-dot" style="background:#A86020"></div>7–8h</div>
              <div class="legend-item"><div class="legend-dot" style="background:#B83232"></div>&lt;7h</div>
            </div>
          </div>
          ${sleepStats.avgHrs!==null ? `
          <div class="sleep-stat-grid" style="margin-bottom:12px">
            <div class="sleep-stat"><div class="sleep-stat-val">${sleepStats.avgHrs.toFixed(1)}h</div><div class="sleep-stat-label">Avg Sleep</div></div>
            <div class="sleep-stat"><div class="sleep-stat-val ${sleepStats.debtHrs>2?'text-red':'text-green'}">${sleepStats.debtHrs.toFixed(1)}h</div><div class="sleep-stat-label">7-day Debt</div></div>
            <div class="sleep-stat"><div class="sleep-stat-val">${sleepStats.consistency!==null?sleepStats.consistency+'/10':'—'}</div><div class="sleep-stat-label">Consistency</div></div>
            <div class="sleep-stat"><div class="sleep-stat-val">${sleepStats.avgQuality!==null?sleepStats.avgQuality.toFixed(1)+'/10':'—'}</div><div class="sleep-stat-label">Avg Quality</div></div>
          </div>
          ` : '<p style="color:var(--text3);font-size:12px;margin-bottom:12px">Log sleep in the Training Log to see sleep data.</p>'}
          <div class="chart-wrap"><canvas id="chart-sleep-nightly"></canvas></div>
        </div>
      </div>

      ${recentPBs.length ? `
      <div class="card mt-16">
        <h3>Recent PBs <span class="badge">New</span></h3>
        <div class="tag-row">
          ${recentPBs.map(pb=>`
            <div style="background:rgba(168,96,32,0.06);border:1px solid rgba(168,96,32,0.22);border-radius:7px;padding:12px 16px;display:inline-flex;flex-direction:column;gap:2px">
              <div style="font-size:9.5px;color:var(--amber);text-transform:uppercase;letter-spacing:1px;font-weight:500">${pb.type}</div>
              <div style="font-size:18px;font-weight:600;color:var(--bright)">${pb.splitSecs?formatSplit(pb.splitSecs):pb.distance+'km'}</div>
              <div style="font-size:10px;color:var(--text2)">${formatDate(pb.date)}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}
    `
    hideLoading(page)
    setTimeout(() => {
      renderFitnessChart(sessions)
      renderWeeklyChart(sessions, checkins)
      renderReadinessTrendChart('chart-readiness-trend', sessions, checkins)
      renderErgProgressChart('chart-erg-dash', '2k', sessions)
      renderSleepNightlyChart('chart-sleep-nightly', sessions)
    }, 0)
  } catch(err) {
    hideLoading(page)
    showToast('Error loading dashboard: ' + err.message, 'error')
  }
}

// ═══════════════════════════════════════════════════════
// LOG PAGE
// ═══════════════════════════════════════════════════════
let logDate = today()
let logSessions = [newSession()]

function newSession() {
  return { type:'Erg UT2', pieceType:'', distance:'', split:'', rate:'', rpe:'', notes:'', exercises:[] }
}

async function renderLog(dateParam) {
  if(dateParam) logDate = dateParam
  const page = document.getElementById('page-log')
  const existing = await getDay(logDate)
  if(existing) {
    logSessions = existing.sessions.map(s=>({...s, exercises:s.exercises||[]}))
  } else {
    logSessions = [newSession()]
  }

  page.innerHTML = `
    <div class="page-header">
      <h2>Training Log</h2>
      <div class="flex-center gap-8">
        <button class="btn btn-ghost btn-sm" onclick="window._navigate_log_prev()">← Prev</button>
        <input type="date" value="${logDate}" onchange="window._navigate_log_date(this.value)" style="width:150px">
        <button class="btn btn-ghost btn-sm" onclick="window._navigate_log_next()">Next →</button>
      </div>
    </div>
    <div id="log-sessions"></div>
    <button class="btn btn-ghost btn-sm" onclick="addSession()" style="margin-bottom:20px" ${logSessions.length>=3?'disabled':''}>
      + Add Session ${logSessions.length>=3?'(max 3)':''}
    </button>
    <div style="margin-top:4px;display:flex;gap:10px;align-items:center">
      <button class="btn btn-primary" onclick="saveLog()">Save Log</button>
      <span id="log-saved" style="color:var(--green);font-size:12px;display:none">✓ Saved</span>
    </div>
  `

  window._navigate_log_prev = () => { logDate=dateAdd(logDate,-1); renderLog() }
  window._navigate_log_next = () => { logDate=dateAdd(logDate,1); renderLog() }
  window._navigate_log_date = (v) => { logDate=v; renderLog() }

  renderLogSessions()
}

function renderLogSessions() {
  window.logSessions = logSessions  // expose to global scope for inline onchange handlers
  const wrap = document.getElementById('log-sessions')
  if(!wrap) return
  wrap.innerHTML = logSessions.map((s,i)=>renderSessionBlock(s,i)).join('')
}

function renderSessionBlock(s, i) {
  const isSC = s.type==='S&C'
  return `
    <div class="session-block" id="session-${i}">
      <div class="session-block-header">
        <span class="session-num">Session ${i+1}</span>
        ${logSessions.length>1?`<button class="btn-icon" onclick="removeSession(${i})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`:''}
      </div>
      <div class="form-row form-row-2" style="margin-bottom:10px">
        <div class="form-group">
          <label>Session Type</label>
          <select onchange="updateSessionType(${i},this.value)">
            ${SESSION_TYPES.map(t=>`<option value="${t}" ${s.type===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        ${(ERG_TYPES.includes(s.type) || s.type === 'Pieces on Water')?`
        <div class="form-group">
          <label>Piece Type</label>
          <select onchange="logSessions[${i}].pieceType=this.value">
            <option value="">— Select —</option>
            ${PIECE_TYPES.map(p=>`<option value="${p}" ${s.pieceType===p?'selected':''}>${p}</option>`).join('')}
          </select>
        </div>` : '<div></div>'}
      </div>
      ${isSC ? renderSCBlock(s,i) : renderRowingBlock(s,i)}
      <div class="form-group" style="margin-top:10px">
        <label>Notes</label>
        <textarea onchange="logSessions[${i}].notes=this.value" rows="2">${s.notes||''}</textarea>
      </div>
    </div>
  `
}

function renderRowingBlock(s, i) {
  return `
    <div class="form-row form-row-4">
      <div class="form-group">
        <label>Distance (km)</label>
        <input type="number" value="${s.distance||''}" step="0.1" min="0" placeholder="6.0" onchange="logSessions[${i}].distance=this.value">
      </div>
      <div class="form-group">
        <label>Split /500m</label>
        <input type="text" value="${s.split||''}" placeholder="1:52.3" onchange="logSessions[${i}].split=this.value;logSessions[${i}].splitSecs=parseSplit(this.value)">
      </div>
      <div class="form-group">
        <label>Stroke Rate</label>
        <input type="number" value="${s.rate||''}" min="10" max="50" placeholder="20" onchange="logSessions[${i}].rate=this.value">
      </div>
      <div class="form-group">
        <label>RPE (1–10)</label>
        <input type="number" value="${s.rpe||''}" min="1" max="10" placeholder="7" onchange="logSessions[${i}].rpe=this.value">
      </div>
    </div>
  `
}

function renderSCBlock(s, i) {
  const exs = s.exercises||[]
  return `
    <div>
      <label style="display:block;font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">Exercises</label>
      <div id="sc-exercises-${i}">
        ${exs.map((ex,j)=>`
          <div class="exercise-row">
            <input type="text" value="${ex.name||''}" placeholder="Exercise name" onchange="logSessions[${i}].exercises[${j}].name=this.value">
            <input type="text" value="${ex.sets||''}" placeholder="Sets" onchange="logSessions[${i}].exercises[${j}].sets=this.value">
            <input type="text" value="${ex.reps||''}" placeholder="Reps" onchange="logSessions[${i}].exercises[${j}].reps=this.value">
            <input type="text" value="${ex.weight||''}" placeholder="kg" onchange="logSessions[${i}].exercises[${j}].weight=this.value">
            <button class="btn-icon" onclick="removeExercise(${i},${j})"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
        `).join('')}
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:8px">
        <button class="btn btn-ghost btn-sm" onclick="addExercise(${i})">+ Exercise</button>
        <div class="form-group" style="margin:0;display:flex;align-items:center;gap:8px">
          <label style="margin:0;white-space:nowrap">RPE</label>
          <input type="number" value="${s.rpe||''}" min="1" max="10" style="width:70px" onchange="logSessions[${i}].rpe=this.value">
        </div>
      </div>
    </div>
  `
}

window.addSession = function() { if(logSessions.length<3){ logSessions.push(newSession()); renderLogSessions() } }
window.removeSession = function(i) { logSessions.splice(i,1); renderLogSessions() }

window.updateSessionType = function(i, type) {
  logSessions[i].type = type
  if(type==='S&C'){ logSessions[i].exercises=[]; logSessions[i].pieceType='' }
  renderLogSessions()
}

window.addExercise = function(i) { logSessions[i].exercises.push({name:'',sets:'',reps:'',weight:''}); renderLogSessions() }
window.removeExercise = function(i, j) { logSessions[i].exercises.splice(j,1); renderLogSessions() }

window.parseSplit = parseSplit  // expose for inline onchange handlers

window.saveLog = async function() {
  const existing = await getDay(logDate)
  const day = { date:logDate, sessions:logSessions.map(s=>({...s,splitSecs:parseSplit(s.split)||s.splitSecs})), sleep: existing?.sleep||{} }
  const ok = await upsertDay(day)
  if(ok) {
    const msg = document.getElementById('log-saved')
    if(msg){ msg.style.display='inline'; setTimeout(()=>msg.style.display='none',2000) }
    showToast('Session saved', 'success')
    // Check for new PBs and write feed events
    const sessions = await getAllSessions()
    const pbs = getPBs(sessions)
    day.sessions.forEach(s => {
      if(s.pieceType && pbs[s.pieceType]?.date === day.date) {
        import('./social.js').then(m => m.writeFeedEvent('pb', { pieceType:s.pieceType, split:s.split, splitSecs:pbs[s.pieceType].splitSecs }))
      }
    })
  }
}

// ═══════════════════════════════════════════════════════
// ERGS PAGE
// ═══════════════════════════════════════════════════════
let ergFilter = 'All'

async function renderErgs() {
  const page = document.getElementById('page-ergs')
  showLoading(page)
  try {
    const sessions = await getAllSessions()
    const pbs = getPBs(sessions)
    const allErgs = []
    sessions.forEach(day => {
      day.sessions.forEach(s => {
        if(ERG_TYPES.includes(s.type)||s.pieceType) {
          allErgs.push({...s, date:day.date, splitSecs:parseSplit(s.split)||s.splitSecs})
        }
      })
    })
    allErgs.sort((a,b)=>a.date<b.date?1:-1)
    const filtered = ergFilter==='All'?allErgs:allErgs.filter(s=>s.pieceType===ergFilter)
    const hasPBs = Object.keys(pbs).length>0

    page.innerHTML = `
      <h2>Ergs</h2>
      <div class="card" style="margin-bottom:16px">
        <h3>PB Board</h3>
        ${hasPBs ? `
        <div class="pb-grid">
          ${PIECE_TYPES.slice(0,6).map(pt => {
            const pb = pbs[pt]
            return `
              <div class="pb-card ${pb?'has-pb':''}">
                <div class="pb-type">${pt}</div>
                ${pb ? `
                  <div class="pb-val">${pb.splitSecs?formatSplit(pb.splitSecs):pb.distance+'km'}</div>
                  <div class="pb-date">${formatDate(pb.date)}</div>
                  ${pb.prev?`<div class="pb-prev">▲ from ${pb.prev.splitSecs?formatSplit(pb.prev.splitSecs):pb.prev.distance+'km'}</div>`:''}
                ` : `<div class="pb-val text-muted">—</div><div class="pb-date" style="color:var(--text3)">No data</div>`}
              </div>
            `
          }).join('')}
        </div>
        ` : `<div class="empty-state" style="padding:20px"><p>Log erg sessions with piece types to see PBs</p></div>`}
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="flex-between" style="margin-bottom:12px">
          <h3 style="margin:0">Progression</h3>
          <div class="filter-row" style="margin:0">
            ${['2k','5k','1k','500m'].map(pt=>`<button class="filter-btn ${ergFilter===pt?'active':''}" onclick="window._ergFilterSet('${pt}')">${pt}</button>`).join('')}
          </div>
        </div>
        <div class="chart-wrap"><canvas id="chart-erg-prog"></canvas></div>
      </div>

      <div class="card">
        <div class="flex-between" style="margin-bottom:12px">
          <h3 style="margin:0">All Erg Sessions</h3>
          <div class="filter-row" style="margin:0">
            <button class="filter-btn ${ergFilter==='All'?'active':''}" onclick="window._ergFilterSet('All')">All</button>
            ${PIECE_TYPES.map(pt=>`<button class="filter-btn ${ergFilter===pt?'active':''}" onclick="window._ergFilterSet('${pt}')">${pt}</button>`).join('')}
          </div>
        </div>
        ${filtered.length ? `
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Piece</th><th>Distance</th><th>Split</th><th>Rate</th><th>RPE</th><th>Notes</th></tr></thead>
          <tbody>
            ${filtered.map(s=>`
              <tr>
                <td>${formatDate(s.date)}</td>
                <td>${chip(s.type)}</td>
                <td>${s.pieceType?`<span class="chip chip-other">${s.pieceType}</span>`:'—'}</td>
                <td>${s.distance?s.distance+'km':'—'}</td>
                <td style="color:var(--accent);font-weight:500">${s.split||'—'}</td>
                <td>${s.rate||'—'}</td>
                <td>${s.rpe||'—'}</td>
                <td style="color:var(--text2);max-width:200px;overflow:hidden;text-overflow:ellipsis">${s.notes||'—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ` : `<div class="empty-state"><p>No erg sessions logged yet</p></div>`}
      </div>
    `
    hideLoading(page)

    window._ergFilterSet = (pt) => { ergFilter=pt; renderErgs() }
    setTimeout(() => {
      const pt = ergFilter==='All'?'2k':ergFilter
      renderErgProgressChart('chart-erg-prog', pt, sessions)
    }, 0)
  } catch(err) {
    hideLoading(page)
    showToast('Error loading ergs: ' + err.message, 'error')
  }
}

// ═══════════════════════════════════════════════════════
// CALENDAR PAGE
// ═══════════════════════════════════════════════════════
let calYear = new Date().getFullYear()
let calMonth = new Date().getMonth()

async function renderCalendar() {
  const page = document.getElementById('page-calendar')
  showLoading(page)
  try {
    const sessions = await getAllSessions()
    const sessionMap = {}
    sessions.forEach(d => { sessionMap[d.date] = d })

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
    const daysInMonth = new Date(calYear,calMonth+1,0).getDate()
    const firstDow = new Date(calYear,calMonth,1).getDay()
    const startOffset = (firstDow+6)%7
    const t = today()

    let cells = ''
    for(let i=0;i<startOffset;i++) cells+=`<div class="cal-day empty"></div>`

    for(let d=1;d<=daysInMonth;d++) {
      const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
      const day = sessionMap[dateStr]
      const tss = day?dayTSS(day):0
      const isToday = dateStr===t

      let bg = 'var(--bg4)'
      if(tss>0) {
        const intensity = Math.min(tss/60,1)
        bg = `rgba(201,99,64,${0.08+intensity*0.55})`
      }

      const types = day ? [...new Set(day.sessions.map(s=>s.type))] : []
      const dots = types.slice(0,4).map(type=>`<div class="cal-dot" style="background:${TYPE_COLOR[type]||'#4f6480'}"></div>`).join('')

      cells += `
        <div class="cal-day" style="background:${bg}" onclick="openDayLog('${dateStr}')" title="${dateStr}${tss>0?' · TSS '+tss.toFixed(0):''}">
          <div class="cal-day-num" style="color:${isToday?'var(--accent)':tss>40?'var(--bright)':'var(--text)'}">${d}</div>
          ${dots?`<div class="cal-day-dots">${dots}</div>`:''}
        </div>
      `
    }

    page.innerHTML = `
      <div class="page-header"><h2>Calendar</h2></div>
      <div class="card">
        <div class="cal-header">
          <div class="cal-month-nav">
            <button class="btn btn-ghost btn-sm" onclick="calMonth--;if(calMonth<0){calMonth=11;calYear--;}renderCalendar()">←</button>
            <span style="font-family:var(--head);font-size:16px;font-weight:600;color:var(--bright);min-width:160px;text-align:center">${monthNames[calMonth]} ${calYear}</span>
            <button class="btn btn-ghost btn-sm" onclick="calMonth++;if(calMonth>11){calMonth=0;calYear++;}renderCalendar()">→</button>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="calYear=new Date().getFullYear();calMonth=new Date().getMonth();renderCalendar()">Today</button>
        </div>
        <div class="cal-grid">
          ${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div class="cal-day-label">${d}</div>`).join('')}
          ${cells}
        </div>
        <div style="margin-top:16px;display:flex;gap:16px;flex-wrap:wrap;align-items:center">
          <span style="font-size:11px;color:var(--text2)">Training load:</span>
          ${[0.1,0.25,0.42,0.60,0.80].map(v=>`<div style="display:inline-flex;align-items:center;gap:4px"><div style="width:14px;height:14px;border-radius:3px;background:rgba(201,99,64,${0.08+v*0.55})"></div></div>`).join('')}
          <span style="font-size:10px;color:var(--text2)">Low → High</span>
        </div>
      </div>
    `
    hideLoading(page)
  } catch(err) {
    hideLoading(page)
    showToast('Error loading calendar: ' + err.message, 'error')
  }
}

window.openDayLog = function(date) {
  navigate('log')
  setTimeout(()=>renderLog(date), 50)
}

// ═══════════════════════════════════════════════════════
// RACES PAGE
// ═══════════════════════════════════════════════════════
let showAddRace = false

async function renderRaces() {
  const page = document.getElementById('page-races')
  showLoading(page)
  try {
    const racesData = await getRaces()
    const sorted = [...racesData].sort((a,b)=>a.date<b.date?1:-1)
    const t = today()
    const upcoming = sorted.filter(r=>r.date>=t).reverse()
    const past = sorted.filter(r=>r.date<t)

    page.innerHTML = `
      <div class="page-header">
        <h2>Races</h2>
        <button class="btn btn-primary" onclick="toggleAddRace()">+ Add Race</button>
      </div>

      <div id="add-race-form" style="display:${showAddRace?'block':'none'}">
        <div class="inline-form">
          <h4>Add Race</h4>
          <div class="form-row form-row-3">
            <div class="form-group"><label>Regatta Name</label><input id="r-name" placeholder="Henley Royal Regatta"></div>
            <div class="form-group"><label>Date</label><input type="date" id="r-date" value="${t}"></div>
            <div class="form-group"><label>Event</label><input id="r-event" placeholder="M4x Final"></div>
          </div>
          <div class="form-row form-row-3">
            <div class="form-group"><label>Category</label><input id="r-cat" placeholder="Senior A"></div>
            <div class="form-group"><label>Notes</label><input id="r-notes" placeholder="Optional"></div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="addRace()">Save Race</button>
            <button class="btn btn-ghost btn-sm" onclick="showAddRace=false;renderRaces()">Cancel</button>
          </div>
        </div>
      </div>

      ${upcoming.length ? `
      <h3>Upcoming</h3>
      ${upcoming.map(r => {
        const days = dateDiff(t, r.date)
        return `
          <div class="race-card upcoming">
            <div class="flex-between">
              <div>
                <div style="font-family:var(--head);font-size:15px;font-weight:600;color:var(--bright)">${r.name}</div>
                <div style="font-size:12px;color:var(--text2);margin-top:2px">${formatDate(r.date)} · ${r.event||'—'} · ${r.category||'—'}</div>
                ${r.notes?`<div style="font-size:11px;color:var(--text2);margin-top:4px">${r.notes}</div>`:''}
              </div>
              <div style="text-align:right">
                <div style="font-size:24px;font-weight:600;color:var(--accent)">${days}d</div>
                <div style="font-size:10px;color:var(--text2)">until race</div>
                <button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="deleteRace('${r.id}')">Remove</button>
              </div>
            </div>
          </div>
        `
      }).join('')}
      ` : `<div class="empty-state" style="padding:30px"><p>No upcoming races. Add one above.</p></div>`}

      ${past.length ? `
      <h3 style="margin-top:20px">Results</h3>
      ${past.map(r=>`
        <div class="race-card past">
          <div class="flex-between">
            <div>
              <div style="font-family:var(--head);font-size:14px;font-weight:600;color:var(--text)">${r.name}</div>
              <div style="font-size:12px;color:var(--text2)">${formatDate(r.date)} · ${r.event||'—'}</div>
              ${r.notes?`<div style="font-size:11px;color:var(--text2);margin-top:3px">${r.notes}</div>`:''}
            </div>
            <div style="text-align:right">
              ${r.result_split?`<div style="font-size:16px;font-weight:600;color:var(--bright)">${r.result_split}</div>`:''}
              ${r.race_placing?`<div style="font-size:12px;color:var(--amber)">${r.race_placing}</div>`:''}
              <button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addResult('${r.id}')">Add Result</button>
            </div>
          </div>
        </div>
      `).join('')}
      ` : ''}
    `
    hideLoading(page)
  } catch(err) {
    hideLoading(page)
    showToast('Error loading races: ' + err.message, 'error')
  }
}

window.toggleAddRace = function() { showAddRace=!showAddRace; renderRaces() }

window.addRace = async function() {
  const race = {
    name: document.getElementById('r-name')?.value||'',
    date: document.getElementById('r-date')?.value||today(),
    event: document.getElementById('r-event')?.value||'',
    category: document.getElementById('r-cat')?.value||'',
    notes: document.getElementById('r-notes')?.value||'',
    result_split: '',
    race_placing: ''
  }
  const ok = await saveRace(race)
  if(ok) {
    showAddRace=false
    renderRaces()
    showToast('Race added', 'success')
    // Write feed event for race
    import('./social.js').then(m => m.writeFeedEvent('race', { raceName: race.name, date: race.date }))
  }
}

window.deleteRace = async function(id) {
  const ok = await deleteRaceById(id)
  if(ok) { renderRaces(); showToast('Race removed', 'info') }
}

window.addResult = async function(id) {
  const result = prompt('Enter result (e.g. 6:32.4):')
  if(result === null) return
  const placing = prompt('Enter placing (e.g. 2nd, Gold):')
  if(placing === null) return
  const races = await getRaces()
  const r = races.find(r=>r.id===id)
  if(r) {
    r.result = result || ''
    r.placing = placing || ''
    await saveRace(r)
    renderRaces()
    if(placing) import('./social.js').then(m => m.writeFeedEvent('race', { raceName: r.name, placing, date: r.date }))
  }
}

// ═══════════════════════════════════════════════════════
// RECORDS PAGE
// ═══════════════════════════════════════════════════════
async function renderRecords() {
  const page = document.getElementById('page-records')
  showLoading(page)
  try {
    const sessions = await getAllSessions()
    const pbs = getPBs(sessions)

    function getPBHistory(pieceType) {
      const pts = []
      sessions.forEach(day => {
        day.sessions.forEach(s => {
          if(s.pieceType===pieceType) {
            const ss = parseSplit(s.split)||s.splitSecs
            if(ss) pts.push({splitSecs:ss, date:day.date, distance:parseFloat(s.distance)||0})
          }
        })
      })
      if(pieceType==='30 min'||pieceType==='60 min') return pts.sort((a,b)=>b.distance-a.distance)
      return pts.sort((a,b)=>a.splitSecs-b.splitSecs)
    }

    const splitTypes = ['2k','5k','1k','500m','3x10 min']
    const distTypes = ['30 min','60 min']

    page.innerHTML = `
      <h2>Records</h2>
      <div class="card" style="margin-bottom:16px">
        <h3>Split-Based PBs</h3>
        <table>
          <thead><tr><th>Piece</th><th>Current PB</th><th>Date Set</th><th>Previous PB</th><th>Improvement</th></tr></thead>
          <tbody>
            ${splitTypes.map(pt => {
              const hist = getPBHistory(pt)
              const best = hist[0]
              const prev = hist[1]
              const improvement = best&&prev ? prev.splitSecs-best.splitSecs : null
              return `
                <tr>
                  <td><span class="chip chip-other">${pt}</span></td>
                  <td style="color:var(--bright);font-weight:600;font-size:16px">${best?formatSplit(best.splitSecs):'—'}</td>
                  <td>${best?formatDate(best.date):'—'}</td>
                  <td style="color:var(--text2)">${prev?formatSplit(prev.splitSecs):'—'}</td>
                  <td>${improvement?`<span class="text-green">▲ ${improvement.toFixed(1)}s</span>`:'—'}</td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-bottom:16px">
        <h3>Distance-Based PBs</h3>
        <table>
          <thead><tr><th>Piece</th><th>Current PB</th><th>Split Avg</th><th>Date Set</th><th>Previous PB</th></tr></thead>
          <tbody>
            ${distTypes.map(pt => {
              const hist = getPBHistory(pt)
              const best = hist[0]
              const prev = hist[1]
              return `
                <tr>
                  <td><span class="chip chip-other">${pt}</span></td>
                  <td style="color:var(--bright);font-weight:600;font-size:16px">${best?best.distance+'km':'—'}</td>
                  <td style="color:var(--accent)">${best&&best.splitSecs?formatSplit(best.splitSecs):'—'}</td>
                  <td>${best?formatDate(best.date):'—'}</td>
                  <td style="color:var(--text2)">${prev?prev.distance+'km':'—'}</td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3>Erg Progression Charts</h3>
        <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap" id="erg-prog-tabs">
          ${splitTypes.map((pt,i)=>`<button class="filter-btn ${i===0?'active':''}" onclick="showErgProgTab('${pt}',this)">${pt}</button>`).join('')}
        </div>
        <div class="chart-wrap"><canvas id="chart-records-prog"></canvas></div>
      </div>
    `
    hideLoading(page)
    setTimeout(() => renderErgProgressChart('chart-records-prog', '2k', sessions), 0)

    window.showErgProgTab = function(pt, btn) {
      document.querySelectorAll('#erg-prog-tabs .filter-btn').forEach(b=>b.classList.remove('active'))
      btn.classList.add('active')
      renderErgProgressChart('chart-records-prog', pt, sessions)
    }
  } catch(err) {
    hideLoading(page)
    showToast('Error loading records: ' + err.message, 'error')
  }
}

// ═══════════════════════════════════════════════════════
// CHECK-IN PAGE
// ═══════════════════════════════════════════════════════
let ciDate = today()

async function getCheckinHistoryHTML() {
  const checkins = await getCheckins()
  const recent = checkins.slice(0,10)
  if(!recent.length) return '<p style="color:var(--text3);font-size:12px">No check-ins yet.</p>'
  return recent.map(ci => {
    const score = ci.readiness_score || 50
    const light = ci.traffic_light || getTrafficLight(score)
    const color = light==='green'?'#2E7A4A':light==='amber'?'#A86020':'#B83232'
    return `<div class="ci-prev-card" style="border-left:3px solid ${color}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:var(--bright)">${formatDate(ci.date)}</span>
        <span class="traffic-light traffic-${light}" style="font-size:10px">${light.toUpperCase()} ${score}</span>
      </div>
      <div class="ci-breakdown-grid">
        <span style="color:var(--text2);font-size:11px">Fatigue</span><span style="font-size:11px">${ci.fatigue}/10</span><div style="background:var(--bg2);border-radius:2px;height:4px;position:relative"><div style="background:#B83232;width:${ci.fatigue*10}%;height:100%;border-radius:2px"></div></div>
        <span style="color:var(--text2);font-size:11px">Mood</span><span style="font-size:11px">${ci.mood}/10</span><div style="background:var(--bg2);border-radius:2px;height:4px;position:relative"><div style="background:#2E7A4A;width:${ci.mood*10}%;height:100%;border-radius:2px"></div></div>
        <span style="color:var(--text2);font-size:11px">Soreness</span><span style="font-size:11px">${ci.soreness}/10</span><div style="background:var(--bg2);border-radius:2px;height:4px;position:relative"><div style="background:#A86020;width:${ci.soreness*10}%;height:100%;border-radius:2px"></div></div>
        <span style="color:var(--text2);font-size:11px">Stress</span><span style="font-size:11px">${ci.stress}/10</span><div style="background:var(--bg2);border-radius:2px;height:4px;position:relative"><div style="background:#6040A0;width:${ci.stress*10}%;height:100%;border-radius:2px"></div></div>
      </div>
      ${ci.hrv?`<div style="font-size:11px;color:var(--text2);margin-top:6px">HRV: <strong>${ci.hrv} ms</strong></div>`:''}
    </div>`
  }).join('')
}

window.updateCiSleepHours = function() {
  const bed = document.getElementById('ci-bed')?.value
  const wake = document.getElementById('ci-wake')?.value
  if(bed&&wake) {
    const [bh,bm] = bed.split(':').map(Number)
    const [wh,wm] = wake.split(':').map(Number)
    let mins = (wh*60+wm)-(bh*60+bm)
    if(mins<0) mins+=1440
    const hrs = +(mins/60).toFixed(1)
    const el = document.getElementById('ci-hours')
    if(el) el.value = hrs
  }
  window.updateCheckinPreview()
}

window.updateCheckinPreview = async function() {
  const fatigue = parseInt(document.getElementById('ci-fatigue')?.value||5)
  const mood = parseInt(document.getElementById('ci-mood')?.value||5)
  const soreness = parseInt(document.getElementById('ci-soreness')?.value||5)
  const stress = parseInt(document.getElementById('ci-stress')?.value||5)
  const sessions = await getAllSessions()
  const fitness = buildFitnessData(sessions, 7)
  const todayFit = fitness[fitness.length-1]||{tsb:0}
  const sleepHrs = document.getElementById('ci-hours')?.value || null
  const sleepQuality = document.getElementById('ci-sleep-quality')?.value || null
  const score = calcReadinessScore({ fatigue, mood, soreness, stress, sleepHrs, sleepQuality }, todayFit.tsb)
  const light = getTrafficLight(score)
  const color = light==='green'?'#2E7A4A':light==='amber'?'#A86020':'#B83232'
  const r=46, circ=2*Math.PI*r
  const dash=(score/100)*circ
  const ring = document.getElementById('ci-ring')
  if(ring) ring.innerHTML = `
    <svg viewBox="0 0 100 100" style="transform:rotate(-90deg)">
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--bg2)" stroke-width="8"/>
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="8"
        stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" stroke-linecap="round"/>
    </svg>
    <div class="readiness-ring-inner">
      <div style="font-size:22px;font-weight:700;color:${color};line-height:1">${score}</div>
      <div style="font-size:9px;color:var(--text2);text-transform:uppercase;letter-spacing:1px">readiness</div>
    </div>`
  const tl = document.getElementById('ci-traffic-light')
  if(tl) { tl.className=`traffic-light traffic-${light}`; tl.textContent=light.toUpperCase() }
  ;['ci-fatigue','ci-mood','ci-soreness','ci-stress'].forEach(id => {
    const el = document.getElementById(id)
    if(el){ const disp = document.getElementById(id+'-val'); if(disp) disp.textContent = el.value }
  })
}

window.saveCheckin = async function() {
  const fatigue = parseInt(document.getElementById('ci-fatigue').value)
  const mood = parseInt(document.getElementById('ci-mood').value)
  const soreness = parseInt(document.getElementById('ci-soreness').value)
  const stress = parseInt(document.getElementById('ci-stress').value)
  const hrv = document.getElementById('ci-hrv').value
  const bed = document.getElementById('ci-bed')?.value||''
  const wake = document.getElementById('ci-wake')?.value||''
  const sleepHrs = document.getElementById('ci-hours')?.value||null
  const sleepQuality = document.getElementById('ci-sleep-quality')?.value||null

  // Sleep belongs to the previous night
  const sleepDate = dateAdd(ciDate, -1)
  const existingSleepDay = await getDay(sleepDate)
  const sleepDaySessions = existingSleepDay?.sessions || []
  await upsertDay({ date:sleepDate, sessions:sleepDaySessions, sleep:{ bedtime:bed, wakeTime:wake, hours:sleepHrs?parseFloat(sleepHrs):null, quality:sleepQuality?parseFloat(sleepQuality):null } })

  const sessions = await getAllSessions()
  const fitness = buildFitnessData(sessions, 7)
  const todayFit = fitness[fitness.length-1]||{tsb:0}
  const score = calcReadinessScore({ fatigue, mood, soreness, stress, sleepHrs, sleepQuality }, todayFit.tsb)
  const light = getTrafficLight(score)
  const ok = await upsertCheckin({ date:ciDate, fatigue, mood, soreness, stress, hrv:hrv||null, readinessScore:score, trafficLight:light })
  if(ok) { showToast('Check-in saved', 'success'); renderCheckin() }
}

async function renderCheckin() {
  const page = document.getElementById('page-checkin')
  showLoading(page)
  try {
    const existing = await getCheckin(ciDate)
    const sessions = await getAllSessions()
    const existingDay = sessions.find(d=>d.date===dateAdd(ciDate,-1))
    const existingSleep = existingDay?.sleep || {}
    const historyHTML = await getCheckinHistoryHTML()

    const sliders = [
      { id:'fatigue', label:'Fatigue', hint:'1 = fresh, 10 = exhausted', color:'#B83232' },
      { id:'mood', label:'Mood', hint:'1 = low, 10 = excellent', color:'#2E7A4A' },
      { id:'soreness', label:'Soreness', hint:'1 = none, 10 = very sore', color:'#A86020' },
      { id:'stress', label:'Life Stress', hint:'1 = calm, 10 = overwhelmed', color:'#6040A0' }
    ]

    page.innerHTML = `
      <div class="page-header">
        <h2>Morning Check-in</h2>
        <div class="flex-center gap-8">
          <button class="btn btn-ghost btn-sm" onclick="ciDate=dateAdd(ciDate,-1);renderCheckin()">← Prev</button>
          <input type="date" value="${ciDate}" onchange="ciDate=this.value;renderCheckin()" style="width:150px">
          <button class="btn btn-ghost btn-sm" onclick="ciDate=dateAdd(ciDate,1);renderCheckin()">Next →</button>
        </div>
      </div>

      <div class="grid grid-2">
        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="card">
            <h3>Last Night's Sleep</h3>
            <div class="form-row form-row-4" style="margin-top:12px">
              <div class="form-group"><label>Bedtime</label><input type="time" id="ci-bed" value="${existingSleep.bedtime||''}" oninput="updateCiSleepHours()"></div>
              <div class="form-group"><label>Wake Time</label><input type="time" id="ci-wake" value="${existingSleep.wakeTime||''}" oninput="updateCiSleepHours()"></div>
              <div class="form-group"><label>Hours</label><input type="number" id="ci-hours" value="${existingSleep.hours||''}" step="0.1" min="0" max="24" readonly style="background:var(--bg3);color:var(--text2)"></div>
              <div class="form-group"><label>Quality (1–10)</label><input type="number" id="ci-sleep-quality" value="${existingSleep.quality||''}" min="1" max="10" oninput="updateCheckinPreview()"></div>
            </div>
          </div>

          <div class="card">
            <h3>How are you feeling?</h3>
            <div style="margin-top:12px;display:flex;flex-direction:column;gap:18px">
              ${sliders.map(s=>`
              <div>
                <div style="display:flex;justify-content:space-between;margin-bottom:6px">
                  <label style="font-size:12px;font-weight:600;color:var(--bright)">${s.label}</label>
                  <span id="${'ci-'+s.id}-val" style="font-size:12px;font-weight:700;color:${s.color}">${existing?existing[s.id]:5}</span>
                </div>
                <input type="range" id="ci-${s.id}" min="1" max="10" value="${existing?existing[s.id]:5}" oninput="updateCheckinPreview()" style="width:100%">
                <div style="display:flex;justify-content:space-between;margin-top:2px">
                  <span style="font-size:10px;color:var(--text3)">1</span>
                  <span style="font-size:10px;color:var(--text3)">${s.hint}</span>
                  <span style="font-size:10px;color:var(--text3)">10</span>
                </div>
              </div>
              `).join('')}
            </div>
            <div style="margin-top:20px">
              <label style="font-size:12px;font-weight:600;color:var(--bright)">HRV <span style="color:var(--text3);font-weight:400">(optional, ms)</span></label>
              <input type="number" id="ci-hrv" value="${existing&&existing.hrv?existing.hrv:''}" min="10" max="200" placeholder="e.g. 68" oninput="updateCheckinPreview()" style="margin-top:6px;width:120px">
            </div>
            <button class="btn btn-primary" onclick="saveCheckin()" style="margin-top:20px;width:100%">
              ${existing ? 'Update Check-in' : 'Save Check-in'}
            </button>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="card" style="text-align:center">
            <h3>Readiness Score</h3>
            <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0">
              <div id="ci-ring" class="readiness-ring"></div>
              <div id="ci-traffic-light" class="traffic-light"></div>
              <div style="font-size:11px;color:var(--text2);max-width:220px;text-align:center">Score updates live as you adjust sliders. Save to record.</div>
            </div>
            <div style="text-align:left;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin-bottom:8px">Score breakdown</div>
              <div class="ci-breakdown-grid" style="row-gap:6px">
                <span style="color:var(--text2);font-size:11px">TSB (Fitness)</span><span style="font-size:11px;color:var(--text2)">30%</span><div></div>
                <span style="color:var(--text2);font-size:11px">Sleep Hours</span><span style="font-size:11px;color:var(--text2)">25%</span><div></div>
                <span style="color:var(--text2);font-size:11px">Sleep Quality</span><span style="font-size:11px;color:var(--text2)">20%</span><div></div>
                <span style="color:var(--text2);font-size:11px">Wellness</span><span style="font-size:11px;color:var(--text2)">25%</span><div></div>
              </div>
            </div>
          </div>
          <div class="card">
            <h3>Recent Check-ins</h3>
            <div id="ci-history">${historyHTML}</div>
          </div>
        </div>
      </div>
    `

    // Expose functions needed by inline onchange handlers
    window.dateAdd = dateAdd
    window.renderCheckin = renderCheckin

    hideLoading(page)
    setTimeout(window.updateCheckinPreview, 0)
  } catch(err) {
    hideLoading(page)
    showToast('Error loading check-in: ' + err.message, 'error')
  }
}

// ═══════════════════════════════════════════════════════
// GUIDE PAGE (static, no data needed)
// ═══════════════════════════════════════════════════════
function renderGuide() {
  const page = document.getElementById('page-guide')
  page.innerHTML = `
    <h2>Guide</h2>
    <p class="guide-lead">RowLog is a rowing training logger backed by Supabase. Your data syncs across devices. Here's how to get the most out of it.</p>

    <div class="guide-section">
      <h3>Getting Started</h3>
      <div class="guide-step"><div class="guide-step-num">1</div><div class="guide-step-body"><strong>Log your first session</strong><span>Go to <b>Log</b>, pick today's date, select a session type, fill in distance, split, stroke rate and RPE, then hit Save.</span></div></div>
      <div class="guide-step"><div class="guide-step-num">2</div><div class="guide-step-body"><strong>Add your races</strong><span>Go to <b>Races</b> and add upcoming regattas. The countdown will appear on the Dashboard stat bar.</span></div></div>
      <div class="guide-step"><div class="guide-step-num">3</div><div class="guide-step-body"><strong>Keep logging — the charts come alive</strong><span>The fitness curve, weekly distance chart and erg progression all need a few weeks of data before they become meaningful.</span></div></div>
      <div class="guide-step"><div class="guide-step-num">4</div><div class="guide-step-body"><strong>Tag erg sessions with a piece type</strong><span>When logging an Erg session, select a Piece Type (2k, 5k, etc.) and enter your split. This feeds the PB board and progression charts.</span></div></div>
    </div>

    <div class="guide-divider"></div>

    <div class="guide-section">
      <h3>The Fitness Curve — CTL, ATL & TSB</h3>
      <div class="guide-grid-3" style="margin-bottom:16px">
        <div class="guide-card guide-card-accent"><div class="guide-label">TSS · Training Stress Score</div><div class="guide-formula"><span>TSS</span> = Σ (distance × RPE × intensity)</div><div class="guide-body">Calculated per day from all sessions. S&C = 10 km equivalent.</div></div>
        <div class="guide-card guide-card-accent"><div class="guide-label">CTL · Chronic Training Load</div><div class="guide-formula"><span>CTL</span> = 42-day exp. avg of TSS</div><div class="guide-body">Your <b>fitness</b>. Rises slowly with consistent training over weeks and months.</div></div>
        <div class="guide-card guide-card-accent"><div class="guide-label">ATL · Acute Training Load</div><div class="guide-formula"><span>ATL</span> = 7-day exp. avg of TSS</div><div class="guide-body">Your <b>fatigue</b>. Reacts fast — spikes within days of hard training.</div></div>
      </div>
      <div class="guide-card guide-card-accent" style="margin-bottom:16px"><div class="guide-label">TSB · Training Stress Balance — Your Form</div><div class="guide-formula"><span>TSB</span> = CTL − ATL</div><div class="guide-body">The key race-readiness number. Positive = fresh, Negative = fatigued.</div></div>
      <table class="guide-tsb-table" style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <tr><td style="color:var(--green)">TSB &gt; +10</td><td>Fresh — possibly detrained. Good for racing.</td></tr>
        <tr><td style="color:var(--green)">TSB 0 to +10</td><td>Optimal race form. Use this window for target events.</td></tr>
        <tr><td style="color:var(--amber)">TSB −10 to 0</td><td>Normal training zone. Slightly fatigued but performing well.</td></tr>
        <tr><td style="color:var(--amber)">TSB −10 to −20</td><td>Heavy block training. Monitor recovery carefully.</td></tr>
        <tr><td style="color:var(--red)">TSB &lt; −20</td><td>Overreaching risk. Consider a recovery day.</td></tr>
      </table>
    </div>

    <div class="guide-divider"></div>

    <div class="guide-section">
      <h3>RPE — Rate of Perceived Exertion</h3>
      <div class="guide-rpe-row">
        ${[
          {n:'1',label:'Rest',bg:'rgba(140,118,96,0.12)',color:'#5A4A3A'},
          {n:'2',label:'Very easy',bg:'rgba(46,122,74,0.10)',color:'#1A5830'},
          {n:'3',label:'Easy',bg:'rgba(46,122,74,0.18)',color:'#1A5830'},
          {n:'4',label:'Moderate',bg:'rgba(46,122,74,0.28)',color:'#1A5830'},
          {n:'5',label:'Steady',bg:'rgba(168,96,32,0.12)',color:'#7A4010'},
          {n:'6',label:'Comf. hard',bg:'rgba(168,96,32,0.22)',color:'#7A4010'},
          {n:'7',label:'Hard',bg:'rgba(168,96,32,0.35)',color:'#5A2E08'},
          {n:'8',label:'Very hard',bg:'rgba(184,50,50,0.18)',color:'#8C1C1C'},
          {n:'9',label:'Max effort',bg:'rgba(184,50,50,0.30)',color:'#8C1C1C'},
          {n:'10',label:'All out',bg:'rgba(184,50,50,0.45)',color:'#6A0C0C'},
        ].map(r=>`<div class="guide-rpe-cell" style="background:${r.bg};color:${r.color}"><div style="font-size:14px">${r.n}</div><div style="font-size:9px;font-weight:400;margin-top:2px">${r.label}</div></div>`).join('')}
      </div>
    </div>

    <div class="guide-divider"></div>

    <div class="guide-section">
      <h3>Your Data</h3>
      <div class="guide-card"><div class="guide-label">Where it's stored</div><div class="guide-body"><p>All data is stored in Supabase, a PostgreSQL-backed cloud database. Row Level Security (RLS) ensures only you can read and write your own data. The Supabase anon key is safe to use client-side with RLS enabled.</p><p>To migrate your old localStorage data, the app will prompt you on first login if existing local data is detected.</p></div></div>
    </div>
  `
}

// ═══════════════════════════════════════════════════════
// FEED PAGE (delegates to social.js)
// ═══════════════════════════════════════════════════════
async function renderFeedPage() {
  const page = document.getElementById('page-feed')
  page.innerHTML = '<h2>Feed</h2><div id="feed-content"></div>'
  const { renderFeed } = await import('./social.js')
  renderFeed(true)
}

async function renderConnectionsPage() {
  const page = document.getElementById('page-connections')
  page.innerHTML = '<h2>Connections</h2><div id="connections-content"></div>'
  const { renderConnections } = await import('./social.js')
  renderConnections()
}

// ═══════════════════════════════════════════════════════
// DATA MIGRATION FROM LOCALSTORAGE
// ═══════════════════════════════════════════════════════
window.migrateLocalStorageData = async function() {
  const lsSessionsRaw = localStorage.getItem('rowlog_sessions')
  const lsRacesRaw = localStorage.getItem('rowlog_races')
  const lsCheckinsRaw = localStorage.getItem('rowlog_checkins')

  if (!lsSessionsRaw) { showToast('No localStorage data found.', 'info'); return }

  showToast('Importing data...', 'info')
  let imported = 0
  let errors = 0

  try {
    if (lsSessionsRaw) {
      const days = JSON.parse(lsSessionsRaw)
      for (const day of days) {
        const ok = await upsertDay(day)
        if (ok) imported++
        else errors++
      }
    }

    if (lsRacesRaw) {
      const races = JSON.parse(lsRacesRaw)
      for (const race of races) {
        await saveRace(race)
      }
    }

    if (lsCheckinsRaw) {
      const checkins = JSON.parse(lsCheckinsRaw)
      for (const ci of checkins) {
        await upsertCheckin({
          date: ci.date,
          fatigue: ci.fatigue,
          mood: ci.mood,
          soreness: ci.soreness,
          stress: ci.stress,
          hrv: ci.hrv,
          readinessScore: ci.readinessScore || ci.readiness_score,
          trafficLight: ci.trafficLight || ci.traffic_light
        })
      }
    }

    showToast(`Migrated ${imported} training days. ${errors > 0 ? errors + ' errors.' : ''}`, errors > 0 ? 'error' : 'success')
    document.querySelector('.migration-banner')?.remove()
  } catch(err) {
    showToast('Migration error: ' + err.message, 'error')
  }
}

// ═══════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════
const PAGES = {
  dashboard: renderDashboard,
  log: renderLog,
  checkin: renderCheckin,
  ergs: renderErgs,
  calendar: renderCalendar,
  races: renderRaces,
  records: renderRecords,
  guide: renderGuide,
  feed: renderFeedPage,
  connections: renderConnectionsPage
}

export function navigate(page) {
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'))
  document.querySelectorAll('.page').forEach(el=>el.classList.remove('active'))

  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`)
  if(navEl) navEl.classList.add('active')
  const pageEl = document.getElementById(`page-${page}`)
  if(pageEl) pageEl.classList.add('active')

  Object.keys(charts).forEach(id=>{ if(charts[id]){ charts[id].destroy(); delete charts[id] } })

  const renderer = PAGES[page]||renderDashboard
  renderer()

  window.location.hash = page
}

// Expose navigate globally for onclick handlers
window.navigate = navigate

// Also expose renderCalendar and renderCheckin for inline handlers
window.renderCalendar = renderCalendar
window.renderCheckin = renderCheckin

// ═══════════════════════════════════════════════════════
// SIDEBAR SEARCH (delegates to social.js)
// ═══════════════════════════════════════════════════════
let _searchDebounce = null
window.handleSearch = function(query) {
  // Guard: module may not be ready yet on first keypress
  clearTimeout(_searchDebounce)
  _searchDebounce = setTimeout(async () => {
    const resultsEl = document.getElementById('search-results')
    if(!resultsEl) return
    if(!query || query.length < 2) { resultsEl.style.display='none'; return }

    const { searchUsers } = await import('./social.js')
    const users = await searchUsers(query)

    if(!users.length) {
      resultsEl.style.display = 'block'
      resultsEl.innerHTML = '<div style="padding:12px 16px;font-size:12px;color:var(--text3)">No athletes found.</div>'
      return
    }

    resultsEl.style.display = 'block'
    resultsEl.innerHTML = users.map(u => `
      <div class="search-result-item" data-uid="${u.id}">
        <div style="width:28px;height:28px;border-radius:50%;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0">
          ${u.avatar_url ? `<img src="${u.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : (u.username||'?')[0].toUpperCase()}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;color:var(--text)">${u.username}${u.is_public ? '' : ' <span style="font-size:9px;color:var(--text3)">(private)</span>'}</div>
          <div style="font-size:10px;color:var(--text2)">${u.club||''}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window._sendFollow('${u.id}','${u.username}',this);event.stopPropagation()">Follow</button>
      </div>
    `).join('')

    // Close on outside click
    setTimeout(() => {
      const close = (e) => {
        if(!resultsEl.contains(e.target) && e.target.id !== 'sidebar-search') {
          resultsEl.style.display = 'none'
          document.removeEventListener('click', close)
        }
      }
      document.addEventListener('click', close)
    }, 0)
  }, 300)
}

window._sendFollow = async function(userId, username, btn) {
  btn.disabled = true
  btn.textContent = '...'
  const { sendConnectionRequest } = await import('./social.js')
  await sendConnectionRequest(userId)
  btn.textContent = 'Sent'
  btn.style.opacity = '0.5'
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
async function init() {
  const session = await checkAuth()
  if(!session) return

  currentUid = session.user.id
  currentProfile = await getCurrentProfile()

  // Populate sidebar user info
  if(currentProfile) {
    const usernameEl = document.getElementById('sidebar-username')
    const clubEl = document.getElementById('sidebar-club')
    const avatarEl = document.getElementById('sidebar-avatar')
    if(usernameEl) usernameEl.textContent = currentProfile.username || currentProfile.full_name || 'Athlete'
    if(clubEl) clubEl.textContent = currentProfile.club || ''
    if(avatarEl) {
      if(currentProfile.avatar_url) {
        avatarEl.innerHTML = `<img src="${currentProfile.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
      } else {
        avatarEl.textContent = (currentProfile.username||'?')[0].toUpperCase()
      }
    }
  }

  // Sign out button
  window.signOut = async function() {
    await authSignOut()
  }

  // Notification badge
  const { getPendingCount, initRealtime } = await import('./social.js')
  const pending = await getPendingCount()
  if(pending > 0) {
    const connItem = document.querySelector('.nav-item[data-page="connections"]')
    if(connItem) {
      connItem.insertAdjacentHTML('beforeend', `<span class="notif-badge">${pending}</span>`)
    }
  }

  // Start realtime subscriptions
  initRealtime()

  // Navigate to initial page
  const initPage = (window.location.hash||'').slice(1)||'dashboard'
  navigate(initPage)
}

init()
