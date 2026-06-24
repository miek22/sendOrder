// Fetches open/paid orders from Shopify for use by sendOrders.js
const axios = require('axios');
require('dotenv').config();

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_PASSWORD = process.env.SHOPIFY_API_PASSWORD;
const SHOPIFY_SHOP_NAME = process.env.SHOPIFY_SHOP_NAME;

const SHOPIFY_API_URL = `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2024-04/orders.json?status=open&financial_status=paid,partially_refunded&fields=shipping_address,line_items,order_number,note,financial_status,payment_gateway_names,shipping_lines,total_price`;

async function fetchShopifyOrders() {
    const response = await axios.get(SHOPIFY_API_URL, {
        auth: {
            username: SHOPIFY_API_KEY,
            password: SHOPIFY_API_PASSWORD,
        },
    });
    return response.data.orders;
}

module.exports = { fetchShopifyOrders };
