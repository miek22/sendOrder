// Combined order-sending script.
//   TR-AU items -> sent via Supplier REST API
//   KE-L  items -> sent via email to LKQ
//
// Tracks sent orders PER VENDOR in sentOrders.csv (so an order containing
// both TR-AU and KE-L parts gets both sent, instead of being marked "done"
// after only one vendor's items went out).
//
// On any send failure, emails ALERT_EMAIL with the order # and the error
// so it doesn't only show up in a console log nobody is watching.
//
// Does NOT fulfill orders in Shopify — fulfill manually to avoid duplicate orders.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { fetchShopifyOrders } = require('./shopify');

const TESTING = process.env.TESTING === 'true';

const SENT_ORDERS_CSV = path.join(__dirname, 'sentOrders.csv');
const CSV_HEADER = 'timestamp,orderNumber,vendor,status,detail';

const SUPPLIER_API_URL = process.env.SUPPLIER_API_URL;
const SUPPLIER_API_KEY = process.env.SUPPLIER_API_KEY;
const ALERT_EMAIL = process.env.ALERT_EMAIL || process.env.TO_EMAIL;

// ---------------------------------------------------------
// CSV tracking (replaces sentOrders.json)
// ---------------------------------------------------------
function ensureCsvExists() {
    if (!fs.existsSync(SENT_ORDERS_CSV)) {
        fs.writeFileSync(SENT_ORDERS_CSV, CSV_HEADER + '\n');
    }
}

function csvEscape(value) {
    const str = String(value ?? '');
    if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// Minimal CSV line parser that respects a quoted final "detail" field.
function parseCsvLine(line) {
    const firstFour = [];
    let rest = line;
    for (let i = 0; i < 4; i++) {
        const idx = rest.indexOf(',');
        if (idx === -1) return null;
        firstFour.push(rest.slice(0, idx));
        rest = rest.slice(idx + 1);
    }
    let detail = rest;
    if (detail.startsWith('"') && detail.endsWith('"')) {
        detail = detail.slice(1, -1).replace(/""/g, '"');
    }
    const [timestamp, orderNumber, vendor, status] = firstFour;
    return { timestamp, orderNumber, vendor, status, detail };
}

function readSentOrders() {
    ensureCsvExists();
    const lines = fs.readFileSync(SENT_ORDERS_CSV, 'utf8').split('\n').filter(Boolean);
    return lines.slice(1).map(parseCsvLine).filter(Boolean);
}

function appendSentOrderRow({ orderNumber, vendor, status, detail }) {
    ensureCsvExists();
    const row = [
        new Date().toISOString(),
        orderNumber,
        vendor,
        status,
        csvEscape(detail || ''),
    ].join(',');
    fs.appendFileSync(SENT_ORDERS_CSV, row + '\n');
}

function alreadySent(orderNumber, vendor, sentRows) {
    return sentRows.some(
        r => r.orderNumber === String(orderNumber) && r.vendor === vendor && r.status === 'sent'
    );
}

// ---------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------
function formatPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    const digits = String(phoneNumber).replace(/\D/g, '');
    if (digits.length === 10) {
        return digits.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3');
    }
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
// Email transport (Gmail) + error alert
// ---------------------------------------------------------
function createTransport() {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) {
        throw new Error('Missing EMAIL_USER or EMAIL_PASS environment variable.');
    }
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
async function sendTrAuOrder(order, sentRows, transporter) {
    const vendorItems = order.line_items.filter(
        item => item.vendor === 'TR-AU' && item.current_quantity > 0
    );
    if (vendorItems.length === 0) return;
    if (alreadySent(order.order_number, 'TR-AU', sentRows)) return;

    const total = parseFloat(order.total_price || '0');
    const gateways = (order.payment_gateway_names || []).map(g => String(g).toLowerCase());
    const paymentLabel = gateways.length ? gateways.join(', ') : 'unknown';
    const requireSignature = total > 300;
    const signatureLabel = requireSignature ? 'SIGNATURE REQUIRED: yes' : 'SIGNATURE REQUIRED: no';
    const transitNote = requireSignature
        ? 'SIGNATURE REQUIRED ON DELIVERY FOR THIS ONE PLEASE. THANK YOU.'
        : null;

    const ship = order.shipping_address || {};
    const provinceCode = ship.province_code;
    const whse = pickWarehouseByProvince(provinceCode);

    const formattedOrder = {
        whse,
        whsePickup: null,
        purchaseOrder: `${order.order_number}`,
        shippingService: null,
        transitNote,
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
        details: vendorItems.map(item => ({
            product: item.sku,
            crossReference: 'ref#',
            qty: item.current_quantity,
            keepBo: false,
            declaredValue: 0.0,
        })),
    };

    if (TESTING) {
        console.log(
            `TEST MODE - TR-AU Order ${formattedOrder.purchaseOrder} would be sent | WHSE: ${whse} | Payment: ${paymentLabel} | ${signatureLabel}`
        );
        formattedOrder.details.forEach(item =>
            console.log(`  TEST MODE - SKU: ${item.product} | Qty: ${item.qty}`)
        );
        return;
    }

    try {
        const encodedAuthToken = encodeApiKeyToBase64(SUPPLIER_API_KEY);
        await axios.post(SUPPLIER_API_URL, formattedOrder, {
            headers: {
                Authorization: `Basic ${encodedAuthToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });

        console.log(
            `Order ${order.order_number} (TR-AU) sent | WHSE: ${whse} | items: ${vendorItems.length} | Payment: ${paymentLabel} | ${signatureLabel}`
        );
        appendSentOrderRow({
            orderNumber: order.order_number,
            vendor: 'TR-AU',
            status: 'sent',
            detail: `WHSE ${whse}, ${vendorItems.length} item(s)`,
        });
    } catch (err) {
        const status = err.response?.status;
        const body = err.response?.data;
        const bodyText = typeof body === 'string' ? body : JSON.stringify(body || {});
        const isNoStock = /no\s*stock|out\s*of\s*stock|insufficient|not\s*available|backorder/i.test(bodyText);

        if (isNoStock) {
            const detail = `NO STOCK | WHSE: ${whse} | province: ${provinceCode || '?'} | sku(s): ${vendorItems.map(v => v.sku).join(', ')}`;
            console.log(`Order ${order.order_number} NOT sent (NO STOCK): ${detail}`);
            appendSentOrderRow({ orderNumber: order.order_number, vendor: 'TR-AU', status: 'no_stock', detail });
            await sendErrorAlert(transporter, {
                orderNumber: order.order_number,
                vendor: 'TR-AU',
                message: `Out of stock: ${detail}`,
            });
        } else {
            const detail = `status: ${status || 'n/a'} | msg: ${err.message}`;
            console.log(`Order ${order.order_number} NOT sent (ERROR): ${detail}`);
            appendSentOrderRow({ orderNumber: order.order_number, vendor: 'TR-AU', status: 'error', detail });
            await sendErrorAlert(transporter, { orderNumber: order.order_number, vendor: 'TR-AU', message: detail });
        }
    }
}

// ===========================================================
// KE-L -> Email to LKQ
// ===========================================================
function buildItemsTable(items) {
    const rows = items
        .map(it => {
            const qty = it.current_quantity ?? it.quantity ?? 0;
            return `<tr><td style="padding:8px;border:1px solid #e5e7eb;">${escHtml(it.sku || '')}</td><td style="padding:8px;border:1px solid #e5e7eb; text-align:right;">${escHtml(String(qty))}</td></tr>`;
        })
        .join('');
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
    if (alreadySent(order.order_number, 'KE-L', sentRows)) return;

    const subject = `PARTS AVENUE ACCT #197302 PURCHASE NUMBER #${order.order_number}`;
    const from = process.env.FROM_EMAIL || process.env.EMAIL_USER;
    const to = process.env.TO_EMAIL;

    if (TESTING) {
        console.log(`TEST MODE - KE-L Order ${order.order_number} would be emailed to ${to}`);
        items.forEach(it => console.log(`  TEST MODE - SKU: ${it.sku} | Qty: ${it.current_quantity ?? it.quantity}`));
        return;
    }

    try {
        if (!to) throw new Error('Missing TO_EMAIL in environment variables.');
        if (!transporter) throw new Error('Email transport not available (missing EMAIL_USER/EMAIL_PASS).');

        const html = buildHtmlEmail(order, items);
        const text = buildPlainText(order, items);
        await transporter.sendMail({ from, to, subject, text, html });

        console.log(`Order ${order.order_number} (KE-L) emailed to ${to}`);
        appendSentOrderRow({
            orderNumber: order.order_number,
            vendor: 'KE-L',
            status: 'sent',
            detail: `${items.length} item(s)`,
        });
    } catch (err) {
        console.log(`Order ${order.order_number} (KE-L) NOT sent (ERROR): ${err.message}`);
        appendSentOrderRow({ orderNumber: order.order_number, vendor: 'KE-L', status: 'error', detail: err.message });
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

    for (const order of orders) {
        await sendTrAuOrder(order, sentRows, transporter);
        await sendKelOrder(order, sentRows, transporter);
    }

    console.log('Done.');
}

run();
