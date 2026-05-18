const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

loadEnvFile();

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const ordersPath = path.join(dataDir, "orders.json");
const port = Number(process.env.PORT || 3000);

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
        smsConfigured: Boolean(process.env.SMSGATE_USERNAME && process.env.SMSGATE_PASSWORD),
        storageMode: getSupabaseConfig().ok ? "supabase" : "local"
      });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/send-review") {
      const body = await readJson(req);
      return handleSendReview(body, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/orders") {
      const body = await readJson(req);
      return handleSaveOrder(body, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/orders") {
      return handleAdminOrders(requestUrl, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/admin/overview") {
      return handleAdminOverview(requestUrl, res);
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

    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "Method not allowed" });
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
    const errorReport = {
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
    writeSmsErrorLog(errorReport);

    return sendJson(res, response.status, {
      error: "SMSGate rejected the message.",
      details: errorReport
    });
  }

  return sendJson(res, 200, {
    ok: true,
    message,
    phoneNumber: normalizedPhone,
    gatewayResponse: responseBody
  });
}

function buildReviewMessage(details) {
  return [
    `Hi ${details.customerName}, thank you for your order at ${details.businessName}.`,
    `Receipt ${details.receiptNumber}: ${details.currencySymbol}${Number(details.total).toFixed(2)}.`,
    `Please review us here: ${details.googleReviewLink}`,
    `For any queries kindly contact ${details.businessPhone || process.env.BUSINESS_PHONE || "us"}.`
  ].join(" ");
}

async function handleSaveOrder(body, res) {
  const order = sanitizeOrder(body);
  if (!order.receiptNumber || !order.customerName || !order.customerPhone || !order.items.length) {
    return sendJson(res, 400, { error: "Order needs receipt number, customer, phone, and at least one item." });
  }

  const orders = await readOrders();
  const existingIndex = orders.findIndex((entry) => entry.receiptNumber === order.receiptNumber);
  const now = new Date().toISOString();

  if (existingIndex >= 0) {
    orders[existingIndex] = { ...orders[existingIndex], ...order, updatedAt: now };
  } else {
    orders.unshift({ ...order, savedAt: now, updatedAt: now });
  }

  await writeOrder(order, existingIndex >= 0);
  return sendJson(res, 200, { ok: true, count: orders.length });
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
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

function mapSalesOrderToDb(order) {
  const now = new Date().toISOString();
  return {
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
    updated_at: now
  };
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
    updatedAt: row.updated_at
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
  const username = process.env.SMSGATE_USERNAME;
  const password = process.env.SMSGATE_PASSWORD;

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
