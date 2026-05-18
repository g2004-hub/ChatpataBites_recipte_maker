const adminForm = document.querySelector("#adminLogin");
const adminPassword = document.querySelector("#adminPassword");
const reportMonth = document.querySelector("#reportMonth");
const supplierForm = document.querySelector("#supplierForm");
const ordersView = document.querySelector("#ordersView");
const supplierView = document.querySelector("#supplierView");
const dailyView = document.querySelector("#dailyView");
const summaryView = document.querySelector("#summaryView");
const messageBox = document.querySelector("#messageBox");
const supplierFormTitle = document.querySelector("#supplierFormTitle");
const supplierSubmitButton = document.querySelector("#supplierSubmitButton");
const cancelSupplierEditButton = document.querySelector("#cancelSupplierEdit");

let editingSupplierId = "";
let currentSupplierRecords = [];
let currentOrders = [];

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

cancelSupplierEditButton.addEventListener("click", () => {
  resetSupplierForm();
});

supplierView.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-supplier]");
  if (!editButton) {
    return;
  }

  const record = currentSupplierRecords.find((entry) => String(entry.id) === editButton.dataset.editSupplier);
  if (record) {
    startSupplierEdit(record);
  }
});

ordersView.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-order]");
  const cancelButton = event.target.closest("[data-cancel-order]");
  const saveButton = event.target.closest("[data-save-order]");

  if (editButton) {
    renderOrders(currentOrders, editButton.dataset.editOrder);
  }

  if (cancelButton) {
    renderOrders(currentOrders);
  }

  if (saveButton) {
    await saveOrderRecord(saveButton.dataset.saveOrder);
  }
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
  currentSupplierRecords = result.supplierRecords || [];
  currentOrders = result.orders || [];
  renderSummary(result.summary, result.storageMode);
  renderDaily(result.daily || []);
  renderSupplierRecords(currentSupplierRecords);
  renderOrders(currentOrders);
}

async function saveSupplierRecord() {
  showMessage("", "");
  const payload = getSupplierPayload();
  const isEdit = Boolean(editingSupplierId);
  const url = isEdit
    ? `/api/admin/supplier-records/${encodeURIComponent(editingSupplierId)}`
    : "/api/admin/supplier-records";

  const response = await fetch(url, {
    method: isEdit ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (!response.ok) {
    showMessage(result.error || "Could not save supplier record.", "error");
    return;
  }

  resetSupplierForm();
  showMessage(isEdit ? "Supplier record updated." : "Supplier payment record saved.", "success");
  await loadOverview();
}

async function saveOrderRecord(receiptNumber) {
  showMessage("", "");
  const row = ordersView.querySelector(`[data-order-row="${cssEscape(receiptNumber)}"]`);
  const itemLines = row.querySelector("[data-order-items]").value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const payload = {
    adminPassword: adminPassword.value,
    customerName: row.querySelector("[data-order-customer]").value,
    customerPhone: row.querySelector("[data-order-phone]").value,
    subtotal: Number(row.querySelector("[data-order-subtotal]").value || 0),
    discount: Number(row.querySelector("[data-order-discount]").value || 0),
    tax: Number(row.querySelector("[data-order-tax]").value || 0),
    total: Number(row.querySelector("[data-order-total]").value || 0),
    items: itemLines.map(parseOrderItemLine)
  };

  const response = await fetch(`/api/admin/orders/${encodeURIComponent(receiptNumber)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (!response.ok) {
    showMessage(result.error || "Could not update sell record.", "error");
    return;
  }

  showMessage("Sell record updated.", "success");
  await loadOverview();
}

function getSupplierPayload() {
  return {
    adminPassword: adminPassword.value,
    supplierName: document.querySelector("#supplierName").value,
    itemDetails: document.querySelector("#itemDetails").value,
    totalAmount: Number(document.querySelector("#totalAmount").value || 0),
    paidAmount: Number(document.querySelector("#paidAmount").value || 0),
    transactionDate: document.querySelector("#transactionDate").value,
    notes: document.querySelector("#supplierNotes").value
  };
}

function startSupplierEdit(record) {
  editingSupplierId = String(record.id);
  supplierFormTitle.textContent = "Edit Supplier Payment Record";
  supplierSubmitButton.textContent = "Update supplier record";
  cancelSupplierEditButton.hidden = false;
  document.querySelector("#supplierName").value = record.supplierName || "";
  document.querySelector("#itemDetails").value = record.itemDetails || "";
  document.querySelector("#totalAmount").value = Number(record.totalAmount || 0);
  document.querySelector("#paidAmount").value = Number(record.paidAmount || 0);
  document.querySelector("#transactionDate").value = record.transactionDate || new Date().toISOString().slice(0, 10);
  document.querySelector("#supplierNotes").value = record.notes || "";
  supplierForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetSupplierForm() {
  editingSupplierId = "";
  supplierForm.reset();
  supplierFormTitle.textContent = "Supplier Payment Record";
  supplierSubmitButton.textContent = "Save supplier record";
  cancelSupplierEditButton.hidden = true;
  document.querySelector("#transactionDate").value = new Date().toISOString().slice(0, 10);
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
          <th>Action</th>
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
            <td><button type="button" class="small-button secondary" data-edit-supplier="${escapeHtml(record.id)}">Edit</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderOrders(orders, editingReceiptNumber = "") {
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
          <th>Amounts</th>
          <th>Saved</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${orders.map((order) => order.receiptNumber === editingReceiptNumber ? renderEditableOrder(order) : renderReadonlyOrder(order)).join("")}
      </tbody>
    </table>
  `;
}

function renderReadonlyOrder(order) {
  return `
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
      <td><strong>${money(order.total)}</strong><br><small>Discount: ${money(order.discount)} | Tax: ${money(order.tax)}</small></td>
      <td>${escapeHtml(formatDate(order.updatedAt || order.savedAt || order.createdAt))}</td>
      <td><button type="button" class="small-button secondary" data-edit-order="${escapeHtml(order.receiptNumber)}">Edit</button></td>
    </tr>
  `;
}

function renderEditableOrder(order) {
  return `
    <tr data-order-row="${escapeHtml(order.receiptNumber)}">
      <td><strong>${escapeHtml(order.receiptNumber)}</strong></td>
      <td>
        <label class="compact-label">Customer
          <input data-order-customer type="text" value="${escapeHtml(order.customerName)}">
        </label>
        <label class="compact-label">Phone
          <input data-order-phone type="text" value="${escapeHtml(order.customerPhone)}">
        </label>
      </td>
      <td>
        <label class="compact-label">Items
          <textarea data-order-items rows="4" placeholder="Item name | qty | price">${escapeHtml(formatOrderItemsForEdit(order.items || []))}</textarea>
        </label>
      </td>
      <td>
        <div class="amount-edit-grid">
          <label class="compact-label">Subtotal
            <input data-order-subtotal type="number" min="0" step="0.01" value="${Number(order.subtotal || 0)}">
          </label>
          <label class="compact-label">Discount
            <input data-order-discount type="number" min="0" step="0.01" value="${Number(order.discount || 0)}">
          </label>
          <label class="compact-label">Tax
            <input data-order-tax type="number" min="0" step="0.01" value="${Number(order.tax || 0)}">
          </label>
          <label class="compact-label">Total
            <input data-order-total type="number" min="0" step="0.01" value="${Number(order.total || 0)}">
          </label>
        </div>
      </td>
      <td>${escapeHtml(formatDate(order.updatedAt || order.savedAt || order.createdAt))}</td>
      <td class="row-actions">
        <button type="button" class="small-button" data-save-order="${escapeHtml(order.receiptNumber)}">Save</button>
        <button type="button" class="small-button secondary" data-cancel-order="${escapeHtml(order.receiptNumber)}">Cancel</button>
      </td>
    </tr>
  `;
}

function formatOrderItemsForEdit(items) {
  return items.map((item) => `${item.name} | ${Number(item.qty || 0)} | ${Number(item.price || 0)}`).join("\n");
}

function parseOrderItemLine(line) {
  const parts = line.split("|").map((part) => part.trim());
  const name = parts[0] || "";
  const qty = Number(parts[1] || 1);
  const price = Number(parts[2] || 0);
  return {
    name,
    qty,
    price,
    total: qty * price
  };
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

function cssEscape(value) {
  if (window.CSS && CSS.escape) {
    return CSS.escape(String(value));
  }
  return String(value).replaceAll('"', '\\"');
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
