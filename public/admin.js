const adminForm = document.querySelector("#adminLogin");
const adminPassword = document.querySelector("#adminPassword");
const ordersView = document.querySelector("#ordersView");
const messageBox = document.querySelector("#messageBox");

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadOrders();
});

async function loadOrders() {
  showMessage("", "");
  const password = adminPassword.value;
  const response = await fetch(`/api/admin/orders?password=${encodeURIComponent(password)}`);
  const result = await response.json();

  if (!response.ok) {
    ordersView.innerHTML = "";
    showMessage(result.error || "Could not load orders.", "error");
    return;
  }

  renderOrders(result.orders || []);
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
