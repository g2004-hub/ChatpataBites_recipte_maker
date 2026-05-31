const billPreview = document.querySelector("#billPreview");
const billMessage = document.querySelector("#billMessage");
let currentLinkDetails = null;

initBill();

async function initBill() {
  const linkDetails = parseBillPath();
  if (!linkDetails) {
    showBillError("Invalid bill link.");
    return;
  }

  try {
    const response = await fetch(`/api/bills/${encodeURIComponent(linkDetails.receiptNumber)}?token=${encodeURIComponent(linkDetails.token)}`);
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not load this bill.");
    }

    currentLinkDetails = linkDetails;
    renderBill(result.order, result.upi, linkDetails);
    startPaymentStatusPolling();
  } catch (error) {
    showBillError(error.message);
  }
}

function parseBillPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "bill") {
    return null;
  }

  return {
    receiptNumber: decodeURIComponent(parts[1]),
    token: decodeURIComponent(parts[2])
  };
}

function renderBill(order, upi, linkDetails) {
  const itemLines = order.items.length
    ? order.items.map((item) => `
      <div class="receipt-line">
        <span>${escapeHtml(item.name)}<small>${Number(item.qty || 0)} x ${money(item.price, order.currencySymbol)}</small></span>
        <strong>${money(item.total, order.currencySymbol)}</strong>
      </div>
    `).join("")
    : `<div class="receipt-line"><span>No items added</span><strong>${money(0, order.currencySymbol)}</strong></div>`;

  const qrUrl = `/api/bills/${encodeURIComponent(linkDetails.receiptNumber)}/qr?token=${encodeURIComponent(linkDetails.token)}`;
  const isCash = order.paymentMode === "cash";
  const paymentSection = isCash
    ? `
      <section class="payment-box paid" aria-label="Payment status">
        <h3>Payment received by cash</h3>
        <p class="payment-status success">Thank you. Your payment is complete.</p>
      </section>
    `
    : `
      <section class="payment-box" aria-label="Online payment">
        <h3>Online payment</h3>
        <p>UPI ID: <strong>${escapeHtml(upi.id)}</strong></p>
        <img class="upi-qr" src="${qrUrl}" alt="UPI QR for ${money(order.total, order.currencySymbol)}">
        <a class="pay-button" href="${escapeHtml(upi.payUrl)}">Pay with UPI app</a>
        <p class="receipt-note">Payment amount is fixed to this bill total: ${money(order.total, order.currencySymbol)}.</p>
        <div id="paymentStatusBox" class="payment-status waiting">Waiting for payment...</div>
      </section>
    `;

  billPreview.innerHTML = `
    <div class="receipt-head">
      <h2>${escapeHtml(order.businessName || "Chatpata Bites")}</h2>
      <div>${escapeHtml(order.businessPhone || "")}</div>
    </div>
    <div class="receipt-meta"><span>Receipt</span><strong>${escapeHtml(order.receiptNumber || "-")}</strong></div>
    <div class="receipt-meta"><span>Date</span><span>${escapeHtml(formatDate(order.updatedAt || order.savedAt || order.createdAt))}</span></div>
    <div class="receipt-meta"><span>Customer</span><span>${escapeHtml(order.customerName || "-")}</span></div>
    <div class="receipt-meta"><span>Payment</span><span>${isCash ? "Cash" : "Online UPI"}</span></div>
    <div class="receipt-items">${itemLines}</div>
    <div class="receipt-total-line"><span>Subtotal</span><span>${money(order.subtotal, order.currencySymbol)}</span></div>
    <div class="receipt-total-line"><span>Discount</span><span>-${money(order.discount, order.currencySymbol)}</span></div>
    <div class="receipt-total-line"><span>Tax</span><span>${money(order.tax, order.currencySymbol)}</span></div>
    <div class="receipt-total-line final"><span>Total</span><span>${money(order.total, order.currencySymbol)}</span></div>

    ${paymentSection}

    <p class="receipt-note">Thank you for your order. For any query kindly contact ${escapeHtml(order.businessPhone || "us")}.</p>
  `;
}

function startPaymentStatusPolling() {
  if (!currentLinkDetails) {
    return;
  }
  refreshPaymentStatus();
  window.setInterval(refreshPaymentStatus, 5000);
}

async function refreshPaymentStatus() {
  const statusBox = document.querySelector("#paymentStatusBox");
  if (!statusBox || !currentLinkDetails) {
    return;
  }

  try {
    const response = await fetch(`/api/bills/${encodeURIComponent(currentLinkDetails.receiptNumber)}/status?token=${encodeURIComponent(currentLinkDetails.token)}`);
    const result = await response.json();
    if (!response.ok) {
      return;
    }

    const labels = {
      unpaid: "Waiting for payment...",
      payment_detected: "Payment detected. Thank you.",
      paid_confirmed: "Payment confirmed. Thank you.",
      needs_review: "Payment needs review. Please contact the shop.",
      cash_paid: "Cash payment received. Thank you."
    };
    const isDone = ["payment_detected", "paid_confirmed", "cash_paid"].includes(result.paymentStatus);
    statusBox.className = `payment-status ${isDone ? "success" : result.paymentStatus === "needs_review" ? "review" : "waiting"}`;
    statusBox.textContent = labels[result.paymentStatus] || "Payment not detected yet.";
  } catch {
    statusBox.textContent = "Payment status is checking...";
  }
}

function showBillError(message) {
  billPreview.innerHTML = "";
  billMessage.hidden = false;
  billMessage.className = "message-box error";
  billMessage.textContent = message;
}

function money(amount, symbol = "\u20B9") {
  return `${symbol}${Number(amount || 0).toFixed(2)}`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || "" : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
