// Combined order-sending script.
//   TR-AU items -> sent via Supplier REST API (with inventory pre-check)
//   KE-L  items -> sent via email to LKQ
//
// Before sending any TR-AU order, checks Transit inventory at both warehouses
// (001 = East, 021 = West/Calgary). Routes each item to the warehouse that has
// stock. If an order needs to split across both warehouses, the alt-warehouse
// shipment gets "0" prepended to the PO number to avoid duplicate PO errors.
//
// Tracks sent orders per VENDOR + WAREHOUSE in sentOrders.csv so a split order
// is tracked as two separate rows — if one half fails, the next run retries only
// that half, not the already-sent half.
//
// On any failure, emails ALERT_EMAIL with the order # and error.
// Does NOT fulfill orders in Shopify — fulfill manually to avoid duplicates.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { fetchShopifyOrders } = require('./shopify');

const TESTING = process.env.TESTING === 'true';

const SENT_ORDERS_CSV = path.join(__dirname, 'sentOrders.csv');
const CSV_HEADER = 'timestamp,orderNumber,vendor,warehouse,status,detail';

const SUPPLIER_API_URL = process.env.SUPPLIER_API_URL;
const SUPPLIER_API_KEY = process.env.SUPPLIER_API_KEY;
const SUPPLIER_API_URL_INVENTORY     = process.env.SUPPLIER_API_URL_INVENTORY;
const SUPPLIER_API_URL_INVENTORY_CAL = process.env.SUPPLIER_API_URL_INVENTORY_CAL;
const ALERT_EMAIL = process.env.ALERT_EMAIL || process.env.TO_EMAIL;

// ---------------------------------------------------------
// CSV tracking
// Columns: timestamp, orderNumber, vendor, warehouse, status, detail
// warehouse = '001' | '021' | 'EMAIL' | 'NONE'
// Only rows with status='sent' are treated as done. Errors/no_stock get retried.
// ---------------------------------------------------------
function ensureCsvExists() {
    if (!fs.existsSync(SENT_ORDERS_CSV)) {
        fs.writeFileSync(SENT_ORDERS_CSV, CSV_HEADER + '\n');
    }
}

function csvEscape(value) {
    const str = String(value ?? '');
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}

function parseCsvLine(line) {
    // Parse 5 plain columns, then a possibly-quoted detail field
    const firstFive = [];
    let rest = line;
    for (let i = 0; i < 5; i++) {
        const idx = rest.indexOf(',');
        if (idx === -1) return null;
        firstFive.push(rest.slice(0, idx));
        rest = rest.slice(idx + 1);
    }
    let detail = rest;
    if (detail.startsWith('"') && detail.endsWith('"')) {
        detail = detail.slice(1, -1).replace(/""/g, '"');
    }
    const [timestamp, orderNumber, vendor, warehouse, status] = firstFive;
    return { timestamp, orderNumber, vendor, warehouse, status, detail };
}

function readSentOrders() {
    ensureCsvExists();
    const lines = fs.readFileSync(SENT_ORDERS_CSV, 'utf8').split('\n').filter(Boolean);
    return lines.slice(1).map(parseCsvLine).filter(Boolean);
}

function appendSentOrderRow({ orderNumber, vendor, warehouse, status, detail }) {
    ensureCsvExists();
    const row = [
        new Date().toISOString(),
        orderNumber,
        vendor,
        warehouse,
        status,
        csvEscape(detail || ''),
    ].join(',');
    fs.appendFileSync(SENT_ORDERS_CSV, row + '\n');
}

// A shipment is "done" only if there's a sent row for this exact order+vendor+warehouse combo
function alreadySent(orderNumber, vendor, warehouse, sentRows) {
    return sentRows.some(
        r => r && r.orderNumber === String(orderNumber) && r.vendor === vendor && r.warehouse === warehouse && r.status === 'sent'
    );
}

// True if ANY shipment for this order+vendor has already gone out successfully —
// to one warehouse, or as a split across both. Stock levels can shift between runs,
// but once part of an order has shipped, the rest is a manual call (e.g. the
// remaining item was out of stock everywhere and needs a human decision), not
// something this script should act on again just because inventory changed later.
function hasAnySentShipment(orderNumber, vendor, sentRows) {
    return sentRows.some(
        r => r && r.orderNumber === String(orderNumber) && r.vendor === vendor && r.status === 'sent'
    );
}

// ---------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------
function formatPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    const digits = String(phoneNumber).replace(/\D/g, '');
    if (digits.length === 10) return digits.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3');
    return phoneNumber;
}

function encodeApiKeyToBase64(apiKey) {
    return Buffer.from(apiKey).toString('base64');
}

function pickWarehouseByProvince(provinceCode) {
    const WEST = new Set(['MB', 'SK', 'AB', 'BC', 'YT', 'NT', 'NU']);
    const code = String(provinceCode || '').toUpperCase().trim();
    return WEST.has(code) ? '021' : '001';
}

function otherWarehouse(whse) {
    return whse === '001' ? '021' : '001';
}

function escHtml(s = '') {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtAddress(addr = {}) {
    const phone = formatPhoneNumber(addr.phone);
    const lines = [
        [addr.first_name, addr.last_name].filter(Boolean).join(' '),
        addr.company,
        [addr.address1, addr.address2].filter(Boolean).join(', '),
        [addr.city, addr.province, addr.zip].filter(Boolean).join(', '),
        addr.country,
        phone ? `Phone: ${phone}` : null,
    ].filter(Boolean);
    return lines.join('\n');
}

// ---------------------------------------------------------
// Inventory (Transit Inc) - fetched once per run, cached
// ---------------------------------------------------------
let inventoryCache = null;

function buildInventoryLookup(data) {
    const map = {};
    // API returns { inventory: [["SKU123", 5], ["SKU456", 0], ...] }
    const items = Array.isArray(data?.inventory) ? data.inventory : [];
    for (const item of items) {
        if (!Array.isArray(item)) continue;
        const sku = item[0];
        const qty = item[1];
        if (sku) map[String(sku).toUpperCase().trim()] = Number(qty ?? 0);
    }
    return map;
}

async function fetchInventory() {
    if (inventoryCache) return inventoryCache;

    const encodedAuthToken = encodeApiKeyToBase64(SUPPLIER_API_KEY);
    const headers = { Authorization: `Basic ${encodedAuthToken}` };

    const [eastRes, westRes] = await Promise.all([
        axios.get(SUPPLIER_API_URL_INVENTORY,     { headers, timeout: 60000 }),
        axios.get(SUPPLIER_API_URL_INVENTORY_CAL, { headers, timeout: 60000 }),
    ]);

    if (TESTING) {
        const sample001 = eastRes.data?.inventory?.[0];
        const sample021 = westRes.data?.inventory?.[0];
        console.log('TEST MODE - Inventory 001 first entry (expect [sku, qty]):', JSON.stringify(sample001));
        console.log('TEST MODE - Inventory 021 first entry (expect [sku, qty]):', JSON.stringify(sample021));
    }

    inventoryCache = {
        '001': buildInventoryLookup(eastRes.data),
        '021': buildInventoryLookup(westRes.data),
    };

    console.log(`Inventory loaded: 001=${Object.keys(inventoryCache['001']).length} SKUs, 021=${Object.keys(inventoryCache['021']).length} SKUs`);
    return inventoryCache;
}

function getStock(inventory, whse, sku) {
    return inventory[whse]?.[String(sku).toUpperCase().trim()] ?? 0;
}

// ---------------------------------------------------------
// Email transport (Gmail) + error alert
// ---------------------------------------------------------
function createTransport() {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) throw new Error('Missing EMAIL_USER or EMAIL_PASS environment variable.');
    return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

async function sendErrorAlert(transporter, { orderNumber, vendor, message }) {
    if (!transporter || !ALERT_EMAIL) {
        console.error(`(No alert email sent) Order ${orderNumber} [${vendor}] error: ${message}`);
        return;
    }
    try {
        await transporter.sendMail({
            from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
            to: ALERT_EMAIL,
            subject: `Order send error - Order #${orderNumber} (${vendor})`,
            text: `Order #${orderNumber} (${vendor}) failed to send.\n\nError: ${message}`,
        });
    } catch (e) {
        console.error('Failed to send error alert email:', e.message);
    }
}

// ===========================================================
// TR-AU -> Supplier REST API
// ===========================================================
function buildFormattedOrder({ whse, po, order, items, requireSignature }) {
    const ship = order.shipping_address || {};
    return {
        whse,
        whsePickup: null,
        purchaseOrder: po,
        shippingService: null,
        transitNote: requireSignature
            ? 'SIGNATURE REQUIRED ON DELIVERY FOR THIS ONE PLEASE. THANK YOU.'
            : null,
        documentNote: null,
        shipTo: {
            languageNo: 'EN',
            name: ship.name || null,
            phone: formatPhoneNumber(ship.phone) || null,
            email: null,
            addressLine1: ship.address1 || null,
            addressLine2: ship.address2 || null,
            addressLine3: ship.address3 || null,
            city: ship.city || null,
            state: ship.province_code || null,
            zip: ship.zip || null,
            country: ship.country_code || null,
            note: null,
        },
        details: items.map(item => ({
            product: item.sku,
            crossReference: 'ref#',
            qty: item.current_quantity,
            keepBo: false,
            declaredValue: 0.0,
        })),
    };
}

async function postOrderToSupplier(formattedOrder, transporter, orderNumber, whse) {
    const encodedAuthToken = encodeApiKeyToBase64(SUPPLIER_API_KEY);
    try {
        await axios.post(SUPPLIER_API_URL, formattedOrder, {
            headers: { Authorization: `Basic ${encodedAuthToken}`, 'Content-Type': 'application/json' },
            timeout: 30000,
        });
        console.log(`Order ${formattedOrder.purchaseOrder} (TR-AU) sent to WHSE ${whse}`);
        return { success: true };
    } catch (err) {
        const status = err.response?.status;
        const body = err.response?.data;
        const bodyText = typeof body === 'string' ? body : JSON.stringify(body || {});
        const isNoStock = /no\s*stock|out\s*of\s*stock|insufficient|not\s*available|backorder/i.test(bodyText);
        const detail = isNoStock
            ? `NO STOCK (API rejected) | WHSE: ${whse} | HTTP: ${status}`
            : `ERROR | WHSE: ${whse} | HTTP: ${status || 'n/a'} | ${err.message}`;
        console.log(`Order ${formattedOrder.purchaseOrder} NOT sent: ${detail}`);
        await sendErrorAlert(transporter, { orderNumber, vendor: 'TR-AU', message: detail });
        return { success: false, detail };
    }
}

async function sendTrAuOrder(order, sentRows, transporter, inventory) {
    const vendorItems = order.line_items.filter(
        item => item.vendor === 'TR-AU' && item.current_quantity > 0
    );
    if (vendorItems.length === 0) return;

    // Any part of this order already shipped in a prior run — do not touch it
    // again, even if it was only a partial fulfillment. A leftover no_stock/error
    // item on an order that already shipped in part is handled manually from here.
    if (hasAnySentShipment(order.order_number, 'TR-AU', sentRows)) {
        return;
    }

    const ship = order.shipping_address || {};
    const provinceCode = ship.province_code;
    const homeWhse = pickWarehouseByProvince(provinceCode);
    const altWhse  = otherWarehouse(homeWhse);

    const total = parseFloat(order.total_price || '0');
    const requireSignature = total > 300;
    const gateways = (order.payment_gateway_names || []).map(g => String(g).toLowerCase());
    const paymentLabel = gateways.length ? gateways.join(', ') : 'unknown';

    if (!inventory) {
        const msg = 'Inventory data unavailable - order skipped to avoid sending to wrong warehouse.';
        console.log(`Order ${order.order_number} (TR-AU) - ${msg}`);
        await sendErrorAlert(transporter, { orderNumber: order.order_number, vendor: 'TR-AU', message: msg });
        return;
    }

    // --- Categorize each item by stock availability ---
    const homeItems    = []; // in stock at home warehouse
    const altItems     = []; // not at home, but in stock at alt warehouse
    const noStockItems = []; // nowhere

    for (const item of vendorItems) {
        const homeQty = getStock(inventory, homeWhse, item.sku);
        const altQty  = getStock(inventory, altWhse,  item.sku);

        if (homeQty > 0)     homeItems.push(item);
        else if (altQty > 0) altItems.push(item);
        else                 noStockItems.push(item);
    }

    // Alert on items with no stock anywhere
    if (noStockItems.length > 0) {
        const skus = noStockItems.map(i => i.sku).join(', ');
        const msg  = `No stock at either warehouse for SKU(s): ${skus}`;
        console.log(`Order ${order.order_number} (TR-AU) - ${msg}`);
        appendSentOrderRow({ orderNumber: order.order_number, vendor: 'TR-AU', warehouse: 'NONE', status: 'no_stock', detail: skus });
        await sendErrorAlert(transporter, { orderNumber: order.order_number, vendor: 'TR-AU', message: msg });
    }

    // Is this a split? (items going to both warehouses)
    const isSplit = homeItems.length > 0 && altItems.length > 0;

    if (isSplit) {
        console.log(
            `Order ${order.order_number} (TR-AU) - SPLIT ORDER: ` +
            `${homeItems.length} item(s) -> WHSE ${homeWhse} (PO: ${order.order_number}), ` +
            `${altItems.length} item(s) -> WHSE ${altWhse} (PO: 0${order.order_number})`
        );
    }

    // Build shipments to send
    const shipments = [];

    if (homeItems.length > 0 && !alreadySent(order.order_number, 'TR-AU', homeWhse, sentRows)) {
        shipments.push({ whse: homeWhse, items: homeItems, po: `${order.order_number}` });
    }

    if (altItems.length > 0 && !alreadySent(order.order_number, 'TR-AU', altWhse, sentRows)) {
        // "0" prefix on PO only when splitting — prevents duplicate PO at supplier
        const po = isSplit ? `0${order.order_number}` : `${order.order_number}`;
        shipments.push({ whse: altWhse, items: altItems, po });
    }

    if (shipments.length === 0) return; // All already sent or all no-stock

    if (TESTING) {
        for (const s of shipments) {
            console.log(`TEST MODE - TR-AU Order ${s.po} would be sent to WHSE ${s.whse} | Payment: ${paymentLabel} | Sig: ${requireSignature}`);
            s.items.forEach(i => console.log(`  TEST MODE - SKU: ${i.sku} | Qty: ${i.current_quantity}`));
        }
        return;
    }

    // Send each shipment
    for (const shipment of shipments) {
        const formattedOrder = buildFormattedOrder({
            whse: shipment.whse,
            po: shipment.po,
            order,
            items: shipment.items,
            requireSignature,
        });

        const result = await postOrderToSupplier(formattedOrder, transporter, order.order_number, shipment.whse);

        appendSentOrderRow({
            orderNumber: order.order_number,
            vendor: 'TR-AU',
            warehouse: shipment.whse,
            status: result.success ? 'sent' : 'error',
            detail: result.success
                ? `PO: ${shipment.po} | ${shipment.items.length} item(s) | ${paymentLabel}${requireSignature ? ' | SIG REQ' : ''}`
                : (result.detail || 'Unknown error'),
        });
    }
}

// ===========================================================
// KE-L -> Email to LKQ (no inventory check needed)
// ===========================================================
function buildItemsTable(items) {
    const rows = items.map(it => {
        const qty = it.current_quantity ?? it.quantity ?? 0;
        return `<tr><td style="padding:8px;border:1px solid #e5e7eb;">${escHtml(it.sku || '')}</td><td style="padding:8px;border:1px solid #e5e7eb; text-align:right;">${escHtml(String(qty))}</td></tr>`;
    }).join('');
    return `<table cellpadding="0" cellspacing="0" style="width:auto; max-width:400px; border-collapse:collapse; border:1px solid #e5e7eb;"><thead><tr style="background:#f9fafb;"><th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">SKU</th><th style="padding:8px;border:1px solid #e5e7eb;text-align:right;">Qty</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function buildPlainText(order, items) {
    const ship = fmtAddress(order.shipping_address);
    const lines = items.map(it => `- ${it.sku || ''} | Qty: ${it.current_quantity ?? it.quantity ?? 0}`).join('\n');
    return `PURCHASE ORDER #: ${order.order_number}\n\nShipping Address\n----------------\n${ship}\n\nLine Items (KE-L)\n------------------\n${lines}`.trim();
}

function buildHtmlEmail(order, items) {
    const ship = escHtml(fmtAddress(order.shipping_address));
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; line-height:1.45; color:#111827;">
    <p style="margin:0 0 12px;"><strong>PURCHASE ORDER #${escHtml(order.order_number)}</strong></p>
    <p style="margin:0 0 12px;">Please let us know if there's any changes you'd like us to make when sending this order in.</p>
    <p style="margin:0 0 24px;">SIGNATURE REQUIRED UPON DELIVERY ON THIS ONE PLEASE</p>
    <h3 style="margin:16px 0 8px;">Shipping Address</h3>
    <pre style="margin:0 0 12px; background:#f9fafb; padding:8px; border:1px solid #e5e7eb; border-radius:6px; white-space:pre-wrap;">${ship}</pre>
    ${buildItemsTable(items)}
    <p style="margin:0 0 12px;">Please let us know in advance if there's any delays we should be aware about when placing this order.</p>
    <p style="margin:0 0 12px;">Thank you!</p>
  </div>`;
}

async function sendKelOrder(order, sentRows, transporter) {
    const items = (order.line_items || []).filter(
        it => it.vendor === 'KE-L' && (it.current_quantity ?? it.quantity ?? 0) > 0
    );
    if (items.length === 0) return;
    if (alreadySent(order.order_number, 'KE-L', 'EMAIL', sentRows)) return;

    const subject = `PARTS AVENUE ACCT #197302 PURCHASE NUMBER #${order.order_number}`;
    const from = process.env.FROM_EMAIL || process.env.EMAIL_USER;
    const to   = process.env.TO_EMAIL;

    if (TESTING) {
        console.log(`TEST MODE - KE-L Order ${order.order_number} would be emailed to ${to}`);
        items.forEach(it => console.log(`  TEST MODE - SKU: ${it.sku} | Qty: ${it.current_quantity ?? it.quantity}`));
        return;
    }

    try {
        if (!to)          throw new Error('Missing TO_EMAIL in environment variables.');
        if (!transporter) throw new Error('Email transport not available (missing EMAIL_USER/EMAIL_PASS).');

        const html = buildHtmlEmail(order, items);
        const text = buildPlainText(order, items);
        await transporter.sendMail({ from, to, subject, text, html });

        console.log(`Order ${order.order_number} (KE-L) emailed to ${to}`);
        appendSentOrderRow({ orderNumber: order.order_number, vendor: 'KE-L', warehouse: 'EMAIL', status: 'sent', detail: `${items.length} item(s)` });
    } catch (err) {
        console.log(`Order ${order.order_number} (KE-L) NOT sent (ERROR): ${err.message}`);
        appendSentOrderRow({ orderNumber: order.order_number, vendor: 'KE-L', warehouse: 'EMAIL', status: 'error', detail: err.message });
        await sendErrorAlert(transporter, { orderNumber: order.order_number, vendor: 'KE-L', message: err.message });
    }
}

// ===========================================================
// Main
// ===========================================================
async function run() {
    ensureCsvExists();
    const sentRows = readSentOrders();

    let transporter = null;
    try {
        transporter = createTransport();
    } catch (err) {
        console.error('Could not create email transport (alerts and KE-L emails will fail):', err.message);
    }

    let orders;
    try {
        orders = await fetchShopifyOrders();
    } catch (err) {
        console.error('Error fetching orders from Shopify:', err.message);
        await sendErrorAlert(transporter, { orderNumber: 'N/A', vendor: 'Shopify fetch', message: err.message });
        process.exitCode = 1;
        return;
    }

    if (!orders || orders.length === 0) {
        console.log('No open/paid Shopify orders found.');
        return;
    }

    // Fetch inventory once for all TR-AU orders in this run
    let inventory = null;
    const hasTrAuOrders = orders.some(o => o.line_items?.some(i => i.vendor === 'TR-AU' && i.current_quantity > 0));
    if (hasTrAuOrders) {
        try {
            inventory = await fetchInventory();
        } catch (err) {
            console.error('Could not fetch Transit inventory:', err.message);
            await sendErrorAlert(transporter, { orderNumber: 'N/A', vendor: 'Inventory fetch', message: err.message });
            // inventory stays null — TR-AU orders will be individually skipped with alerts
        }
    }

    for (const order of orders) {
        await sendTrAuOrder(order, sentRows, transporter, inventory);
        await sendKelOrder(order, sentRows, transporter);
    }

    console.log('Done.');
}

run();
