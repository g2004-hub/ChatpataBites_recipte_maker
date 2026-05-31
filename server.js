const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const QRCode = require("qrcode");

loadEnvFile();

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const ordersPath = path.join(dataDir, "orders.json");
const scheduledReviewsPath = path.join(dataDir, "scheduled-review-messages.json");
const incomingSmsPath = path.join(dataDir, "incoming-payment-sms.json");
const gmailTokenPath = path.join(dataDir, "gmail-oauth-token.json");
const processedGmailPath = path.join(dataDir, "processed-gmail-messages.json");
const incomingEmailPath = path.join(dataDir, "incoming-payment-emails.json");
const port = Number(process.env.PORT || 3000);
const upiId = "chatpatabites@slc";
const reviewDelayMs = 10 * 60 * 1000;
const reviewRetryDelayMs = 5 * 60 * 1000;
const maxReviewAttempts = 3;
const paymentMatchWindowMs = 2 * 60 * 60 * 1000;
const paymentStatuses = {
  unpaid: "unpaid",
  cash: "cash_paid",
  detected: "payment_detected",
  review: "needs_review",
  paid: "paid_confirmed"
};
const paymentModes = {
  cash: "cash",
  online: "online"
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && requestUrl.pathname === "/api/config") {
      return sendJson(res, 200, {
        businessName: process.env.BUSINESS_NAME || "Your Shop Name",
        businessPhone: process.env.BUSINESS_PHONE || "",
        currencySymbol: process.env.CURRENCY_SYMBOL || "\u20B9",
        googleReviewLink: process.env.GOOGLE_REVIEW_LINK || "",
        smsConfigured: getSmsConfig().ok,
        storageMode: getSupabaseConfig().ok ? "supabase" : "local"
      });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/send-review") {
      const body = await readJson(req);
      return handleSendReview(body, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/send-bill") {
      const body = await readJson(req);
      return handleSendBill(body, req, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/bill-link") {
      const body = await readJson(req);
      return handleCreateBillLink(body, req, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/smsgate/incoming") {
      const rawBody = await readRawBody(req);
      return handleSmsGateIncoming(rawBody, req, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/orders") {
      const body = await readJson(req);
      return handleSaveOrder(body, res);
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/bills/")) {
      return handlePublicBillRequest(requestUrl, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/orders") {
      return handleAdminOrders(requestUrl, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/overview") {
      return handleAdminOverview(requestUrl, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/gmail/connect-url") {
      return handleGmailConnectUrl(requestUrl, req, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/gmail/callback") {
      return handleGmailCallback(requestUrl, req, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/gmail/status") {
      return handleGmailStatus(requestUrl, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/admin/gmail/disconnect") {
      const body = await readJson(req);
      return handleGmailDisconnect(body, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/admin/supplier-records") {
      const body = await readJson(req);
      return handleSaveSupplierRecord(body, res);
    }

    if (req.method === "PUT" && requestUrl.pathname.startsWith("/api/admin/supplier-records/")) {
      const body = await readJson(req);
      const id = decodeURIComponent(requestUrl.pathname.replace("/api/admin/supplier-records/", ""));
      return handleUpdateSupplierRecord(id, body, res);
    }

    if (req.method === "PUT" && requestUrl.pathname.startsWith("/api/admin/orders/")) {
      const body = await readJson(req);
      const receiptNumber = decodeURIComponent(requestUrl.pathname.replace("/api/admin/orders/", ""));
      return handleUpdateAdminOrder(receiptNumber, body, res);
    }

    if (req.method === "POST" && requestUrl.pathname.startsWith("/api/admin/payment-status/")) {
      const body = await readJson(req);
      const receiptNumber = decodeURIComponent(requestUrl.pathname.replace("/api/admin/payment-status/", ""));
      return handleAdminPaymentStatus(receiptNumber, body, res);
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    if (requestUrl.pathname.startsWith("/bill/")) {
      return serveStatic("/bill.html", res);
    }

    return serveStatic(requestUrl.pathname, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "Something went wrong on the server." });
  }
});

server.listen(port, () => {
  console.log(`Receipt maker running at http://localhost:${port}`);
});

setInterval(() => {
  processScheduledReviews().catch((error) => {
    console.error("Scheduled review worker failed:", error);
  });
}, 60 * 1000);
processScheduledReviews().catch((error) => {
  console.error("Scheduled review worker failed:", error);
});

setInterval(() => {
  processGmailPayments().catch((error) => {
    console.error("Gmail payment worker failed:", error);
  });
}, 2 * 60 * 1000);
processGmailPayments().catch((error) => {
  console.error("Gmail payment worker failed:", error);
});

async function handleSendReview(body, res) {
  const requiredFields = ["customerName", "customerPhone", "receiptNumber", "total"];
  const missing = requiredFields.filter((field) => !body[field]);

  if (missing.length > 0) {
    return sendJson(res, 400, { error: `Missing required fields: ${missing.join(", ")}` });
  }

  const googleReviewLink = body.googleReviewLink || process.env.GOOGLE_REVIEW_LINK;
  if (!googleReviewLink) {
    return sendJson(res, 400, { error: "Google review link is not configured." });
  }

  const smsConfig = getSmsConfig();
  if (!smsConfig.ok) {
    return sendJson(res, 400, { error: smsConfig.error });
  }

  const normalizedPhone = normalizePhoneNumber(body.customerPhone);
  if (!normalizedPhone) {
    return sendJson(res, 400, {
      error: "Customer phone number is invalid. Use a 10 digit Indian number or +91 format."
    });
  }

  const message = buildReviewMessage({
    businessName: body.businessName || process.env.BUSINESS_NAME || "our shop",
    businessPhone: body.businessPhone || process.env.BUSINESS_PHONE || "",
    customerName: body.customerName,
    receiptNumber: body.receiptNumber,
    total: body.total,
    currencySymbol: body.currencySymbol || process.env.CURRENCY_SYMBOL || "\u20B9",
    googleReviewLink
  });

  try {
    const result = await sendSms(normalizedPhone, message, smsConfig);
    return sendJson(res, 200, {
      ok: true,
      message,
      phoneNumber: normalizedPhone,
      gatewayResponse: result.gatewayResponse
    });
  } catch (error) {
    writeSmsErrorLog(error.details || { error: error.message });
    return sendJson(res, error.status || 500, {
      error: error.message || "SMSGate rejected the message.",
      details: error.details
    });
  }
}

function buildReviewMessage(details) {
  return [
    `Hi ${details.customerName}, thank you for your order at ${details.businessName}.`,
    `Receipt ${details.receiptNumber}: ${details.currencySymbol}${Number(details.total).toFixed(2)}.`,
    `Please review us here: ${details.googleReviewLink}`,
    `For any queries kindly contact ${details.businessPhone || process.env.BUSINESS_PHONE || "us"}.`
  ].join(" ");
}

async function handleSendBill(body, req, res) {
  const order = sanitizeOrder(body);
  const validationError = validateBillOrder(order);
  if (validationError) {
    return sendJson(res, 400, { error: validationError });
  }

  const googleReviewLink = order.googleReviewLink || process.env.GOOGLE_REVIEW_LINK || "";
  if (!googleReviewLink) {
    return sendJson(res, 400, { error: "Google review link is required before sending the bill." });
  }

  const smsConfig = getSmsConfig();
  if (!smsConfig.ok) {
    return sendJson(res, 400, { error: smsConfig.error });
  }

  const normalizedPhone = normalizePhoneNumber(order.customerPhone);
  if (!normalizedPhone) {
    return sendJson(res, 400, {
      error: "Customer phone number is invalid. Use a 10 digit Indian number or +91 format."
    });
  }

  await saveOrderRecord(order);
  const billUrl = buildBillUrl(req, order.receiptNumber);
  const message = buildBillMessage(order, billUrl);

  try {
    const smsResult = await sendSms(normalizedPhone, message, smsConfig);
    const scheduledAt = new Date(Date.now() + reviewDelayMs).toISOString();
    await scheduleReviewMessage({
      receiptNumber: order.receiptNumber,
      customerName: order.customerName,
      customerPhone: normalizedPhone,
      businessName: order.businessName || process.env.BUSINESS_NAME || "Chatpata Bites",
      businessPhone: order.businessPhone || process.env.BUSINESS_PHONE || "",
      googleReviewLink,
      scheduledAt
    });

    return sendJson(res, 200, {
      ok: true,
      billUrl,
      phoneNumber: normalizedPhone,
      reviewScheduledAt: scheduledAt,
      gatewayResponse: smsResult.gatewayResponse
    });
  } catch (error) {
    writeSmsErrorLog(error.details || { error: error.message });
    return sendJson(res, error.status || 500, {
      error: error.message || "Could not send bill SMS.",
      details: error.details
    });
  }
}

async function handleCreateBillLink(body, req, res) {
  const order = sanitizeOrder(body);
  const validationError = validateBillOrder(order);
  if (validationError) {
    return sendJson(res, 400, { error: validationError });
  }

  await saveOrderRecord(order);
  const billUrl = buildBillUrl(req, order.receiptNumber);
  return sendJson(res, 200, {
    ok: true,
    billUrl,
    whatsappUrl: buildWhatsAppUrl(order, billUrl)
  });
}

async function handleSmsGateIncoming(rawBody, req, res) {
  if (!isValidSmsGateWebhook(rawBody, req)) {
    return sendJson(res, 401, { error: "Invalid webhook signature." });
  }

  let webhook;
  try {
    webhook = JSON.parse(rawBody || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid webhook JSON." });
  }

  if (webhook.event !== "sms:received") {
    return sendJson(res, 200, { ok: true, ignored: true });
  }

  const payload = webhook.payload || {};
  const smsText = String(payload.message || "");
  const parsedPayment = await parsePaymentSms(smsText, {
    sender: payload.sender || payload.phoneNumber || "",
    receivedAt: payload.receivedAt || new Date().toISOString()
  });

  const smsRecord = {
    id: webhook.id || payload.messageId || `sms-${Date.now()}`,
    messageId: payload.messageId || "",
    sender: payload.sender || payload.phoneNumber || "",
    recipient: payload.recipient || "",
    receivedAt: payload.receivedAt || new Date().toISOString(),
    message: smsText,
    parsed: parsedPayment,
    matchStatus: "ignored",
    matchedReceiptNumber: "",
    createdAt: new Date().toISOString()
  };

  if (parsedPayment.isPaymentCredit && parsedPayment.amount > 0) {
    const matchResult = await matchIncomingPayment(parsedPayment, smsRecord);
    smsRecord.matchStatus = matchResult.matchStatus;
    smsRecord.matchedReceiptNumber = matchResult.receiptNumber || "";
  }

  await writeIncomingSmsRecord(smsRecord);
  return sendJson(res, 200, {
    ok: true,
    parsed: parsedPayment,
    matchStatus: smsRecord.matchStatus,
    receiptNumber: smsRecord.matchedReceiptNumber
  });
}

async function handleGmailConnectUrl(requestUrl, req, res) {
  if (!isValidAdminRequest(requestUrl)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  const config = getGmailConfig(req);
  if (!config.ok) {
    return sendJson(res, 400, { error: config.error });
  }

  const state = createGmailOAuthState();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", config.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.readonly");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);

  return sendJson(res, 200, { ok: true, authUrl: authUrl.toString() });
}

async function handleGmailCallback(requestUrl, req, res) {
  const code = requestUrl.searchParams.get("code") || "";
  const state = requestUrl.searchParams.get("state") || "";
  const config = getGmailConfig(req);

  if (!config.ok || !code || !isValidGmailOAuthState(state)) {
    return sendHtml(res, 400, "<h1>Gmail connection failed</h1><p>Invalid OAuth response.</p>");
  }

  try {
    const tokenResponse = await exchangeGmailCode(code, config);
    const profile = await getGmailProfile(tokenResponse.access_token);
    await writeGmailToken({
      email: profile.emailAddress || "",
      refreshToken: tokenResponse.refresh_token,
      accessToken: tokenResponse.access_token,
      expiresAt: new Date(Date.now() + Number(tokenResponse.expires_in || 3600) * 1000).toISOString(),
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    return sendHtml(res, 200, "<h1>Gmail connected</h1><p>You can close this tab and return to the admin panel.</p>");
  } catch (error) {
    console.error(error);
    return sendHtml(res, 500, "<h1>Gmail connection failed</h1><p>Could not save Gmail access.</p>");
  }
}

async function handleGmailStatus(requestUrl, res) {
  if (!isValidAdminRequest(requestUrl)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  const token = await readGmailToken();
  return sendJson(res, 200, {
    ok: true,
    connected: Boolean(token && token.refreshToken),
    email: token?.email || "",
    connectedAt: token?.connectedAt || "",
    query: getGmailSearchQuery()
  });
}

async function handleGmailDisconnect(body, res) {
  if (!isValidAdminPassword(body.adminPassword)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  await deleteGmailToken();
  return sendJson(res, 200, { ok: true });
}

async function handlePublicBillRequest(requestUrl, res) {
  const parts = requestUrl.pathname.split("/").filter(Boolean);
  const receiptNumber = decodeURIComponent(parts[2] || "");
  const token = requestUrl.searchParams.get("token") || "";

  if (!receiptNumber || !isValidBillToken(receiptNumber, token)) {
    return sendJson(res, 404, { error: "Invalid or expired bill link." });
  }

  const order = await findOrderByReceipt(receiptNumber);
  if (!order) {
    return sendJson(res, 404, { error: "Bill not found." });
  }

  if (parts[3] === "status") {
    return sendJson(res, 200, {
      paymentMode: order.paymentMode || paymentModes.online,
      paymentStatus: order.paymentStatus || paymentStatuses.unpaid,
      paymentDetectedAt: order.paymentDetectedAt || "",
      paymentConfirmedAt: order.paymentConfirmedAt || "",
      paymentMatchNote: order.paymentMatchNote || ""
    });
  }

  if (parts[3] === "qr") {
    return sendBillQr(res, order);
  }

  return sendJson(res, 200, {
    order: publicOrder(order),
    upi: {
      id: upiId,
      payUrl: buildUpiUrl(order)
    }
  });
}

async function handleSaveOrder(body, res) {
  const order = sanitizeOrder(body);
  if (!order.receiptNumber || !order.customerName || !order.customerPhone || !order.items.length) {
    return sendJson(res, 400, { error: "Order needs receipt number, customer, phone, and at least one item." });
  }

  const result = await saveOrderRecord(order);
  return sendJson(res, 200, { ok: true, count: result.count });
}

async function handleAdminOrders(requestUrl, res) {
  if (!isValidAdminRequest(requestUrl)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  return sendJson(res, 200, { orders: await readOrders() });
}

async function handleAdminOverview(requestUrl, res) {
  if (!isValidAdminRequest(requestUrl)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  const month = requestUrl.searchParams.get("month") || new Date().toISOString().slice(0, 7);
  const orders = await readOrders();
  const supplierRecords = await readSupplierRecords();
  const monthOrders = orders.filter((order) => getMonthKey(order.updatedAt || order.savedAt || order.createdAt) === month);
  const monthSupplierRecords = supplierRecords.filter((record) => getMonthKey(record.transactionDate || record.createdAt) === month);

  const dailyMap = new Map();
  for (const order of monthOrders) {
    const dateKey = getDateKey(order.updatedAt || order.savedAt || order.createdAt);
    const row = dailyMap.get(dateKey) || { date: dateKey, sales: 0, supplierPaid: 0, supplierDue: 0, orders: 0 };
    row.sales += Number(order.total || 0);
    row.orders += 1;
    dailyMap.set(dateKey, row);
  }

  for (const record of monthSupplierRecords) {
    const dateKey = getDateKey(record.transactionDate || record.createdAt);
    const row = dailyMap.get(dateKey) || { date: dateKey, sales: 0, supplierPaid: 0, supplierDue: 0, orders: 0 };
    row.supplierPaid += Number(record.paidAmount || 0);
    row.supplierDue += Number(record.dueAmount || 0);
    dailyMap.set(dateKey, row);
  }

  const turnover = monthOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const supplierPaid = monthSupplierRecords.reduce((sum, record) => sum + Number(record.paidAmount || 0), 0);
  const supplierDue = monthSupplierRecords.reduce((sum, record) => sum + Number(record.dueAmount || 0), 0);

  return sendJson(res, 200, {
    month,
    storageMode: getSupabaseConfig().ok ? "supabase" : "local",
    summary: {
      orders: monthOrders.length,
      turnover,
      supplierPaid,
      supplierDue,
      netAfterSupplierPaid: turnover - supplierPaid
    },
    daily: [...dailyMap.values()].sort((a, b) => b.date.localeCompare(a.date)),
    orders: monthOrders,
    supplierRecords: monthSupplierRecords
  });
}

async function handleSaveSupplierRecord(body, res) {
  if (!isValidAdminPassword(body.adminPassword)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  const record = sanitizeSupplierRecord(body);
  if (!record.supplierName || !record.totalAmount) {
    return sendJson(res, 400, { error: "Supplier name and total amount are required." });
  }

  await writeSupplierRecord(record);
  return sendJson(res, 200, { ok: true, record });
}

async function handleUpdateSupplierRecord(id, body, res) {
  if (!isValidAdminPassword(body.adminPassword)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  const records = await readSupplierRecords();
  const existing = records.find((entry) => String(entry.id) === String(id));
  if (!existing) {
    return sendJson(res, 404, { error: "Supplier record not found." });
  }

  const record = {
    ...sanitizeSupplierRecord({ ...existing, ...body, id: existing.id }),
    id: existing.id,
    createdAt: existing.createdAt || new Date().toISOString()
  };

  if (!record.supplierName || !record.totalAmount) {
    return sendJson(res, 400, { error: "Supplier name and total amount are required." });
  }

  await updateSupplierRecord(record);
  return sendJson(res, 200, { ok: true, record });
}

async function handleUpdateAdminOrder(receiptNumber, body, res) {
  if (!isValidAdminPassword(body.adminPassword)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  const orders = await readOrders();
  const existing = orders.find((entry) => entry.receiptNumber === receiptNumber);
  if (!existing) {
    return sendJson(res, 404, { error: "Sell record not found." });
  }

  const order = sanitizeOrder({
    ...existing,
    ...body,
    receiptNumber: existing.receiptNumber,
    createdAt: existing.createdAt
  });

  if (!order.receiptNumber || !order.customerName || !order.customerPhone || !order.items.length) {
    return sendJson(res, 400, { error: "Sell record needs customer, phone, and at least one item." });
  }

  await writeOrder(order, true);
  return sendJson(res, 200, { ok: true, order });
}

async function handleAdminPaymentStatus(receiptNumber, body, res) {
  if (!isValidAdminPassword(body.adminPassword)) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  const allowedStatuses = new Set([paymentStatuses.unpaid, paymentStatuses.cash, paymentStatuses.detected, paymentStatuses.review, paymentStatuses.paid]);
  const status = String(body.paymentStatus || "");
  if (!allowedStatuses.has(status)) {
    return sendJson(res, 400, { error: "Invalid payment status." });
  }

  const order = await findOrderByReceipt(receiptNumber);
  if (!order) {
    return sendJson(res, 404, { error: "Sell record not found." });
  }

  const updatedOrder = {
    ...order,
    paymentStatus: status,
    paymentConfirmedAt: status === paymentStatuses.paid || status === paymentStatuses.cash ? new Date().toISOString() : "",
    paymentDetectedAt: status === paymentStatuses.unpaid ? "" : order.paymentDetectedAt || "",
    paymentMatchNote: status === paymentStatuses.unpaid ? "" : order.paymentMatchNote || "Updated by admin."
  };

  await updateOrderPaymentStatus(updatedOrder);
  return sendJson(res, 200, { ok: true, order: updatedOrder });
}

function isValidAdminRequest(requestUrl) {
  return isValidAdminPassword(requestUrl.searchParams.get("password") || "");
}

function isValidAdminPassword(password) {
  const expected = process.env.ADMIN_PASSWORD || "ChatpataBites";
  return password === expected;
}

function sanitizeOrder(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    businessName: String(body.businessName || "").trim(),
    businessPhone: String(body.businessPhone || "").trim(),
    customerName: String(body.customerName || "").trim(),
    customerPhone: normalizePhoneNumber(body.customerPhone) || String(body.customerPhone || "").trim(),
    receiptNumber: String(body.receiptNumber || "").trim(),
    googleReviewLink: String(body.googleReviewLink || "").trim(),
    paymentMode: body.paymentMode === paymentModes.cash ? paymentModes.cash : paymentModes.online,
    paymentStatus: String(body.paymentStatus || (body.paymentMode === paymentModes.cash ? paymentStatuses.cash : paymentStatuses.unpaid)),
    paymentDetectedAt: String(body.paymentDetectedAt || ""),
    paymentConfirmedAt: String(body.paymentConfirmedAt || (body.paymentMode === paymentModes.cash ? new Date().toISOString() : "")),
    paymentReference: String(body.paymentReference || ""),
    paymentSource: String(body.paymentSource || (body.paymentMode === paymentModes.cash ? "cash" : "")),
    paymentMatchNote: String(body.paymentMatchNote || (body.paymentMode === paymentModes.cash ? "Cash payment selected at billing." : "")),
    paymentSmsId: String(body.paymentSmsId || ""),
    items: items.map((item) => ({
      name: String(item.name || "").trim(),
      qty: Number(item.qty || 0),
      price: Number(item.price || 0),
      total: Number(item.total || 0)
    })).filter((item) => item.name && item.qty > 0),
    subtotal: Number(body.subtotal || 0),
    discount: Number(body.discount || 0),
    tax: Number(body.tax || 0),
    total: Number(body.total || 0),
    createdAt: String(body.createdAt || new Date().toLocaleString())
  };
}

function sanitizeSupplierRecord(body) {
  const totalAmount = Number(body.totalAmount || 0);
  const paidAmount = Number(body.paidAmount || 0);
  const dueAmount = Math.max(totalAmount - paidAmount, 0);

  return {
    id: body.id || `supplier-${Date.now()}`,
    supplierName: String(body.supplierName || "").trim(),
    itemDetails: String(body.itemDetails || "").trim(),
    totalAmount,
    paidAmount,
    dueAmount,
    paymentStatus: dueAmount === 0 ? "paid" : paidAmount > 0 ? "partial" : "due",
    transactionDate: String(body.transactionDate || new Date().toISOString().slice(0, 10)),
    notes: String(body.notes || "").trim(),
    createdAt: new Date().toISOString()
  };
}

function validateBillOrder(order) {
  if (!order.receiptNumber) {
    return "Receipt number is required.";
  }
  if (!order.customerName || !order.customerPhone) {
    return "Customer name and phone are required.";
  }
  if (!order.items.length) {
    return "Add at least one item before sending the bill.";
  }
  return "";
}

async function saveOrderRecord(order) {
  const orders = await readOrders();
  const existingIndex = orders.findIndex((entry) => entry.receiptNumber === order.receiptNumber);
  await writeOrder(order, existingIndex >= 0);
  return { count: existingIndex >= 0 ? orders.length : orders.length + 1 };
}

async function findOrderByReceipt(receiptNumber) {
  const orders = await readOrders();
  return orders.find((entry) => entry.receiptNumber === receiptNumber);
}

async function readOrders() {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    const rows = await supabaseRequest("/rest/v1/sales_orders?select=*&order=updated_at.desc");
    return rows.map(mapSalesOrderFromDb);
  }

  if (!fs.existsSync(ordersPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(ordersPath, "utf8")));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function writeOrder(order, isUpdate) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    const payload = mapSalesOrderToDb(order);
    await supabaseRequest("/rest/v1/sales_orders?on_conflict=receipt_number", {
      method: "POST",
      headers: {
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(payload)
    });
    return;
  }

  const orders = await readOrders();
  const existingIndex = orders.findIndex((entry) => entry.receiptNumber === order.receiptNumber);
  const now = new Date().toISOString();
  if (existingIndex >= 0 || isUpdate) {
    orders[existingIndex] = { ...orders[existingIndex], ...order, updatedAt: now };
  } else {
    orders.unshift({ ...order, savedAt: now, updatedAt: now });
  }
  writeOrdersLocal(orders);
}

function writeOrdersLocal(orders) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
}

async function readSupplierRecords() {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    const rows = await supabaseRequest("/rest/v1/supplier_records?select=*&order=transaction_date.desc");
    return rows.map(mapSupplierRecordFromDb);
  }

  const localPath = path.join(dataDir, "supplier-records.json");
  if (!fs.existsSync(localPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(localPath, "utf8")));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function writeSupplierRecord(record) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest("/rest/v1/supplier_records", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify(mapSupplierRecordToDb(record))
    });
    return;
  }

  const localPath = path.join(dataDir, "supplier-records.json");
  const records = await readSupplierRecords();
  records.unshift(record);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify(records, null, 2));
}

async function updateOrderPaymentStatus(order) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest(`/rest/v1/sales_orders?receipt_number=eq.${encodeURIComponent(order.receiptNumber)}`, {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({
        payment_status: order.paymentStatus || paymentStatuses.unpaid,
        payment_detected_at: order.paymentDetectedAt || null,
        payment_confirmed_at: order.paymentConfirmedAt || null,
        payment_reference: order.paymentReference || null,
        payment_source: order.paymentSource || null,
        payment_match_note: order.paymentMatchNote || null,
        payment_sms_id: order.paymentSmsId || null,
        updated_at: new Date().toISOString()
      })
    });
    return;
  }

  const orders = await readOrders();
  const index = orders.findIndex((entry) => entry.receiptNumber === order.receiptNumber);
  if (index === -1) {
    throw new Error("Sell record not found.");
  }

  orders[index] = { ...orders[index], ...order, updatedAt: new Date().toISOString() };
  writeOrdersLocal(orders);
}

async function updateSupplierRecord(record) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest(`/rest/v1/supplier_records?id=eq.${encodeURIComponent(record.id)}`, {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify(mapSupplierRecordToDb(record))
    });
    return;
  }

  const localPath = path.join(dataDir, "supplier-records.json");
  const records = await readSupplierRecords();
  const index = records.findIndex((entry) => String(entry.id) === String(record.id));
  if (index === -1) {
    throw new Error("Supplier record not found.");
  }
  records[index] = { ...records[index], ...record };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify(records, null, 2));
}

function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return {
    ok: Boolean(url && key),
    url,
    key
  };
}

async function supabaseRequest(pathname, options = {}) {
  const supabase = getSupabaseConfig();
  const response = await fetch(`${supabase.url}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "apikey": supabase.key,
      "Authorization": `Bearer ${supabase.key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed: ${response.status} ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function sendSms(phoneNumber, message, smsConfig = getSmsConfig()) {
  if (!smsConfig.ok) {
    throw new Error(smsConfig.error);
  }

  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) {
    throw new Error("Customer phone number is invalid. Use a 10 digit Indian number or +91 format.");
  }

  const smsPayload = {
    textMessage: { text: message },
    phoneNumbers: [normalizedPhone],
    simNumber: smsConfig.simNumber,
    ttl: 3600,
    priority: smsConfig.priority
  };

  if (smsConfig.deviceId) {
    smsPayload.deviceId = smsConfig.deviceId;
  }

  const apiUrl = new URL(smsConfig.baseUrl);
  if (smsConfig.skipPhoneValidation) {
    apiUrl.searchParams.set("skipPhoneValidation", "true");
  }
  if (smsConfig.deviceActiveWithin) {
    apiUrl.searchParams.set("deviceActiveWithin", String(smsConfig.deviceActiveWithin));
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${Buffer.from(`${smsConfig.username}:${smsConfig.password}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(smsPayload)
  });

  const responseText = await response.text();
  let responseBody = responseText;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    // Some gateways return plain text. Keep it as-is for troubleshooting.
  }

  if (!response.ok) {
    const error = new Error("SMSGate rejected the message.");
    error.status = response.status;
    error.details = {
      status: response.status,
      statusText: response.statusText,
      response: responseBody,
      sentPayload: {
        textMessage: smsPayload.textMessage,
        phoneNumbers: smsPayload.phoneNumbers,
        deviceId: smsPayload.deviceId,
        simNumber: smsPayload.simNumber,
        ttl: smsPayload.ttl,
        priority: smsPayload.priority
      }
    };
    throw error;
  }

  return {
    phoneNumber: normalizedPhone,
    gatewayResponse: responseBody
  };
}

function buildBillMessage(order, billUrl) {
  const actionText = order.paymentMode === paymentModes.cash ? "View your receipt here" : "View and pay here";
  return [
    `Hi ${order.customerName}, your Chatpata Bites bill is ready.`,
    `Receipt ${order.receiptNumber}: ${process.env.CURRENCY_SYMBOL || "\u20B9"}${Number(order.total).toFixed(2)}.`,
    `${actionText}: ${billUrl}`,
    `For any query contact ${order.businessPhone || process.env.BUSINESS_PHONE || "us"}.`
  ].join(" ");
}

function buildDelayedReviewMessage(message) {
  return [
    `Hi ${message.customerName}, how was the food at Chatpata Bites?`,
    `Please give your review here: ${message.googleReviewLink}.`,
    `For any query contact ${message.businessPhone || process.env.BUSINESS_PHONE || "us"}.`
  ].join(" ");
}

function buildBillUrl(req, receiptNumber) {
  const baseUrl = getPublicBaseUrl(req);
  return `${baseUrl}/bill/${encodeURIComponent(receiptNumber)}/${createBillToken(receiptNumber)}`;
}

function getPublicBaseUrl(req) {
  const configuredUrl = process.env.PUBLIC_BASE_URL || process.env.BILL_BASE_URL;
  if (configuredUrl) {
    return configuredUrl.replace(/\/$/, "");
  }

  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

function createBillToken(receiptNumber) {
  return crypto
    .createHmac("sha256", getBillSecret())
    .update(String(receiptNumber))
    .digest("base64url");
}

function isValidBillToken(receiptNumber, token) {
  if (!token) {
    return false;
  }

  const expected = createBillToken(receiptNumber);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(String(token));
  return expectedBuffer.length === tokenBuffer.length && crypto.timingSafeEqual(expectedBuffer, tokenBuffer);
}

function getBillSecret() {
  return process.env.BILL_LINK_SECRET
    || process.env.ADMIN_PASSWORD
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || "ChatpataBites-bill-link-secret";
}

function publicOrder(order) {
  return {
    businessName: order.businessName || process.env.BUSINESS_NAME || "Chatpata Bites",
    businessPhone: order.businessPhone || process.env.BUSINESS_PHONE || "",
    customerName: order.customerName,
    receiptNumber: order.receiptNumber,
    items: order.items || [],
    subtotal: Number(order.subtotal || 0),
    discount: Number(order.discount || 0),
    tax: Number(order.tax || 0),
    total: Number(order.total || 0),
    createdAt: order.createdAt,
    savedAt: order.savedAt,
    updatedAt: order.updatedAt,
    currencySymbol: process.env.CURRENCY_SYMBOL || "\u20B9",
    paymentMode: order.paymentMode || paymentModes.online,
    paymentStatus: order.paymentStatus || paymentStatuses.unpaid
  };
}

function buildUpiUrl(order) {
  const payeeName = order.businessName || process.env.BUSINESS_NAME || "Chatpata Bites";
  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName,
    am: Number(order.total || 0).toFixed(2),
    cu: "INR",
    tn: `Receipt ${order.receiptNumber}`
  });
  return `upi://pay?${params.toString()}`;
}

async function sendBillQr(res, order) {
  if ((order.paymentMode || paymentModes.online) === paymentModes.cash) {
    return sendJson(res, 404, { error: "Cash bills do not have a payment QR." });
  }

  const qrBuffer = await QRCode.toBuffer(buildUpiUrl(order), {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320
  });
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "no-store"
  });
  res.end(qrBuffer);
}

function buildWhatsAppUrl(order, billUrl) {
  const message = buildBillMessage(order, billUrl);
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

function getGmailConfig(req) {
  const fileConfig = readGoogleClientSecretFile();
  const clientId = String(process.env.GOOGLE_CLIENT_ID || fileConfig.clientId || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || fileConfig.clientSecret || "").trim();
  const redirectUri = String(
    process.env.GOOGLE_REDIRECT_URI
    || fileConfig.redirectUris.find((uri) => uri.includes(req?.headers?.host || "localhost:3000"))
    || fileConfig.redirectUris[0]
    || ""
  ).trim();

  if (!clientId || !clientSecret || !redirectUri) {
    return {
      ok: false,
      error: "Google OAuth client is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI."
    };
  }

  return { ok: true, clientId, clientSecret, redirectUri };
}

function readGoogleClientSecretFile() {
  const explicitPath = process.env.GOOGLE_CLIENT_SECRET_FILE;
  const candidatePaths = [
    explicitPath,
    path.join(process.env.USERPROFILE || "", "Downloads", "client_secret_320944108695-qj3ifgs1292737o0n3uja5pd9un6tpni.apps.googleusercontent.com.json")
  ].filter(Boolean);

  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
      const details = parsed.web || parsed.installed;
      if (details?.client_id && details?.client_secret) {
        return {
          clientId: details.client_id,
          clientSecret: details.client_secret,
          redirectUris: details.redirect_uris || []
        };
      }
    } catch {
      // Ignore malformed local OAuth files and fall back to environment variables.
    }
  }

  return { clientId: "", clientSecret: "", redirectUris: [] };
}

function createGmailOAuthState() {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(12).toString("base64url");
  const payload = `${timestamp}.${nonce}`;
  const signature = crypto.createHmac("sha256", getBillSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function isValidGmailOAuthState(state) {
  const parts = String(state || "").split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [timestamp, nonce, signature] = parts;
  const payload = `${timestamp}.${nonce}`;
  const expected = crypto.createHmac("sha256", getBillSecret()).update(payload).digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  const isFresh = Date.now() - Number(timestamp) < 10 * 60 * 1000;
  return isFresh
    && expectedBuffer.length === signatureBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

async function exchangeGmailCode(code, config) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code"
    })
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error_description || result.error || "Gmail OAuth token exchange failed.");
  }
  if (!result.refresh_token) {
    throw new Error("Google did not return a refresh token. Reconnect Gmail and approve offline access.");
  }
  return result;
}

async function refreshGmailAccessToken(token) {
  const config = getGmailConfig();
  if (!config.ok || !token?.refreshToken) {
    return null;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: token.refreshToken,
      grant_type: "refresh_token"
    })
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error_description || result.error || "Could not refresh Gmail access.");
  }

  const updatedToken = {
    ...token,
    accessToken: result.access_token,
    expiresAt: new Date(Date.now() + Number(result.expires_in || 3600) * 1000).toISOString(),
    updatedAt: new Date().toISOString()
  };
  await writeGmailToken(updatedToken);
  return updatedToken;
}

async function getGmailProfile(accessToken) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    return {};
  }
  return response.json();
}

async function processGmailPayments() {
  const token = await readGmailToken();
  if (!token?.refreshToken) {
    return;
  }

  const accessToken = await getValidGmailAccessToken(token);
  if (!accessToken) {
    return;
  }

  const processedIds = await readProcessedGmailMessages();
  const messageIds = await searchGmailMessages(accessToken, getGmailSearchQuery());
  for (const messageId of messageIds) {
    if (processedIds.has(messageId)) {
      continue;
    }

    try {
      const email = await getGmailMessage(accessToken, messageId);
      const allowed = isAllowedPaymentEmail(email.from);
      const parsedPayment = allowed
        ? await parsePaymentEmail(`${email.subject}\n\n${email.text}`, {
          sender: email.from,
          receivedAt: email.receivedAt
        })
        : { isPaymentCredit: false, amount: 0, paymentTime: "", reference: "", payer: "", confidence: 0, reason: "Sender not allowed." };

      const emailRecord = {
        id: messageId,
        from: email.from,
        subject: email.subject,
        receivedAt: email.receivedAt,
        text: email.text,
        parsed: parsedPayment,
        matchStatus: "ignored",
        matchedReceiptNumber: "",
        createdAt: new Date().toISOString()
      };

      if (allowed && parsedPayment.isPaymentCredit && parsedPayment.amount > 0) {
        const matchResult = await matchIncomingPaymentRecord(parsedPayment, {
          id: messageId,
          source: "gmail_gemini",
          receivedAt: email.receivedAt,
          notePrefix: "Payment email"
        });
        emailRecord.matchStatus = matchResult.matchStatus;
        emailRecord.matchedReceiptNumber = matchResult.receiptNumber || "";
      }

      await writeIncomingEmailRecord(emailRecord);
      await writeProcessedGmailMessage(messageId);
    } catch (error) {
      console.error("Gmail message processing failed:", error);
    }
  }
}

async function getValidGmailAccessToken(token) {
  if (token.accessToken && new Date(token.expiresAt).getTime() > Date.now() + 60_000) {
    return token.accessToken;
  }

  const refreshed = await refreshGmailAccessToken(token);
  return refreshed?.accessToken || "";
}

async function searchGmailMessages(accessToken, query) {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "10");
  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Gmail search failed: ${response.status}`);
  }
  const result = await response.json();
  return (result.messages || []).map((message) => message.id);
}

async function getGmailMessage(accessToken, messageId) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Gmail message read failed: ${response.status}`);
  }

  const message = await response.json();
  const headers = Object.fromEntries((message.payload?.headers || []).map((header) => [header.name.toLowerCase(), header.value]));
  return {
    id: message.id,
    from: headers.from || "",
    subject: headers.subject || "",
    receivedAt: new Date(Number(message.internalDate || Date.now())).toISOString(),
    text: extractGmailText(message.payload) || message.snippet || ""
  };
}

function extractGmailText(part) {
  if (!part) {
    return "";
  }
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data).replace(/<[^>]+>/g, " ");
  }
  return (part.parts || []).map(extractGmailText).filter(Boolean).join("\n");
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function getGmailSearchQuery() {
  return process.env.PAYMENT_EMAIL_GMAIL_QUERY || "newer_than:7d (slice OR payment OR credited OR received OR UPI)";
}

function isAllowedPaymentEmail(from) {
  const allowed = String(process.env.PAYMENT_EMAIL_ALLOWED_SENDERS || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) {
    return /slice|bank|upi|payment|pay/i.test(from);
  }
  const normalizedFrom = String(from || "").toLowerCase();
  return allowed.some((entry) => normalizedFrom.includes(entry));
}

async function parsePaymentEmail(message, context = {}) {
  const fallback = parsePaymentSmsFallback(message);
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return fallback;
  }

  try {
    const prompt = [
      "Extract payment-credit details from this Indian payment alert email.",
      "Return only JSON that matches this schema:",
      JSON.stringify({
        isPaymentCredit: "boolean true only if money was credited/received into merchant account",
        amount: "number INR amount credited, 0 if none",
        paymentTime: "ISO timestamp if available, otherwise empty string",
        reference: "UPI reference/UTR/RRN/transaction id if present, otherwise empty string",
        payer: "payer name or VPA if present, otherwise empty string",
        confidence: "number from 0 to 1",
        reason: "short reason"
      }),
      "Do not mark debit, failed, reversal, request, OTP, promotional, or balance-only emails as payment credit.",
      `Sender: ${context.sender || ""}`,
      `Received at: ${context.receivedAt || ""}`,
      `Email: ${message}`
    ].join("\n");

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              isPaymentCredit: { type: "BOOLEAN" },
              amount: { type: "NUMBER" },
              paymentTime: { type: "STRING" },
              reference: { type: "STRING" },
              payer: { type: "STRING" },
              confidence: { type: "NUMBER" },
              reason: { type: "STRING" }
            },
            required: ["isPaymentCredit", "amount", "paymentTime", "reference", "payer", "confidence", "reason"]
          }
        }
      })
    });

    if (!response.ok) {
      return { ...fallback, reason: `${fallback.reason} Gemini email parse failed: ${response.status}` };
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(text);
    return normalizeParsedPayment(parsed, fallback);
  } catch (error) {
    return { ...fallback, reason: `${fallback.reason} Gemini email parse error: ${error.message}` };
  }
}

async function readGmailToken() {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    const rows = await supabaseRequest("/rest/v1/gmail_oauth_tokens?id=eq.default&select=*");
    return rows[0] ? mapGmailTokenFromDb(rows[0]) : null;
  }
  if (!fs.existsSync(gmailTokenPath)) {
    return null;
  }
  try {
    return JSON.parse(stripBom(fs.readFileSync(gmailTokenPath, "utf8")));
  } catch {
    return null;
  }
}

async function writeGmailToken(token) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest("/rest/v1/gmail_oauth_tokens?on_conflict=id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(mapGmailTokenToDb(token))
    });
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(gmailTokenPath, JSON.stringify(token, null, 2));
}

async function deleteGmailToken() {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest("/rest/v1/gmail_oauth_tokens?id=eq.default", { method: "DELETE" });
    return;
  }
  if (fs.existsSync(gmailTokenPath)) {
    fs.unlinkSync(gmailTokenPath);
  }
}

function mapGmailTokenToDb(token) {
  return {
    id: "default",
    email: token.email,
    refresh_token: token.refreshToken,
    access_token: token.accessToken,
    expires_at: token.expiresAt,
    connected_at: token.connectedAt,
    updated_at: token.updatedAt
  };
}

function mapGmailTokenFromDb(row) {
  return {
    email: row.email || "",
    refreshToken: row.refresh_token || "",
    accessToken: row.access_token || "",
    expiresAt: row.expires_at || "",
    connectedAt: row.connected_at || "",
    updatedAt: row.updated_at || ""
  };
}

async function readProcessedGmailMessages() {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    const rows = await supabaseRequest("/rest/v1/processed_gmail_messages?select=message_id");
    return new Set(rows.map((row) => row.message_id));
  }
  if (!fs.existsSync(processedGmailPath)) {
    return new Set();
  }
  try {
    return new Set(JSON.parse(stripBom(fs.readFileSync(processedGmailPath, "utf8"))));
  } catch {
    return new Set();
  }
}

async function writeProcessedGmailMessage(messageId) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest("/rest/v1/processed_gmail_messages?on_conflict=message_id", {
      method: "POST",
      headers: { "Prefer": "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({ message_id: messageId, processed_at: new Date().toISOString() })
    });
    return;
  }
  const processed = await readProcessedGmailMessages();
  processed.add(messageId);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(processedGmailPath, JSON.stringify([...processed].slice(-1000), null, 2));
}

async function writeIncomingEmailRecord(record) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest("/rest/v1/incoming_payment_emails", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify(mapIncomingEmailToDb(record))
    });
    return;
  }
  const records = readIncomingEmailsLocal();
  records.unshift(record);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(incomingEmailPath, JSON.stringify(records.slice(0, 500), null, 2));
}

function readIncomingEmailsLocal() {
  if (!fs.existsSync(incomingEmailPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(incomingEmailPath, "utf8")));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function mapIncomingEmailToDb(record) {
  return {
    id: record.id,
    sender: record.from,
    subject: record.subject,
    received_at: record.receivedAt,
    message: record.text,
    parsed: record.parsed,
    match_status: record.matchStatus,
    matched_receipt_number: record.matchedReceiptNumber || null,
    created_at: record.createdAt
  };
}

async function parsePaymentSms(message, context = {}) {
  const fallback = parsePaymentSmsFallback(message);
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return fallback;
  }

  try {
    const prompt = [
      "Extract payment-credit details from this Indian bank or UPI SMS.",
      "Return only JSON that matches this schema:",
      JSON.stringify({
        isPaymentCredit: "boolean true only if money was credited/received into merchant account",
        amount: "number INR amount credited, 0 if none",
        paymentTime: "ISO timestamp if available, otherwise empty string",
        reference: "UPI reference/UTR/RRN if present, otherwise empty string",
        payer: "payer name or VPA if present, otherwise empty string",
        confidence: "number from 0 to 1",
        reason: "short reason"
      }),
      "Do not mark debit, failed, reversal, request, OTP, promotional, or balance-only SMS as payment credit.",
      `Sender: ${context.sender || ""}`,
      `Received at: ${context.receivedAt || ""}`,
      `SMS: ${message}`
    ].join("\n");

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              isPaymentCredit: { type: "BOOLEAN" },
              amount: { type: "NUMBER" },
              paymentTime: { type: "STRING" },
              reference: { type: "STRING" },
              payer: { type: "STRING" },
              confidence: { type: "NUMBER" },
              reason: { type: "STRING" }
            },
            required: ["isPaymentCredit", "amount", "paymentTime", "reference", "payer", "confidence", "reason"]
          }
        }
      })
    });

    if (!response.ok) {
      return { ...fallback, reason: `${fallback.reason} Gemini parse failed: ${response.status}` };
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(text);
    return normalizeParsedPayment(parsed, fallback);
  } catch (error) {
    return { ...fallback, reason: `${fallback.reason} Gemini parse error: ${error.message}` };
  }
}

function parsePaymentSmsFallback(message) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const isNegative = /\b(debited|sent|paid to|withdrawn|failed|declined|reversed|refund|otp|request)\b/i.test(text);
  const isCredit = /\b(credited|received|deposited|cr|credit)\b/i.test(text) && /\b(upi|vpa|a\/c|account|acct|bank)\b/i.test(text);
  const amountMatch = text.match(/(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i) || text.match(/([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:rs\.?|inr|₹)/i);
  const referenceMatch = text.match(/\b(?:utr|upi ref|upi reference|rrn|ref(?:erence)?(?: no)?)[\s:.-]*([A-Z0-9]{6,})/i);
  const amount = amountMatch ? Number(amountMatch[1].replaceAll(",", "")) : 0;

  return {
    isPaymentCredit: Boolean(isCredit && !isNegative && amount > 0),
    amount,
    paymentTime: "",
    reference: referenceMatch ? referenceMatch[1] : "",
    payer: "",
    confidence: isCredit && !isNegative && amount > 0 ? 0.65 : 0.2,
    reason: "Fallback parser result."
  };
}

function normalizeParsedPayment(parsed, fallback) {
  const amount = Number(parsed.amount || fallback.amount || 0);
  return {
    isPaymentCredit: Boolean(parsed.isPaymentCredit) && amount > 0,
    amount,
    paymentTime: String(parsed.paymentTime || ""),
    reference: String(parsed.reference || ""),
    payer: String(parsed.payer || ""),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
    reason: String(parsed.reason || fallback.reason || "")
  };
}

async function matchIncomingPayment(parsedPayment, smsRecord) {
  return matchIncomingPaymentRecord(parsedPayment, {
    id: smsRecord.id,
    source: "smsgate_gemini",
    receivedAt: smsRecord.receivedAt,
    notePrefix: "Payment SMS"
  });
}

async function matchIncomingPaymentRecord(parsedPayment, sourceDetails) {
  const orders = await readOrders();
  const receivedAt = parseDate(sourceDetails.receivedAt);
  const amount = Number(parsedPayment.amount || 0);
  const candidates = orders.filter((order) => {
    const status = order.paymentStatus || paymentStatuses.unpaid;
    const mode = order.paymentMode || paymentModes.online;
    const orderTime = parseDate(order.updatedAt || order.savedAt || order.createdAt);
    return mode === paymentModes.online
      && status === paymentStatuses.unpaid
      && Number(order.total || 0).toFixed(2) === amount.toFixed(2)
      && Math.abs(receivedAt.getTime() - orderTime.getTime()) <= paymentMatchWindowMs;
  });

  if (candidates.length === 1) {
    const order = candidates[0];
    await updateOrderPaymentStatus({
      ...order,
      paymentStatus: paymentStatuses.detected,
      paymentDetectedAt: new Date().toISOString(),
      paymentReference: parsedPayment.reference,
      paymentSource: sourceDetails.source,
      paymentMatchNote: `${sourceDetails.notePrefix} matched exact amount ${amount.toFixed(2)}.`,
      paymentSmsId: sourceDetails.id
    });
    return { matchStatus: paymentStatuses.detected, receiptNumber: order.receiptNumber };
  }

  if (candidates.length > 1) {
    for (const order of candidates) {
      await updateOrderPaymentStatus({
        ...order,
        paymentStatus: paymentStatuses.review,
        paymentDetectedAt: new Date().toISOString(),
        paymentReference: parsedPayment.reference,
        paymentSource: sourceDetails.source,
        paymentMatchNote: `Multiple unpaid bills matched amount ${amount.toFixed(2)}. Confirm manually.`,
        paymentSmsId: sourceDetails.id
      });
    }
    return { matchStatus: paymentStatuses.review, receiptNumber: "" };
  }

  return { matchStatus: "no_match", receiptNumber: "" };
}

function isValidSmsGateWebhook(rawBody, req) {
  const signingKey = String(process.env.SMSGATE_WEBHOOK_SIGNING_KEY || "").trim();
  if (!signingKey) {
    return true;
  }

  const signature = req.headers["x-signature"];
  const timestamp = req.headers["x-timestamp"];
  if (!signature || !timestamp) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", signingKey)
    .update(`${rawBody}${timestamp}`)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(String(signature));
  return expectedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

async function writeIncomingSmsRecord(record) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest("/rest/v1/incoming_payment_sms", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify(mapIncomingSmsToDb(record))
    });
    return;
  }

  const records = readIncomingSmsLocal();
  const existingIndex = records.findIndex((entry) => entry.id === record.id);
  if (existingIndex >= 0) {
    records[existingIndex] = record;
  } else {
    records.unshift(record);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(incomingSmsPath, JSON.stringify(records.slice(0, 500), null, 2));
}

function readIncomingSmsLocal() {
  if (!fs.existsSync(incomingSmsPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(incomingSmsPath, "utf8")));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function mapIncomingSmsToDb(record) {
  return {
    id: record.id,
    message_id: record.messageId,
    sender: record.sender,
    recipient: record.recipient,
    received_at: record.receivedAt,
    message: record.message,
    parsed: record.parsed,
    match_status: record.matchStatus,
    matched_receipt_number: record.matchedReceiptNumber || null,
    created_at: record.createdAt
  };
}

function mapSalesOrderToDb(order) {
  const now = new Date().toISOString();
  const payload = {
    receipt_number: order.receiptNumber,
    business_name: order.businessName,
    business_phone: order.businessPhone,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    google_review_link: order.googleReviewLink,
    items: order.items,
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    total: order.total,
    created_label: order.createdAt,
    updated_at: now,
    payment_mode: order.paymentMode || paymentModes.online,
    payment_status: order.paymentStatus || paymentStatuses.unpaid,
    payment_detected_at: order.paymentDetectedAt || null,
    payment_confirmed_at: order.paymentConfirmedAt || null,
    payment_reference: order.paymentReference || null,
    payment_source: order.paymentSource || null,
    payment_match_note: order.paymentMatchNote || null,
    payment_sms_id: order.paymentSmsId || null
  };
  return payload;
}

function mapSalesOrderFromDb(row) {
  return {
    receiptNumber: row.receipt_number,
    businessName: row.business_name,
    businessPhone: row.business_phone,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    googleReviewLink: row.google_review_link,
    items: row.items || [],
    subtotal: Number(row.subtotal || 0),
    discount: Number(row.discount || 0),
    tax: Number(row.tax || 0),
    total: Number(row.total || 0),
    createdAt: row.created_label || row.created_at,
    savedAt: row.created_at,
    updatedAt: row.updated_at,
    paymentMode: row.payment_mode || paymentModes.online,
    paymentStatus: row.payment_status || paymentStatuses.unpaid,
    paymentDetectedAt: row.payment_detected_at || "",
    paymentConfirmedAt: row.payment_confirmed_at || "",
    paymentReference: row.payment_reference || "",
    paymentSource: row.payment_source || "",
    paymentMatchNote: row.payment_match_note || "",
    paymentSmsId: row.payment_sms_id || ""
  };
}

function mapSupplierRecordToDb(record) {
  return {
    supplier_name: record.supplierName,
    item_details: record.itemDetails,
    total_amount: record.totalAmount,
    paid_amount: record.paidAmount,
    due_amount: record.dueAmount,
    payment_status: record.paymentStatus,
    transaction_date: record.transactionDate,
    notes: record.notes
  };
}

function mapSupplierRecordFromDb(row) {
  return {
    id: row.id,
    supplierName: row.supplier_name,
    itemDetails: row.item_details,
    totalAmount: Number(row.total_amount || 0),
    paidAmount: Number(row.paid_amount || 0),
    dueAmount: Number(row.due_amount || 0),
    paymentStatus: row.payment_status,
    transactionDate: row.transaction_date,
    notes: row.notes || "",
    createdAt: row.created_at
  };
}

async function scheduleReviewMessage(details) {
  const message = {
    id: `review-${details.receiptNumber}-${Date.now()}`,
    receiptNumber: details.receiptNumber,
    customerName: details.customerName,
    customerPhone: details.customerPhone,
    businessName: details.businessName,
    businessPhone: details.businessPhone,
    googleReviewLink: details.googleReviewLink,
    scheduledAt: details.scheduledAt,
    status: "pending",
    attempts: 0,
    lastError: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest("/rest/v1/scheduled_review_messages", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify(mapScheduledReviewToDb(message))
    });
    return message;
  }

  const messages = await readScheduledReviewMessages();
  messages.unshift(message);
  writeScheduledReviewMessagesLocal(messages);
  return message;
}

async function processScheduledReviews() {
  const smsConfig = getSmsConfig();
  if (!smsConfig.ok) {
    return;
  }

  const now = new Date();
  const messages = await readScheduledReviewMessages();
  const dueMessages = messages.filter((message) => (
    message.status === "pending"
    && Number(message.attempts || 0) < maxReviewAttempts
    && new Date(message.scheduledAt) <= now
  ));

  for (const message of dueMessages) {
    try {
      await sendSms(message.customerPhone, buildDelayedReviewMessage(message), smsConfig);
      await updateScheduledReviewMessage({
        ...message,
        status: "sent",
        attempts: Number(message.attempts || 0) + 1,
        lastError: "",
        sentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      const attempts = Number(message.attempts || 0) + 1;
      await updateScheduledReviewMessage({
        ...message,
        status: attempts >= maxReviewAttempts ? "failed" : "pending",
        attempts,
        lastError: error.message || "Review SMS failed.",
        scheduledAt: attempts >= maxReviewAttempts
          ? message.scheduledAt
          : new Date(Date.now() + reviewRetryDelayMs).toISOString(),
        updatedAt: new Date().toISOString()
      });
      writeSmsErrorLog(error.details || { error: error.message, receiptNumber: message.receiptNumber });
    }
  }
}

async function readScheduledReviewMessages() {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    const rows = await supabaseRequest("/rest/v1/scheduled_review_messages?select=*&order=scheduled_at.asc");
    return rows.map(mapScheduledReviewFromDb);
  }

  if (!fs.existsSync(scheduledReviewsPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(scheduledReviewsPath, "utf8")));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function updateScheduledReviewMessage(message) {
  const supabase = getSupabaseConfig();
  if (supabase.ok) {
    await supabaseRequest(`/rest/v1/scheduled_review_messages?id=eq.${encodeURIComponent(message.id)}`, {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify(mapScheduledReviewToDb(message))
    });
    return;
  }

  const messages = await readScheduledReviewMessages();
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index === -1) {
    return;
  }
  messages[index] = message;
  writeScheduledReviewMessagesLocal(messages);
}

function writeScheduledReviewMessagesLocal(messages) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(scheduledReviewsPath, JSON.stringify(messages, null, 2));
}

function mapScheduledReviewToDb(message) {
  return {
    id: message.id,
    receipt_number: message.receiptNumber,
    customer_name: message.customerName,
    customer_phone: message.customerPhone,
    business_name: message.businessName,
    business_phone: message.businessPhone,
    google_review_link: message.googleReviewLink,
    scheduled_at: message.scheduledAt,
    status: message.status,
    attempts: message.attempts,
    last_error: message.lastError || null,
    sent_at: message.sentAt || null,
    created_at: message.createdAt,
    updated_at: message.updatedAt
  };
}

function mapScheduledReviewFromDb(row) {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    businessName: row.business_name,
    businessPhone: row.business_phone,
    googleReviewLink: row.google_review_link,
    scheduledAt: row.scheduled_at,
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || "",
    sentAt: row.sent_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getMonthKey(value) {
  const date = parseDate(value);
  return date.toISOString().slice(0, 7);
}

function getDateKey(value) {
  const date = parseDate(value);
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function getSmsConfig() {
  const username = String(process.env.SMSGATE_USERNAME || "").trim();
  const password = String(process.env.SMSGATE_PASSWORD || "").trim();

  if (!username || !password) {
    return {
      ok: false,
      error: "SMSGate username and password are not configured in .env."
    };
  }

  return {
    ok: true,
    baseUrl: process.env.SMSGATE_BASE_URL || "https://api.sms-gate.app/3rdparty/v1/messages",
    username,
    password,
    deviceId: process.env.SMSGATE_DEVICE_ID || "",
    simNumber: Number(process.env.SMSGATE_SIM_NUMBER || 1),
    priority: Number(process.env.SMSGATE_PRIORITY || 100),
    skipPhoneValidation: String(process.env.SMSGATE_SKIP_PHONE_VALIDATION || "true") === "true",
    deviceActiveWithin: process.env.SMSGATE_DEVICE_ACTIVE_WITHIN
      ? Number(process.env.SMSGATE_DEVICE_ACTIVE_WITHIN)
      : 0
  };
}

function normalizePhoneNumber(phoneNumber) {
  const cleaned = String(phoneNumber || "").replace(/[\s()-]/g, "");

  if (/^\+\d{10,15}$/.test(cleaned)) {
    return cleaned;
  }

  if (/^\d{10}$/.test(cleaned)) {
    return `+91${cleaned}`;
  }

  if (/^91\d{10}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  if (/^0\d{10}$/.test(cleaned)) {
    return `+91${cleaned.slice(1)}`;
  }

  return "";
}

function writeSmsErrorLog(errorReport) {
  const logsDir = path.join(__dirname, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, "latest-sms-error.json"),
    JSON.stringify(errorReport, null, 2)
  );
}

function serveStatic(urlPath, res) {
  const cleanPath = urlPath === "/"
    ? "/index.html"
    : urlPath === "/admin"
      ? "/admin.html"
      : urlPath;
  const decodedPath = decodeURIComponent(cleanPath);
  const filePath = path.normalize(path.join(publicDir, decodedPath));

  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      return sendJson(res, 404, { error: "Not found" });
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gmail</title></head><body>${html}</body></html>`);
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
