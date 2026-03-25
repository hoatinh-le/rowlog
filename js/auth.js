import { supabase } from './supabase.js'

// ─────────────────────────────────────────────
// checkAuth — call on every protected page load
// ─────────────────────────────────────────────
export async function checkAuth() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    const path = window.location.pathname
    const isAuthPage = path.includes('login.html') || path.includes('register.html')
    if (!isAuthPage) {
      window.location.href = '/pages/login.html'
    }
    return null
  }
  return session
}

// ─────────────────────────────────────────────
// getCurrentUser
// ─────────────────────────────────────────────
export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

// ─────────────────────────────────────────────
// getCurrentProfile
// ─────────────────────────────────────────────
export async function getCurrentProfile() {
  const user = await getCurrentUser()
  if (!user) return null
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()
  if (error) {
    console.error('Error fetching profile:', error)
    return null
  }
  return data
}

// ─────────────────────────────────────────────
// signOut
// ─────────────────────────────────────────────
export async function signOut() {
  await supabase.auth.signOut()
  window.location.href = '/pages/login.html'
}

// ─────────────────────────────────────────────
// initLoginPage
// ─────────────────────────────────────────────
export function initLoginPage() {
  const form = document.getElementById('login-form')
  const errorEl = document.getElementById('login-error')
  const forgotLink = document.getElementById('forgot-link')

  if (!form) return

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = document.getElementById('login-email').value.trim()
    const password = document.getElementById('login-password').value
    const submitBtn = form.querySelector('button[type=submit]')

    errorEl.style.display = 'none'
    submitBtn.disabled = true
    submitBtn.textContent = 'Signing in...'

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      window.location.href = '/pages/app.html'
    } catch (err) {
      errorEl.textContent = err.message || 'Invalid email or password.'
      errorEl.style.display = 'block'
      submitBtn.disabled = false
      submitBtn.textContent = 'Sign In'
    }
  })

  if (forgotLink) {
    forgotLink.addEventListener('click', async (e) => {
      e.preventDefault()
      const email = document.getElementById('login-email').value.trim()
      if (!email) {
        errorEl.textContent = 'Enter your email address first.'
        errorEl.style.display = 'block'
        return
      }
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + '/pages/login.html'
      })
      if (error) {
        errorEl.textContent = error.message
        errorEl.style.display = 'block'
      } else {
        errorEl.style.display = 'none'
        alert('Password reset email sent. Check your inbox.')
      }
    })
  }
}

// ─────────────────────────────────────────────
// initRegisterPage
// ─────────────────────────────────────────────
export function initRegisterPage() {
  const form = document.getElementById('register-form')
  const errorEl = document.getElementById('register-error')
  const usernameInput = document.getElementById('reg-username')
  const usernameCheck = document.getElementById('username-check')

  if (!form) return

  let usernameTimeout = null
  let usernameAvailable = false

  // Real-time username uniqueness check (debounced 400ms)
  if (usernameInput) {
    usernameInput.addEventListener('input', () => {
      clearTimeout(usernameTimeout)
      const val = usernameInput.value.trim().toLowerCase()
      usernameCheck.textContent = ''
      usernameAvailable = false

      if (val.length < 3) {
        usernameCheck.textContent = 'Username must be at least 3 characters.'
        usernameCheck.className = 'username-check username-taken'
        return
      }

      usernameTimeout = setTimeout(async () => {
        usernameCheck.textContent = 'Checking...'
        usernameCheck.className = 'username-check'
        const { data } = await supabase
          .from('profiles')
          .select('id')
          .eq('username', val)
          .single()
        if (data) {
          usernameCheck.textContent = 'Username taken'
          usernameCheck.className = 'username-check username-taken'
          usernameAvailable = false
        } else {
          usernameCheck.textContent = 'Available'
          usernameCheck.className = 'username-check username-ok'
          usernameAvailable = true
        }
      }, 400)
    })
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = document.getElementById('reg-email').value.trim()
    const password = document.getElementById('reg-password').value
    const confirmPassword = document.getElementById('reg-confirm').value
    const username = document.getElementById('reg-username').value.trim().toLowerCase()
    const fullName = document.getElementById('reg-fullname')?.value.trim() || ''
    const club = document.getElementById('reg-club')?.value.trim() || ''
    const submitBtn = form.querySelector('button[type=submit]')

    errorEl.style.display = 'none'

    if (password !== confirmPassword) {
      errorEl.textContent = 'Passwords do not match.'
      errorEl.style.display = 'block'
      return
    }
    if (username.length < 3) {
      errorEl.textContent = 'Username must be at least 3 characters.'
      errorEl.style.display = 'block'
      return
    }
    if (!usernameAvailable) {
      errorEl.textContent = 'Please choose an available username.'
      errorEl.style.display = 'block'
      return
    }

    submitBtn.disabled = true
    submitBtn.textContent = 'Creating account...'

    try {
      // Create auth user
      const { data: authData, error: authError } = await supabase.auth.signUp({ email, password })
      if (authError) throw authError

      const userId = authData.user?.id
      if (!userId) throw new Error('User creation failed.')

      // Insert profile row
      const { error: profileError } = await supabase.from('profiles').insert({
        id: userId,
        username,
        full_name: fullName || null,
        club: club || null
      })
      if (profileError) throw profileError

      window.location.href = '/pages/app.html'
    } catch (err) {
      errorEl.textContent = err.message || 'Registration failed. Please try again.'
      errorEl.style.display = 'block'
      submitBtn.disabled = false
      submitBtn.textContent = 'Create Account'
    }
  })
}
