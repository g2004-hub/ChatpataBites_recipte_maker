const state = {
  currencySymbol: "\u20B9",
  config: {},
  menu: [
    "Lacha paratha egg roll",
    "Plain egg roll",
    "Omlette",
    "Bread omlette",
    "Chicken pakoda",
    "Chicken stick",
    "Chicken 65",
    "Chicken popcorn",
    "Chicken Manchurian gravy",
    "Chicken kasa desi style",
    "Chicken berger",
    "Egg chawmin",
    "Our special chicken biryani",
    "Bali prawn stick",
    "Crab masala"
  ]
};

const form = document.querySelector("#orderForm");
const itemsList = document.querySelector("#itemsList");
const itemTemplate = document.querySelector("#itemTemplate");
const grandTotal = document.querySelector("#grandTotal");
const receiptPreview = document.querySelector("#receiptPreview");
const smsStatus = document.querySelector("#smsStatus");
const messageBox = document.querySelector("#messageBox");

const fields = {
  businessName: document.querySelector("#businessName"),
  businessPhone: document.querySelector("#businessPhone"),
  customerName: document.querySelector("#customerName"),
  customerPhone: document.querySelector("#customerPhone"),
  receiptNumber: document.querySelector("#receiptNumber"),
  googleReviewLink: document.querySelector("#googleReviewLink"),
  discount: document.querySelector("#discount"),
  tax: document.querySelector("#tax")
};

init();

async function init() {
  await loadConfig();
  loadDraft();

  if (itemsList.children.length === 0) {
    addItemRow({ name: "", qty: 1, price: 0 });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveDraft();
    renderReceipt();
    await saveOrderWithNotice();
  });

  document.querySelector("#addItem").addEventListener("click", () => {
    addItemRow({ name: "", qty: 1, price: 0 });
    updateTotals();
  });

  document.querySelector("#printReceipt").addEventListener("click", async () => {
    saveDraft();
    renderReceipt();
    await saveOrderWithNotice(false);
    window.print();
  });

  document.querySelector("#sendReview").addEventListener("click", sendReviewSms);
  document.querySelector("#newOrder").addEventListener("click", startNewOrder);

  form.addEventListener("input", () => {
    saveDraft();
    updateTotals();
    renderReceipt();
  });

  updateTotals();
  renderReceipt();
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    state.config = await response.json();
    state.currencySymbol = state.config.currencySymbol || "\u20B9";

    fields.businessName.value = state.config.businessName || "Your Shop Name";
    fields.businessPhone.value = state.config.businessPhone || "";
    fields.googleReviewLink.value = state.config.googleReviewLink || "";
    fields.receiptNumber.value = createReceiptNumber();

    smsStatus.textContent = state.config.smsConfigured ? "SMS ready" : "SMS setup needed";
    smsStatus.classList.add(state.config.smsConfigured ? "ready" : "needs-setup");
  } catch {
    smsStatus.textContent = "Offline";
    smsStatus.classList.add("needs-setup");
  }
}

function addItemRow(item) {
  const row = itemTemplate.content.firstElementChild.cloneNode(true);
  const select = row.querySelector(".menu-select");
  const name = row.querySelector(".item-name");
  const qty = row.querySelector(".item-qty");
  const price = row.querySelector(".item-price");
  const remove = row.querySelector(".remove-item");

  fillMenuOptions(select);
  name.value = item.name || "";
  qty.value = item.qty || 1;
  price.value = item.price || 0;
  applyMenuSelection(row, item.name || "", item.price || 0);

  select.addEventListener("change", () => {
    if (select.value) {
      name.value = select.value;
      price.value = "";
    } else {
      name.value = "";
      price.value = 0;
    }
    saveDraft();
    updateTotals();
    renderReceipt();
  });

  remove.addEventListener("click", () => {
    if (itemsList.children.length > 1) {
      row.remove();
      saveDraft();
      updateTotals();
      renderReceipt();
    }
  });

  itemsList.appendChild(row);
}

function fillMenuOptions(select) {
  select.innerHTML = [
    `<option value="">Custom item</option>`,
    ...state.menu.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
  ].join("");
}

function applyMenuSelection(row, itemName, itemPrice) {
  const select = row.querySelector(".menu-select");
  const name = row.querySelector(".item-name");
  const matched = state.menu.find((item) => item === itemName);

  if (matched) {
    select.value = matched;
  } else {
    select.value = "";
  }
}

function getOrder() {
  const items = [...itemsList.querySelectorAll(".item-entry")].map((row) => {
    const name = row.querySelector(".item-name").value.trim();
    const qty = Number(row.querySelector(".item-qty").value || 0);
    const price = Number(row.querySelector(".item-price").value || 0);
    return {
      name,
      qty,
      price,
      total: qty * price
    };
  }).filter((item) => item.name || item.total > 0);

  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const discount = Number(fields.discount.value || 0);
  const tax = Number(fields.tax.value || 0);
  const total = Math.max(subtotal - discount + tax, 0);

  return {
    businessName: fields.businessName.value.trim(),
    businessPhone: fields.businessPhone.value.trim(),
    customerName: fields.customerName.value.trim(),
    customerPhone: fields.customerPhone.value.trim(),
    receiptNumber: fields.receiptNumber.value.trim(),
    googleReviewLink: fields.googleReviewLink.value.trim(),
    items,
    subtotal,
    discount,
    tax,
    total,
    createdAt: new Date().toLocaleString()
  };
}

function updateTotals() {
  const order = getOrder();
  grandTotal.textContent = money(order.total);

  itemsList.querySelectorAll(".item-entry").forEach((row) => {
    const qty = Number(row.querySelector(".item-qty").value || 0);
    const price = Number(row.querySelector(".item-price").value || 0);
    row.querySelector(".item-total").textContent = money(qty * price);
  });
}

function renderReceipt() {
  const order = getOrder();
  const itemLines = order.items.length
    ? order.items.map((item) => `
      <div class="receipt-line">
        <span>${escapeHtml(item.name)}<small>${item.qty} x ${money(item.price)}</small></span>
        <strong>${money(item.total)}</strong>
      </div>
    `).join("")
    : `<div class="receipt-line"><span>No items added</span><strong>${money(0)}</strong></div>`;

  receiptPreview.innerHTML = `
    <div class="receipt-head">
      <h2>${escapeHtml(order.businessName || "Your Shop Name")}</h2>
      <div>${escapeHtml(order.businessPhone || "")}</div>
    </div>
    <div class="receipt-meta"><span>Receipt</span><strong>${escapeHtml(order.receiptNumber || "-")}</strong></div>
    <div class="receipt-meta"><span>Date</span><span>${escapeHtml(order.createdAt)}</span></div>
    <div class="receipt-meta"><span>Customer</span><span>${escapeHtml(order.customerName || "-")}</span></div>
    <div class="receipt-items">${itemLines}</div>
    <div class="receipt-total-line"><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
    <div class="receipt-total-line"><span>Discount</span><span>-${money(order.discount)}</span></div>
    <div class="receipt-total-line"><span>Tax</span><span>${money(order.tax)}</span></div>
    <div class="receipt-total-line final"><span>Total</span><span>${money(order.total)}</span></div>
    <p class="receipt-note">Thank you for your order. For any queries kindly contact ${escapeHtml(order.businessPhone || "us")}.</p>
  `;
}

async function sendReviewSms() {
  const order = getOrder();

  if (!order.customerName || !order.customerPhone || !order.receiptNumber) {
    showMessage("Add customer name, phone, and receipt number before sending SMS.", "error");
    return;
  }

  if (!order.googleReviewLink) {
    showMessage("Add your Google review link before sending SMS.", "error");
    return;
  }

  const button = document.querySelector("#sendReview");
  button.disabled = true;
  button.textContent = "Sending...";

  try {
    showMessage("", "");
    await saveOrder();
    const response = await fetch("/api/send-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessName: order.businessName,
        businessPhone: order.businessPhone,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        receiptNumber: order.receiptNumber,
        total: order.total,
        currencySymbol: state.currencySymbol,
        googleReviewLink: order.googleReviewLink
      })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(formatSmsError(result));
    }

    showMessage(`Review SMS sent to ${result.phoneNumber}. Order saved.`, "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Send review SMS";
  }
}

async function saveOrderWithNotice(showSuccess = true) {
  try {
    await saveOrder();
    if (showSuccess) {
      showMessage("Order saved to admin history.", "success");
    }
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function saveOrder() {
  const order = getOrder();
  if (!order.customerName || !order.customerPhone || !order.items.length) {
    throw new Error("Add customer name, phone, and at least one item before saving.");
  }

  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "Could not save order.");
  }
}

function startNewOrder() {
  localStorage.removeItem("receipt-maker-draft");
  fields.customerName.value = "";
  fields.customerPhone.value = "";
  fields.receiptNumber.value = createReceiptNumber();
  fields.discount.value = 0;
  fields.tax.value = 0;
  itemsList.innerHTML = "";
  addItemRow({ name: "", qty: 1, price: 0 });
  updateTotals();
  renderReceipt();
  showMessage("New order started with a new receipt number.", "success");
}

function formatSmsError(result) {
  const lines = [result.error || "SMS failed"];
  if (result.details) {
    lines.push(typeof result.details === "string"
      ? result.details
      : JSON.stringify(result.details, null, 2));
  }
  return lines.join("\n\n");
}

function showMessage(message, type) {
  messageBox.hidden = !message;
  messageBox.className = type ? `message-box ${type}` : "message-box";
  messageBox.textContent = message;
}

function saveDraft() {
  localStorage.setItem("receipt-maker-draft", JSON.stringify(getOrder()));
}

function loadDraft() {
  const rawDraft = localStorage.getItem("receipt-maker-draft");
  if (!rawDraft) {
    return;
  }

  try {
    const draft = JSON.parse(rawDraft);
    fields.businessName.value = draft.businessName || fields.businessName.value;
    fields.businessPhone.value = draft.businessPhone || fields.businessPhone.value;
    fields.customerName.value = draft.customerName || "";
    fields.customerPhone.value = draft.customerPhone || "";
    fields.receiptNumber.value = draft.receiptNumber || fields.receiptNumber.value;
    fields.googleReviewLink.value = draft.googleReviewLink || fields.googleReviewLink.value;
    fields.discount.value = draft.discount || 0;
    fields.tax.value = draft.tax || 0;
    itemsList.innerHTML = "";
    (draft.items || []).forEach(addItemRow);
  } catch {
    localStorage.removeItem("receipt-maker-draft");
  }
}

function createReceiptNumber() {
  const datePart = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `R-${datePart}-${randomPart}`;
}

function money(amount) {
  return `${state.currencySymbol}${Number(amount || 0).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
