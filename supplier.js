require('dotenv').config();
const axios = require('axios');
const { fetchShopifyOrders } = require('./getOrders');
const fs = require('fs');
const path = './sentOrders.json';

const SUPPLIER_API_URL = process.env.SUPPLIER_API_URL;
const AUTH_TOKEN = process.env.SUPPLIER_API_KEY;



function readSentOrders() {
    if (fs.existsSync(path)) {
        const data = fs.readFileSync(path, 'utf8');
        return JSON.parse(data);
    }
    return [];
}


function saveSentOrders(sentOrders) {
    fs.writeFileSync(path, JSON.stringify(sentOrders, null, 2));
}


function isOrderSent(orderNumber, sentOrders) {
    return sentOrders.includes(orderNumber);
}



function formatPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    // Assuming phoneNumber is in a format like "5144324323"
    return phoneNumber.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3');
}


function encodeApiKeyToBase64(apiKey) {
    return Buffer.from(apiKey).toString('base64');
}

async function sendOrdersToSupplier() {
    const sentOrders = readSentOrders(); 

    try {
        const orders = await fetchShopifyOrders();

        for (const order of orders) {
            if (isOrderSent(order.order_number, sentOrders)) {
                console.log(`Order ${order.order_number} has already been sent. Skipping.`);
                continue;
            }

            const formattedOrder = {
                whse: "001",
                whsePickup: null,
                purchaseOrder: `${order.order_number}`,
                shippingService: null,
                transitNote: null,
                documentNote: null,
                shipTo: {
                    languageNo: "EN",
                    name: order.shipping_address.name || null,
                    phone: formatPhoneNumber(order.shipping_address.phone) || null,
                    email: null,
                    addressLine1: order.shipping_address.address1 || null,
                    addressLine2: order.shipping_address.address2 || null,
                    addressLine3: order.shipping_address.address3 || null,
                    city: order.shipping_address.city || null,
                    state: order.shipping_address.province_code || null,
                    zip: order.shipping_address.zip || null,
                    country: order.shipping_address.country_code || null,
                    note: null, //order.note || 
                },
                details: order.line_items
                    .filter(item => item.current_quantity > 0)
                    .map(item => ({
                        product: item.sku,
                        crossReference: "ref#",
                        qty: item.quantity,
                        keepBo: false,
                        declaredValue: 0.00,
                    }))
            };

            const encodedAuthToken = encodeApiKeyToBase64(AUTH_TOKEN);


            const response = await axios.post(SUPPLIER_API_URL, formattedOrder, {
                headers: {
                    'Authorization': `Basic ${encodedAuthToken}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            });

            // Log the success message with the order number
            console.log(`Order ${formattedOrder.purchaseOrder} successfully sent to Supplier API.`);

            // Add the order number to the list of sent orders
            sentOrders.push(order.order_number);
            saveSentOrders(sentOrders); // Save the updated list
        }
    } catch (error) {
        if (error.response) {
            console.error('Error response from Supplier API:');
            console.error('Status:', error.response.status);
            console.error('Headers:', JSON.stringify(error.response.headers, null, 2));
            console.error('Body:', error.response.data);
        } else {
            console.error('Error sending orders to supplier:', error.message);
        }
    }
}

sendOrdersToSupplier();
