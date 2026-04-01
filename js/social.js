import { supabase } from './supabase.js'
import { getCurrentUser } from './auth.js'
import { showToast } from './app.js'

// ─────────────────────────────────────────────
// searchUsers — public profiles by username or club
// ─────────────────────────────────────────────
export async function searchUsers(query) {
  if(!query || query.length < 2) return []
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, full_name, club, avatar_url, is_public')
      .or(`username.ilike.%${query}%,club.ilike.%${query}%`)
      .limit(20)
    if(error) throw error
    // Exclude self
    const user = await getCurrentUser()
    return (data||[]).filter(p => p.id !== user?.id)
  } catch(err) {
    console.error('searchUsers error:', err)
    return []
  }
}

// ─────────────────────────────────────────────
// Feed rendering
// ─────────────────────────────────────────────
let feedPage = 0
const FEED_PAGE_SIZE = 20

function formatRelativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if(mins < 1) return 'just now'
  if(mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if(hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if(days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-GB', { day:'numeric', month:'short' })
}

function renderFeedEventHTML(event, profile) {
  const username = profile?.username || 'Athlete'
  const data = event.event_data || {}
  let iconClass = 'feed-session'
  let iconEmoji = '💪'
  let text = ''

  if(event.event_type === 'pb') {
    iconClass = 'feed-pb'
    iconEmoji = '🏆'
    const split = data.splitSecs ? formatSplit(data.splitSecs) : (data.split || '')
    text = `<strong>${username}</strong> set a ${data.pieceType || ''} PB: <strong style="color:var(--accent)">${split}</strong>`
  } else if(event.event_type === 'race') {
    iconClass = 'feed-race'
    iconEmoji = '🚣'
    text = data.placing
      ? `<strong>${username}</strong> raced at <strong>${data.raceName || 'a regatta'}</strong>, placed <strong style="color:var(--amber)">${data.placing}</strong>`
      : `<strong>${username}</strong> added an upcoming race: <strong>${data.raceName || 'a regatta'}</strong>`
  } else if(event.event_type === 'streak') {
    iconClass = 'feed-streak'
    iconEmoji = '🔥'
    text = `<strong>${username}</strong> hit a <strong>${data.n || ''}-day</strong> training streak`
  } else if(event.event_type === 'session') {
    iconClass = 'feed-session'
    iconEmoji = '💪'
    text = `<strong>${username}</strong> logged a big session: <strong>${data.distance || ''}km</strong>`
  }

  return `
    <div class="feed-event">
      <div class="feed-event-icon ${iconClass}">${iconEmoji}</div>
      <div style="flex:1">
        <div style="font-size:12px;color:var(--text);line-height:1.5">${text}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:3px">${formatRelativeTime(event.created_at)}</div>
      </div>
    </div>
  `
}

function formatSplit(secs) {
  if(!secs || secs <= 0) return '—'
  const m = Math.floor(secs / 60)
  const s = (secs % 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

export async function renderFeed(reset = false) {
  if(reset) feedPage = 0
  const container = document.getElementById('feed-content')
  if(!container) return

  try {
    const user = await getCurrentUser()
    if(!user) return

    // Get accepted connections (following)
    const { data: conns } = await supabase
      .from('connections')
      .select('following_id')
      .eq('follower_id', user.id)
      .eq('status', 'accepted')

    const followingIds = (conns||[]).map(c => c.following_id)

    if(!followingIds.length) {
      container.innerHTML = `
        <div class="empty-state" style="padding:48px 20px">
          <p style="font-size:13px;color:var(--text2)">No connections yet. Use the search bar to find athletes and send connection requests.</p>
        </div>
      `
      return
    }

    const { data: events, error } = await supabase
      .from('feed_events')
      .select('*, profiles:user_id(username, avatar_url, club)')
      .in('user_id', followingIds)
      .order('created_at', { ascending: false })
      .range(feedPage * FEED_PAGE_SIZE, (feedPage + 1) * FEED_PAGE_SIZE - 1)

    if(error) throw error

    if(!events || !events.length) {
      container.innerHTML = '<div class="empty-state"><p>No recent activity from your connections.</p></div>'
      return
    }

    const eventsHTML = events.map(ev => renderFeedEventHTML(ev, ev.profiles)).join('')
    const hasMore = events.length === FEED_PAGE_SIZE

    if(feedPage === 0) {
      container.innerHTML = eventsHTML
    } else {
      const loadMoreBtn = document.getElementById('feed-load-more')
      if(loadMoreBtn) loadMoreBtn.remove()
      container.insertAdjacentHTML('beforeend', eventsHTML)
    }

    if(hasMore) {
      container.insertAdjacentHTML('beforeend', `
        <div id="feed-load-more" style="text-align:center;margin-top:16px">
          <button class="btn btn-ghost" onclick="window._feedLoadMore()">Load more</button>
        </div>
      `)
      window._feedLoadMore = () => { feedPage++; renderFeed() }
    }
  } catch(err) {
    container.innerHTML = `<div style="color:var(--red);font-size:12px;padding:16px">Error loading feed: ${err.message}</div>`
  }
}

// ─────────────────────────────────────────────
// Connections rendering
// ─────────────────────────────────────────────
export async function renderConnections() {
  const container = document.getElementById('connections-content')
  if(!container) return

  try {
    const user = await getCurrentUser()
    if(!user) return

    const { data: following } = await supabase
      .from('connections')
      .select('*, profiles:following_id(id, username, full_name, club, avatar_url)')
      .eq('follower_id', user.id)
      .order('created_at', { ascending: false })

    const { data: followers } = await supabase
      .from('connections')
      .select('*, profiles:follower_id(id, username, full_name, club, avatar_url)')
      .eq('following_id', user.id)
      .order('created_at', { ascending: false })

    const pendingFollowers = (followers||[]).filter(c => c.status === 'pending')
    const acceptedFollowing = (following||[]).filter(c => c.status === 'accepted')
    const pendingFollowing = (following||[]).filter(c => c.status === 'pending')
    const acceptedFollowers = (followers||[]).filter(c => c.status === 'accepted')

    container.innerHTML = `
      ${pendingFollowers.length ? `
      <div class="card" style="margin-bottom:16px">
        <h3>Pending Requests <span class="badge">${pendingFollowers.length}</span></h3>
        ${pendingFollowers.map(conn => `
          <div class="connection-card">
            <div style="width:36px;height:36px;border-radius:50%;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">
              ${conn.profiles?.avatar_url ? `<img src="${conn.profiles.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : (conn.profiles?.username||'?')[0].toUpperCase()}
            </div>
            <div style="flex:1">
              <div style="font-size:12px;font-weight:500;color:var(--text)">${conn.profiles?.username || 'Unknown'}</div>
              <div style="font-size:10px;color:var(--text2)">${conn.profiles?.club || ''}</div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-primary btn-sm" onclick="window._acceptConn('${conn.id}')">Accept</button>
              <button class="btn btn-ghost btn-sm" onclick="window._declineConn('${conn.id}')">Decline</button>
            </div>
          </div>
        `).join('')}
      </div>
      ` : ''}

      <div class="grid grid-2" style="gap:16px">
        <div class="card">
          <h3>Following <span style="color:var(--text2);font-weight:400">${acceptedFollowing.length}</span></h3>
          ${acceptedFollowing.length ? acceptedFollowing.map(conn => `
            <div class="connection-card">
              <div style="width:36px;height:36px;border-radius:50%;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">
                ${conn.profiles?.avatar_url ? `<img src="${conn.profiles.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : (conn.profiles?.username||'?')[0].toUpperCase()}
              </div>
              <div style="flex:1">
                <div style="font-size:12px;font-weight:500;color:var(--text)">${conn.profiles?.username || 'Unknown'}</div>
                <div style="font-size:10px;color:var(--text2)">${conn.profiles?.club || ''}</div>
              </div>
              <button class="btn btn-ghost btn-sm" onclick="window._removeConn('${conn.id}')">Unfollow</button>
            </div>
          `).join('') : '<p style="color:var(--text3);font-size:12px">Not following anyone yet.</p>'}
          ${pendingFollowing.length ? `
            <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.8px;color:var(--text2);margin-bottom:8px">Pending Sent</div>
              ${pendingFollowing.map(conn => `
                <div class="connection-card" style="opacity:0.7">
                  <div style="flex:1;font-size:12px;color:var(--text2)">${conn.profiles?.username || 'Unknown'}</div>
                  <span style="font-size:10px;color:var(--amber)">Pending</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <div class="card">
          <h3>Followers <span style="color:var(--text2);font-weight:400">${acceptedFollowers.length}</span></h3>
          ${acceptedFollowers.length ? acceptedFollowers.map(conn => `
            <div class="connection-card">
              <div style="width:36px;height:36px;border-radius:50%;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">
                ${conn.profiles?.avatar_url ? `<img src="${conn.profiles.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : (conn.profiles?.username||'?')[0].toUpperCase()}
              </div>
              <div style="flex:1">
                <div style="font-size:12px;font-weight:500;color:var(--text)">${conn.profiles?.username || 'Unknown'}</div>
                <div style="font-size:10px;color:var(--text2)">${conn.profiles?.club || ''}</div>
              </div>
            </div>
          `).join('') : '<p style="color:var(--text3);font-size:12px">No followers yet.</p>'}
        </div>
      </div>
    `

    window._acceptConn = async (id) => {
      await acceptConnection(id)
      showToast('Connection accepted', 'success')
      renderConnections()
    }
    window._declineConn = async (id) => {
      await declineConnection(id)
      showToast('Connection declined', 'info')
      renderConnections()
    }
    window._removeConn = async (id) => {
      const { error } = await supabase.from('connections').delete().eq('id', id)
      if(error) showToast('Error: ' + error.message, 'error')
      else { showToast('Unfollowed', 'info'); renderConnections() }
    }
  } catch(err) {
    container.innerHTML = `<div style="color:var(--red);font-size:12px;padding:16px">Error loading connections: ${err.message}</div>`
  }
}

// ─────────────────────────────────────────────
// sendConnectionRequest
// ─────────────────────────────────────────────
export async function sendConnectionRequest(targetUserId) {
  try {
    const user = await getCurrentUser()
    if(!user) return
    if(user.id === targetUserId) { showToast("You can't follow yourself.", 'info'); return }

    const { error } = await supabase.from('connections').insert({
      follower_id: user.id,
      following_id: targetUserId,
      status: 'pending'
    })
    if(error) {
      if(error.code === '23505') { showToast('Request already sent.', 'info') }
      else throw error
    } else {
      showToast('Connection request sent!', 'success')
    }
  } catch(err) {
    showToast('Error: ' + err.message, 'error')
  }
}

// ─────────────────────────────────────────────
// acceptConnection
// ─────────────────────────────────────────────
export async function acceptConnection(connectionId) {
  const { error } = await supabase
    .from('connections')
    .update({ status: 'accepted' })
    .eq('id', connectionId)
  if(error) { showToast('Error: ' + error.message, 'error'); return false }
  return true
}

// ─────────────────────────────────────────────
// declineConnection
// ─────────────────────────────────────────────
export async function declineConnection(connectionId) {
  const { error } = await supabase
    .from('connections')
    .update({ status: 'declined' })
    .eq('id', connectionId)
  if(error) { showToast('Error: ' + error.message, 'error'); return false }
  return true
}

// ─────────────────────────────────────────────
// getPendingCount
// ─────────────────────────────────────────────
export async function getPendingCount() {
  try {
    const user = await getCurrentUser()
    if(!user) return 0
    const { count } = await supabase
      .from('connections')
      .select('id', { count: 'exact', head: true })
      .eq('following_id', user.id)
      .eq('status', 'pending')
    return count || 0
  } catch(err) {
    return 0
  }
}

// ─────────────────────────────────────────────
// renderProfile — profile.html page logic
// ─────────────────────────────────────────────
export async function renderProfile() {
  const container = document.getElementById('profile-content')
  if(!container) return

  try {
    const user = await getCurrentUser()
    if(!user) return

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if(error) { container.innerHTML = '<p style="color:var(--red)">Error loading profile.</p>'; return }

    // Fetch stats: sessions, checkins
    const { data: sessions } = await supabase.from('sessions').select('*').eq('user_id', user.id)
    const thisYear = new Date().getFullYear().toString()
    const ytdSessions = (sessions||[]).filter(s => s.date?.startsWith(thisYear))
    const ytdKm = ytdSessions.reduce((sum, s) => sum + (parseFloat(s.distance_km)||0), 0)
    const totalSessions = (sessions||[]).filter(s => s.type !== 'Rest').length

    // Training streak (consecutive days with ≥1 non-Rest session)
    const sessionDates = new Set((sessions||[]).filter(s=>s.type!=='Rest').map(s=>s.date))
    let streak = 0
    let cursor = new Date().toISOString().slice(0,10)
    while(sessionDates.has(cursor)) {
      streak++
      const d = new Date(cursor+'T12:00:00')
      d.setDate(d.getDate()-1)
      cursor = d.toISOString().slice(0,10)
    }

    // Current CTL (simple approximation using session count)
    let ctl = 0
    if(sessions && sessions.length > 0) {
      const today = new Date().toISOString().slice(0,10)
      const sessionMap = {}
      sessions.forEach(s => {
        const d = s.date
        if(!sessionMap[d]) sessionMap[d] = 0
        const dist = s.type==='S&C' ? 10 : (parseFloat(s.distance_km)||0)
        const rpe = parseFloat(s.rpe)||1
        const intensityMap = {'Race':1.5,'Water Session':0.6,'Pieces on Water':0.8,'Erg UT2':0.4,'Erg Threshold':1.0,'Erg Intervals':1.2,'S&C':0.5,'Rest':0,'Other':0.6}
        sessionMap[d] += dist * rpe * (intensityMap[s.type]||0.6)
      })
      const ctlDecay = Math.exp(-1/42)
      let cursor2 = Object.keys(sessionMap).sort()[0] || today
      while(cursor2 <= today) {
        ctl = ctl * ctlDecay + (sessionMap[cursor2]||0) * (1 - ctlDecay)
        const d2 = new Date(cursor2+'T12:00:00'); d2.setDate(d2.getDate()+1)
        cursor2 = d2.toISOString().slice(0,10)
      }
      ctl = Math.round(ctl * 10) / 10
    }

    const shareUrl = `${window.location.origin}/pages/coach.html?token=${profile.share_token}`

    container.innerHTML = `
      <div class="grid grid-2" style="gap:24px;max-width:900px">
        <div>
          <div class="card" style="margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:20px;margin-bottom:20px">
              <div class="profile-avatar" id="avatar-display" style="width:72px;height:72px;font-size:24px;cursor:pointer" onclick="document.getElementById('avatar-input').click()">
                ${profile.avatar_url ? `<img src="${profile.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : (profile.username||'?')[0].toUpperCase()}
              </div>
              <div>
                <div style="font-family:var(--head);font-size:18px;font-weight:700;color:var(--bright)">${profile.username}</div>
                <div style="font-size:12px;color:var(--text2)">${profile.full_name||''}</div>
                <div style="font-size:11px;color:var(--text3);margin-top:2px">${profile.club||''}</div>
              </div>
            </div>
            <input type="file" id="avatar-input" accept="image/*" style="display:none" onchange="window._uploadAvatar(this)">

            <div class="sleep-stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:0">
              <div class="sleep-stat"><div class="sleep-stat-val">${ytdKm.toFixed(0)}</div><div class="sleep-stat-label">YTD km</div></div>
              <div class="sleep-stat"><div class="sleep-stat-val">${totalSessions}</div><div class="sleep-stat-label">Sessions</div></div>
              <div class="sleep-stat"><div class="sleep-stat-val">${ctl}</div><div class="sleep-stat-label">CTL</div></div>
              <div class="sleep-stat"><div class="sleep-stat-val">${streak}</div><div class="sleep-stat-label">Streak</div></div>
            </div>
          </div>

          <div class="card">
            <h3>Edit Profile</h3>
            <div class="form-row form-row-2">
              <div class="form-group"><label>Full Name</label><input id="pf-name" value="${profile.full_name||''}"></div>
              <div class="form-group"><label>Club</label><input id="pf-club" value="${profile.club||''}"></div>
            </div>
            <div class="form-row form-row-2">
              <div class="form-group"><label>Boat Type</label><input id="pf-boat" value="${profile.boat_type||''}"></div>
              <div class="form-group"><label>Seat</label><input id="pf-seat" value="${profile.seat||''}"></div>
            </div>
            <div class="form-row form-row-2">
              <div class="form-group"><label>Weight (kg)</label><input type="number" id="pf-weight" value="${profile.weight_kg||''}" step="0.1"></div>
              <div class="form-group"><label>Height (cm)</label><input type="number" id="pf-height" value="${profile.height_cm||''}" step="0.5"></div>
            </div>
            <div class="form-row form-row-2">
              <div class="form-group">
                <label>Threshold Split <span style="font-weight:400;color:var(--text3);text-transform:none">/500m — e.g. 2:00.0</span></label>
                <input id="pf-threshold" placeholder="2:00.0" value="${profile.threshold_split_secs ? (() => { const m=Math.floor(profile.threshold_split_secs/60); const s=(profile.threshold_split_secs%60).toFixed(1).padStart(4,'0'); return m+':'+s })() : ''}">
                <div style="font-size:10px;color:var(--text3);margin-top:4px">Your 2km test average split or best sustained threshold pace. Used for accurate TSS calculation.</div>
              </div>
            </div>
            <div style="margin-bottom:16px">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;text-transform:none;font-size:12px;color:var(--text)">
                <input type="checkbox" id="pf-public" ${profile.is_public?'checked':''} style="width:auto;margin:0">
                Public profile — allow other athletes to find and follow you
              </label>
            </div>
            <button class="btn btn-primary" onclick="window._saveProfile()">Save Changes</button>
          </div>
        </div>

        <div>
          <div class="card">
            <h3>Coach View</h3>
            <p style="font-size:12px;color:var(--text2);margin-bottom:12px">Share this link with your coach for a read-only view of your training data.</p>
            <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:10px 14px;font-size:11px;color:var(--text2);word-break:break-all;margin-bottom:10px">${shareUrl}</div>
            <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${shareUrl}').then(()=>showToast('Link copied!','success'))">Copy Link</button>
          </div>
        </div>
      </div>
    `

    window._saveProfile = async () => {
      // Parse threshold split "m:ss.s" → total seconds
      const thresholdRaw = document.getElementById('pf-threshold').value.trim()
      let thresholdSecs = null
      if (thresholdRaw) {
        const m = thresholdRaw.match(/^(\d+):(\d+\.?\d*)$/)
        thresholdSecs = m ? parseInt(m[1]) * 60 + parseFloat(m[2]) : null
      }
      const { error } = await supabase.from('profiles').update({
        full_name: document.getElementById('pf-name').value || null,
        club: document.getElementById('pf-club').value || null,
        boat_type: document.getElementById('pf-boat').value || null,
        seat: document.getElementById('pf-seat').value || null,
        weight_kg: document.getElementById('pf-weight').value ? parseFloat(document.getElementById('pf-weight').value) : null,
        height_cm: document.getElementById('pf-height').value ? parseFloat(document.getElementById('pf-height').value) : null,
        threshold_split_secs: thresholdSecs,
        is_public: document.getElementById('pf-public').checked
      }).eq('id', user.id)
      if(error) showToast('Error saving: ' + error.message, 'error')
      else { showToast('Profile saved', 'success'); renderProfile() }
    }

    window._uploadAvatar = async (input) => {
      const file = input.files[0]
      if(!file) return
      const ext = file.name.split('.').pop()
      const path = `${user.id}/avatar.${ext}`
      const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true })
      if(upErr) { showToast('Upload error: ' + upErr.message, 'error'); return }
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path)
      const avatarUrl = urlData.publicUrl + '?t=' + Date.now()
      const { error: updateErr } = await supabase.from('profiles').update({ avatar_url: avatarUrl }).eq('id', user.id)
      if(updateErr) { showToast('Error saving avatar URL: ' + updateErr.message, 'error'); return }
      showToast('Avatar updated', 'success')
      const avatarDisplay = document.getElementById('avatar-display')
      if(avatarDisplay) avatarDisplay.innerHTML = `<img src="${avatarUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
    }
  } catch(err) {
    container.innerHTML = `<div style="color:var(--red);font-size:12px;padding:16px">Error: ${err.message}</div>`
  }
}

// ─────────────────────────────────────────────
// writeFeedEvent
// ─────────────────────────────────────────────
export async function writeFeedEvent(eventType, eventData) {
  try {
    const user = await getCurrentUser()
    if(!user) return
    await supabase.from('feed_events').insert({
      user_id: user.id,
      event_type: eventType,
      event_data: eventData
    })
  } catch(err) {
    console.error('writeFeedEvent error:', err)
  }
}

// ─────────────────────────────────────────────
// initRealtime — subscribe to live updates
// ─────────────────────────────────────────────
export async function initRealtime() {
  const user = await getCurrentUser()
  if(!user) return

  // Subscribe to new feed events for connected users
  supabase
    .channel('feed-realtime')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'feed_events'
    }, async (payload) => {
      // Check if the event is from a followed user
      const { data: conn } = await supabase
        .from('connections')
        .select('id')
        .eq('follower_id', user.id)
        .eq('following_id', payload.new.user_id)
        .eq('status', 'accepted')
        .single()

      if(conn) {
        // Re-render feed if currently visible
        const feedContent = document.getElementById('feed-content')
        if(feedContent) {
          feedPage = 0
          renderFeed()
        }
      }
    })
    .subscribe()

  // Subscribe to connection status changes
  supabase
    .channel('connections-realtime')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'connections',
      filter: `following_id=eq.${user.id}`
    }, async () => {
      // Update notification badge
      const pending = await getPendingCount()
      const badge = document.querySelector('.nav-item[data-page="connections"] .notif-badge')
      if(pending > 0) {
        if(badge) {
          badge.textContent = pending
        } else {
          const connItem = document.querySelector('.nav-item[data-page="connections"]')
          if(connItem) connItem.insertAdjacentHTML('beforeend', `<span class="notif-badge">${pending}</span>`)
        }
      } else {
        if(badge) badge.remove()
      }
    })
    .subscribe()
}
