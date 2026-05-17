const adminForm = document.querySelector("#adminLogin");
const adminPassword = document.querySelector("#adminPassword");
const reportMonth = document.querySelector("#reportMonth");
const supplierForm = document.querySelector("#supplierForm");
const ordersView = document.querySelector("#ordersView");
const supplierView = document.querySelector("#supplierView");
const dailyView = document.querySelector("#dailyView");
const summaryView = document.querySelector("#summaryView");
const messageBox = document.querySelector("#messageBox");

reportMonth.value = new Date().toISOString().slice(0, 7);
document.querySelector("#transactionDate").value = new Date().toISOString().slice(0, 10);

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadOverview();
});

supplierForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSupplierRecord();
});

async function loadOverview() {
  showMessage("", "");
  const password = adminPassword.value;
  const month = reportMonth.value || new Date().toISOString().slice(0, 7);
  const response = await fetch(`/api/admin/overview?password=${encodeURIComponent(password)}&month=${encodeURIComponent(month)}`);
  const result = await response.json();

  if (!response.ok) {
    summaryView.innerHTML = "";
    dailyView.innerHTML = "";
    supplierView.innerHTML = "";
    ordersView.innerHTML = "";
    showMessage(result.error || "Could not load orders.", "error");
    supplierForm.hidden = true;
    return;
  }

  supplierForm.hidden = false;
  renderSummary(result.summary, result.storageMode);
  renderDaily(result.daily || []);
  renderSupplierRecords(result.supplierRecords || []);
  renderOrders(result.orders || []);
}

async function saveSupplierRecord() {
  showMessage("", "");
  const payload = {
    adminPassword: adminPassword.value,
    supplierName: document.querySelector("#supplierName").value,
    itemDetails: document.querySelector("#itemDetails").value,
    totalAmount: Number(document.querySelector("#totalAmount").value || 0),
    paidAmount: Number(document.querySelector("#paidAmount").value || 0),
    transactionDate: document.querySelector("#transactionDate").value,
    notes: document.querySelector("#supplierNotes").value
  };

  const response = await fetch("/api/admin/supplier-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (!response.ok) {
    showMessage(result.error || "Could not save supplier record.", "error");
    return;
  }

  supplierForm.reset();
  document.querySelector("#transactionDate").value = new Date().toISOString().slice(0, 10);
  showMessage("Supplier payment record saved.", "success");
  await loadOverview();
}

function renderSummary(summary, storageMode) {
  summaryView.innerHTML = `
    <div class="summary-card"><span>Storage</span><strong>${escapeHtml(storageMode)}</strong></div>
    <div class="summary-card"><span>Month turnover</span><strong>${money(summary.turnover)}</strong></div>
    <div class="summary-card"><span>Orders</span><strong>${summary.orders}</strong></div>
    <div class="summary-card"><span>Supplier paid</span><strong>${money(summary.supplierPaid)}</strong></div>
    <div class="summary-card"><span>Supplier baki</span><strong>${money(summary.supplierDue)}</strong></div>
    <div class="summary-card"><span>After paid supplier</span><strong>${money(summary.netAfterSupplierPaid)}</strong></div>
  `;
}

function renderDaily(rows) {
  if (!rows.length) {
    dailyView.innerHTML = `<p>No daily records for this month.</p>`;
    return;
  }

  dailyView.innerHTML = `
    <table class="orders-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Sell</th>
          <th>Orders</th>
          <th>Supplier paid</th>
          <th>Supplier baki</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.date)}</td>
            <td><strong>${money(row.sales)}</strong></td>
            <td>${row.orders}</td>
            <td>${money(row.supplierPaid)}</td>
            <td>${money(row.supplierDue)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderSupplierRecords(records) {
  if (!records.length) {
    supplierView.innerHTML = `<p>No supplier records for this month.</p>`;
    return;
  }

  supplierView.innerHTML = `
    <table class="orders-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Supplier</th>
          <th>Items</th>
          <th>Total</th>
          <th>Paid</th>
          <th>Baki</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${records.map((record) => `
          <tr>
            <td>${escapeHtml(record.transactionDate)}</td>
            <td><strong>${escapeHtml(record.supplierName)}</strong><br><small>${escapeHtml(record.notes)}</small></td>
            <td>${escapeHtml(record.itemDetails)}</td>
            <td>${money(record.totalAmount)}</td>
            <td>${money(record.paidAmount)}</td>
            <td>${money(record.dueAmount)}</td>
            <td>${escapeHtml(record.paymentStatus)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderOrders(orders) {
  if (!orders.length) {
    ordersView.innerHTML = `<p>No orders saved yet.</p>`;
    return;
  }

  ordersView.innerHTML = `
    <table class="orders-table">
      <thead>
        <tr>
          <th>Receipt</th>
          <th>Customer</th>
          <th>Items</th>
          <th>Total</th>
          <th>Saved</th>
        </tr>
      </thead>
      <tbody>
        ${orders.map((order) => `
          <tr>
            <td><strong>${escapeHtml(order.receiptNumber)}</strong></td>
            <td>${escapeHtml(order.customerName)}<br><small>${escapeHtml(order.customerPhone)}</small></td>
            <td>
              <ul class="order-items">
                ${(order.items || []).map((item) => `
                  <li>${escapeHtml(item.name)} - ${item.qty} x ${money(item.price)}</li>
                `).join("")}
              </ul>
            </td>
            <td><strong>${money(order.total)}</strong></td>
            <td>${escapeHtml(formatDate(order.updatedAt || order.savedAt || order.createdAt))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function showMessage(message, type) {
  messageBox.hidden = !message;
  messageBox.className = type ? `message-box ${type}` : "message-box";
  messageBox.textContent = message;
}

function money(amount) {
  return `\u20B9${Number(amount || 0).toFixed(2)}`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
