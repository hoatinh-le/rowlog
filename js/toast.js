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
