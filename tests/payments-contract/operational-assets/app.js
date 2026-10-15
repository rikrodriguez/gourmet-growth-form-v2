document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-target]');
  if (!button) return;
  const target = document.getElementById(button.dataset.copyTarget);
  if (!(target instanceof HTMLInputElement)) return;
  target.select();
  try {
    await navigator.clipboard.writeText(target.value);
  } catch (_) {
    document.execCommand('copy');
  }
  button.textContent = 'Copied';
});

const adminBootstrapForm = document.querySelector('[data-admin-bootstrap-form]');
if (adminBootstrapForm instanceof HTMLFormElement) {
  const bootstrapToken = window.location.hash.slice(1);
  const tokenField = adminBootstrapForm.elements.namedItem('bootstrap_token');
  const status = document.getElementById('bootstrap-status');
  if (/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken) && tokenField instanceof HTMLInputElement) {
    tokenField.value = bootstrapToken;
    adminBootstrapForm.hidden = false;
    if (status) status.textContent = 'Create the first private administrator account.';
    history.replaceState(null, '', window.location.pathname);
  } else if (status) {
    status.textContent = 'This setup link is invalid or expired.';
  }
}
