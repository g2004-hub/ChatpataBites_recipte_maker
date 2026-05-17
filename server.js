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
        smsConfigured: Boolean(process.env.SMSGATE_USERNAME && process.env.SMSGATE_PASSWORD)
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

function handleSaveOrder(body, res) {
  const order = sanitizeOrder(body);
  if (!order.receiptNumber || !order.customerName || !order.customerPhone || !order.items.length) {
    return sendJson(res, 400, { error: "Order needs receipt number, customer, phone, and at least one item." });
  }

  const orders = readOrders();
  const existingIndex = orders.findIndex((entry) => entry.receiptNumber === order.receiptNumber);
  const now = new Date().toISOString();

  if (existingIndex >= 0) {
    orders[existingIndex] = { ...orders[existingIndex], ...order, updatedAt: now };
  } else {
    orders.unshift({ ...order, savedAt: now, updatedAt: now });
  }

  writeOrders(orders);
  return sendJson(res, 200, { ok: true, count: orders.length });
}

function handleAdminOrders(requestUrl, res) {
  const password = requestUrl.searchParams.get("password") || "";
  const expected = process.env.ADMIN_PASSWORD || "ChatpataBites";

  if (password !== expected) {
    return sendJson(res, 401, { error: "Invalid admin password." });
  }

  return sendJson(res, 200, { orders: readOrders() });
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

function readOrders() {
  if (!fs.existsSync(ordersPath)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(ordersPath, "utf8"));
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
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
