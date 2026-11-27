const theme = document.querySelector('#dashboard-theme');
const themeKey = 'keypharm-dashboard-theme';
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  const label = mode === 'dark' ? 'Light mode' : 'Dark mode';
  theme.setAttribute('aria-label',label);
  theme.title = label;
}
let savedTheme;
try { savedTheme = localStorage.getItem(themeKey); } catch { /* Private storage may be unavailable. */ }
applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
theme.innerHTML = '<svg class="theme-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg><svg class="theme-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.9 13.2A9 9 0 1 1 10.8 3.1a7 7 0 0 0 10.1 10.1Z"/></svg>';
theme.hidden = false;
theme.addEventListener('click',() => {
  const mode = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(mode);
  try { localStorage.setItem(themeKey,mode); } catch { /* The current page still switches themes. */ }
});
