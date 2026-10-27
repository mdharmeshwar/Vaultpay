const root = document.querySelector('#app');
const account = document.querySelector('#account');
const state = { token: sessionStorage.getItem('vaultpay-token'), user: null, route: location.pathname };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function amount(cents, currency) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

function dateLabel(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    state.token = null;
    state.user = null;
    sessionStorage.removeItem('vaultpay-token');
    navigate('/login', false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response;
}

function showNotice(message, type = '') {
  root.querySelector('.notice')?.remove();
  const notice = document.createElement('div');
  notice.className = `notice ${type}`.trim();
  notice.textContent = message;
  root.prepend(notice);
}

function setAccount() {
  if (!state.user) {
    account.innerHTML = '';
    return;
  }
  account.innerHTML = `<span><strong>${escapeHtml(state.user.name)}</strong><span class="account-role"> · ${escapeHtml(state.user.role)}</span></span><button class="link-button" data-action="logout">Sign out</button>`;
}

function navigate(path, push = true) {
  if (push) history.pushState({}, '', path);
  else history.replaceState({}, '', path);
  state.route = path;
  render().catch((error) => showNotice(error.message, 'error'));
}

function logout() {
  state.token = null;
  state.user = null;
  sessionStorage.removeItem('vaultpay-token');
  navigate('/login');
}

account.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="logout"]')) logout();
});

function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status.toLowerCase())}">${escapeHtml(status)}</span>`;
}

function invoiceRows(invoices, admin = false) {
  if (!invoices.length) return '<div class="empty-state">No invoices to display yet.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Invoice</th>${admin ? '<th>Client</th>' : ''}<th>Description</th><th>Amount</th><th>Due date</th><th>Status</th></tr></thead>
    <tbody>${invoices.map((invoice) => `<tr>
      <td><a class="invoice-link" href="/invoice/${encodeURIComponent(invoice.id)}" data-route="/invoice/${encodeURIComponent(invoice.id)}">${escapeHtml(invoice.invoice_number)}</a></td>
      ${admin ? `<td>${escapeHtml(invoice.client_name)}</td>` : ''}
      <td>${escapeHtml(invoice.description)}</td>
      <td>${amount(invoice.amount_cents, invoice.currency)}</td>
      <td>${dateLabel(invoice.due_date)}</td>
      <td>${statusBadge(invoice.status)}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function statCard(label, value) {
  return `<article class="stat-card"><span class="stat-label">${escapeHtml(label)}</span><strong class="stat-value">${escapeHtml(value)}</strong></article>`;
}

async function loginView() {
  account.innerHTML = '';
  root.innerHTML = `<section class="login-wrap"><form class="login-card" id="login-form">
    <span class="stat-label">SECURE FINANCIAL PORTAL</span><h1>Welcome back</h1>
    <p class="subtle">Sign in to manage invoices and payments.</p>
    <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254"></div>
    <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
    <button class="primary" type="submit">Sign in securely</button>
  </form></section>`;
}

async function adminView() {
  const [summaryResponse, invoicesResponse, clientsResponse] = await Promise.all([
    api('/api/admin/summary'), api('/api/invoices'), api('/api/clients')
  ]);
  const { byCurrency } = await summaryResponse.json();
  const { invoices } = await invoicesResponse.json();
  const { clients } = await clientsResponse.json();
  const sums = byCurrency.map((row) => `${amount(row.paid_cents, row.currency)} ${row.currency}`).join(' · ') || '—';
  const invoiced = byCurrency.map((row) => `${amount(row.invoiced_cents, row.currency)} ${row.currency}`).join(' · ') || '—';
  const outstanding = byCurrency.map((row) => `${amount(row.outstanding_cents, row.currency)} ${row.currency}`).join(' · ') || '—';
  const today = new Date().toISOString().slice(0, 10);
  root.innerHTML = `<div class="page-heading"><div><span class="stat-label">ADMINISTRATION</span><h1>Financial overview</h1><p class="subtle">Invoice activity and verified collections across registered clients.</p></div></div>
    <section class="stats">${statCard('Total invoiced', invoiced)}${statCard('Confirmed paid', sums)}${statCard('Outstanding', outstanding)}</section>
    <div class="stack">
      <section class="panel"><div class="page-heading"><div><h2 class="section-title">All invoices</h2><p class="subtle">Paid amounts are recorded only after a verified Stripe webhook.</p></div></div>${invoiceRows(invoices, true)}</section>
      <section class="panel"><h2 class="section-title">Create invoice</h2>
        ${clients.length ? `<form id="invoice-form" class="form-grid">
          <div class="field"><label for="clientId">Registered client</label><select id="clientId" name="clientId" required>${clients.map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)} · ${escapeHtml(client.email)}</option>`).join('')}</select></div>
          <div class="field"><label for="amount">Amount</label><input id="amount" name="amount" type="number" min="0.01" max="999999999.99" step="0.01" required></div>
          <div class="field"><label for="currency">Currency</label><select id="currency" name="currency"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option><option>AUD</option></select></div>
          <div class="field"><label for="issueDate">Issue date</label><input id="issueDate" name="issueDate" type="date" value="${today}" required></div>
          <div class="field"><label for="dueDate">Due date</label><input id="dueDate" name="dueDate" type="date" value="${today}" required></div>
          <div class="field full"><label for="description">Description</label><textarea id="description" name="description" maxlength="500" required></textarea></div>
          <div class="form-actions"><button class="primary" type="submit">Create invoice</button></div>
        </form>` : '<div class="empty-state">Register a client below before creating an invoice.</div>'}
      </section>
      <section class="panel"><h2 class="section-title">Register client</h2><form id="client-form" class="form-grid">
        <div class="field"><label for="clientName">Client name</label><input id="clientName" name="name" maxlength="120" required></div>
        <div class="field"><label for="clientEmail">Client email</label><input id="clientEmail" name="email" type="email" maxlength="254" required></div>
        <div class="field"><label for="clientPassword">Temporary password (12+ characters)</label><input id="clientPassword" name="password" type="password" minlength="12" required></div>
        <div class="form-actions"><button class="secondary" type="submit">Add client</button></div>
      </form></section>
    </div>`;
}

async function clientView() {
  const { invoices } = await (await api('/api/invoices')).json();
  const totalDueByCurrency = {};
  invoices.filter((invoice) => ['Open', 'Pending'].includes(invoice.status)).forEach((invoice) => {
    totalDueByCurrency[invoice.currency] = (totalDueByCurrency[invoice.currency] || 0) + invoice.amount_cents;
  });
  const outstanding = Object.entries(totalDueByCurrency).map(([currency, cents]) => `${amount(cents, currency)} ${currency}`).join(' · ') || '—';
  const paidCount = invoices.filter((invoice) => invoice.status === 'Paid').length;
  root.innerHTML = `<div class="page-heading"><div><span class="stat-label">CLIENT ACCOUNT</span><h1>Your invoices</h1><p class="subtle">Review current balances and securely access your documents.</p></div></div>
    <section class="stats">${statCard('Outstanding balance', outstanding)}${statCard('Invoices', invoices.length)}${statCard('Paid invoices', paidCount)}</section>
    <section class="panel"><h2 class="section-title">Invoice activity</h2>${invoiceRows(invoices)}</section>`;
}

async function invoiceView(invoiceId) {
  const { invoice } = await (await api(`/api/invoices/${encodeURIComponent(invoiceId)}`)).json();
  const admin = state.user.role === 'Admin';
  const checkout = new URLSearchParams(location.search).get('checkout');
  const message = checkout === 'success'
    ? '<div class="notice warn">Payment submitted. Waiting for verified confirmation from the payment provider; this page does not determine payment status.</div>'
    : checkout === 'cancel' ? '<div class="notice">Checkout was cancelled. No payment confirmation was recorded.</div>' : '';
  root.innerHTML = `${message}<div class="page-heading"><div><span class="stat-label">DOCUMENT VAULT</span><h1>Invoice ${escapeHtml(invoice.invoice_number)}</h1><p class="subtle">${admin ? `Client: ${escapeHtml(invoice.client_name)}` : 'Your invoice details and secure documents.'}</p></div><a class="secondary button" href="${admin ? '/admin/dashboard' : '/client/dashboard'}" data-route="${admin ? '/admin/dashboard' : '/client/dashboard'}">Back to dashboard</a></div>
    <section class="panel">
      <div class="page-heading"><div><div class="amount-large">${amount(invoice.amount_cents, invoice.currency)}</div><p class="subtle">Invoice total</p></div>${statusBadge(invoice.status)}</div>
      <div class="detail-grid">
        <div class="detail-item"><small>Description</small><strong>${escapeHtml(invoice.description)}</strong></div>
        <div class="detail-item"><small>Invoice number</small><strong>${escapeHtml(invoice.invoice_number)}</strong></div>
        <div class="detail-item"><small>Issue date</small><strong>${dateLabel(invoice.issue_date)}</strong></div>
        <div class="detail-item"><small>Due date</small><strong>${dateLabel(invoice.due_date)}</strong></div>
        <div class="detail-item"><small>Payment status</small><strong>${escapeHtml(invoice.status)}${invoice.status === 'Paid' ? ` · ${escapeHtml(invoice.payment_confirmed_at || '')}` : ''}</strong></div>
        ${admin ? `<div class="detail-item"><small>Receipt delivery</small><strong>${escapeHtml(invoice.receipt_status)} · email ${escapeHtml(invoice.email_status)}</strong></div>` : ''}
      </div>
      <div class="actions action-gap">
        ${!admin && ['Open', 'Pending'].includes(invoice.status) ? `<button class="primary" data-action="pay" data-id="${escapeHtml(invoice.id)}">Pay invoice</button>` : ''}
        <button class="secondary" data-action="download" data-kind="pdf" data-id="${escapeHtml(invoice.id)}">Download invoice PDF</button>
        ${invoice.canDownloadReceipt ? `<button class="secondary" data-action="download" data-kind="receipt" data-id="${escapeHtml(invoice.id)}">Download receipt</button>` : ''}
        ${admin && invoice.status === 'Paid' && (invoice.receipt_status === 'failed' || invoice.email_status === 'failed') ? `<button class="secondary" data-action="retry" data-id="${escapeHtml(invoice.id)}">Retry receipt delivery</button>` : ''}
      </div>
    </section>`;
}

async function forbiddenView() {
  root.innerHTML = `<section class="empty-state"><span class="stat-label">403</span><h1>Unauthorized</h1><p>You do not have permission to access this area.</p><a class="secondary button" href="${state.user?.role === 'Admin' ? '/admin/dashboard' : '/client/dashboard'}" data-route="${state.user?.role === 'Admin' ? '/admin/dashboard' : '/client/dashboard'}">Return to dashboard</a></section>`;
}

async function render() {
  if (!state.token) return loginView();
  if (!state.user) {
    try {
      state.user = (await (await api('/api/auth/me')).json()).user;
    } catch {
      return;
    }
  }
  setAccount();
  const path = location.pathname;
  if (path === '/login' || path === '/') {
    navigate(state.user.role === 'Admin' ? '/admin/dashboard' : '/client/dashboard', false);
    return;
  }
  if (path.startsWith('/admin/') && state.user.role !== 'Admin') return forbiddenView();
  if (path.startsWith('/client/') && state.user.role !== 'Client') return forbiddenView();
  if (path === '/admin/dashboard' && state.user.role === 'Admin') return adminView();
  if (path === '/client/dashboard' && state.user.role === 'Client') return clientView();
  const invoiceMatch = path.match(/^\/invoice\/([0-9a-f-]{36})$/i);
  if (invoiceMatch) return invoiceView(invoiceMatch[1]);
  return forbiddenView();
}

async function downloadFile(invoiceId, kind) {
  const response = await api(`/api/invoices/${encodeURIComponent(invoiceId)}/${kind}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${kind}-${invoiceId}.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

root.addEventListener('click', async (event) => {
  const routeLink = event.target.closest('[data-route]');
  if (routeLink) {
    event.preventDefault();
    return navigate(routeLink.dataset.route);
  }
  const control = event.target.closest('[data-action]');
  if (!control) return;
  try {
    if (control.dataset.action === 'logout') {
      return logout();
    }
    if (control.dataset.action === 'download') return await downloadFile(control.dataset.id, control.dataset.kind);
    if (control.dataset.action === 'retry') {
      control.disabled = true;
      await api(`/api/admin/invoices/${encodeURIComponent(control.dataset.id)}/retry-delivery`, { method: 'POST' });
      return navigate(`/invoice/${encodeURIComponent(control.dataset.id)}`, false);
    }
    if (control.dataset.action === 'pay') {
      control.disabled = true;
      control.innerHTML = '<span class="spinner"></span> Preparing secure checkout…';
      const response = await api('/api/payments/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({ invoiceId: control.dataset.id })
      });
      const result = await response.json();
      const checkoutUrl = new URL(result.url);
      if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com') {
        throw new Error('The payment provider returned an invalid checkout destination');
      }
      location.assign(checkoutUrl.href);
    }
  } catch (error) {
    showNotice(error.message, 'error');
    const payButton = root.querySelector('[data-action="pay"]');
    if (payButton) {
      payButton.disabled = false;
      payButton.textContent = 'Pay invoice';
    }
  }
});

root.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (form.id === 'login-form') {
      const formData = new FormData(form);
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formData.get('email'), password: formData.get('password') })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to sign in');
      state.token = result.token;
      state.user = result.user;
      sessionStorage.setItem('vaultpay-token', result.token);
      navigate(result.user.role === 'Admin' ? '/admin/dashboard' : '/client/dashboard', false);
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    if (form.id === 'invoice-form') {
      const response = await api('/api/invoices', { method: 'POST', body: JSON.stringify(data) });
      const result = await response.json();
      navigate(`/invoice/${encodeURIComponent(result.invoice.id)}`);
      return;
    }
    if (form.id === 'client-form') {
      await api('/api/clients', { method: 'POST', body: JSON.stringify(data) });
      showNotice('Client account created.');
      return navigate('/admin/dashboard', false);
    }
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    if (submit.isConnected) submit.disabled = false;
  }
});

window.addEventListener('popstate', () => {
  state.route = location.pathname;
  render().catch((error) => showNotice(error.message, 'error'));
});

async function start() {
  const search = new URLSearchParams(location.search);
  const checkout = search.get('checkout');
  const invoiceId = search.get('invoice');
  if (checkout === 'success' || checkout === 'cancel') {
    state.checkoutResult = checkout;
  }
  try {
    await render();
    if (state.checkoutResult) {
      if (invoiceId && state.token && state.user) {
        navigate(`/invoice/${encodeURIComponent(invoiceId)}?checkout=${state.checkoutResult}`, false);
      }
    }
  } catch (error) {
    root.innerHTML = '<section class="empty-state"><h1>Unable to load VaultPay</h1></section>';
    showNotice(error.message, 'error');
  }
}

start();
