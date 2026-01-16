// functions/api.js

const express = require('express');
const serverless = require('serverless-http'); // Thư viện cầu nối Netlify
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const router = express.Router();

// --- CẤU HÌNH (BẠN ĐIỀN THÔNG TIN VÀO ĐÂY) ---
const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// --- HÀM 1: GIẢI MÃ & LÀM SẠCH LINK (LOGIC PRO) ---
async function resolveAndCleanUrl(inputUrl) {
    let finalUrl = inputUrl;

    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        try {
            const response = await axios.get(inputUrl, {
                maxRedirects: 5,
                validateStatus: null 
            });
            finalUrl = response.request.res.responseUrl || inputUrl;
        } catch (error) {
            console.log(`>> Khong the giai ma link: ${inputUrl}`);
        }
    }

    let baseUrl = finalUrl.split('?')[0]; 
    
    if (baseUrl.includes('/search')) {
        try {
            const urlObj = new URL(finalUrl);
            const originalParams = urlObj.searchParams;
            const newParams = new URLSearchParams();
            const allowedKeys = ['keyword', 'shop', 'evcode', 'signature', 'promotionId', 'mmp_pid'];

            allowedKeys.forEach(key => {
                if (originalParams.has(key)) {
                    newParams.append(key, originalParams.get(key));
                }
            });

            if (newParams.toString() === "") return baseUrl;
            return `${baseUrl}?${newParams.toString()}`;
        } catch (e) {
            return baseUrl;
        }
    }

    const shopProductPattern = /shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/;
    const match = baseUrl.match(shopProductPattern);

    if (match) {
        return `https://shopee.vn/product/${match[2]}/${match[3]}`;
    }

    if (baseUrl.includes('/m/') || baseUrl.includes('/product/') || (baseUrl.split('/').length === 4)) {
        return baseUrl; 
    }

    return finalUrl.split('?')[0];
}

// --- HÀM 2: GỌI API SHOPEE TẠO LINK AFFILIATE ---
async function getShopeeShortLink(originalUrl, subIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    let subIdsParam = "";
    if (subIds && subIds.length > 0) {
        const validIds = subIds.filter(id => id && id.trim() !== "");
        if (validIds.length > 0) {
            const formattedIds = validIds.map(id => `"${id.trim()}"`).join(",");
            subIdsParam = `, subIds: [${formattedIds}]`;
        }
    }

    const query = `mutation {
        generateShortLink(input: { 
            originUrl: "${originalUrl}"
            ${subIdsParam}
        }) {
            shortLink
        }
    }`;
    
    const payloadObject = { query };
    const payloadString = JSON.stringify(payloadObject);
    const stringToSign = `${APP_ID}${timestamp}${payloadString}${APP_SECRET}`;
    const signature = crypto.createHash('sha256').update(stringToSign).digest('hex');

    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            }
        });

        if (response.data.errors) return null;
        return response.data.data.generateShortLink.shortLink;
    } catch (e) {
        return null; 
    }
}

// --- ROUTER XỬ LÝ CHÍNH ---
router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    if (!text) return res.status(400).json({ error: 'Empty text' });

    const urlRegex = /(https?:\/\/(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn)[^\s]*)/gi;
    const uniqueLinks = [...new Set(text.match(urlRegex) || [])];

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        let cleanInput = url.replace(/[.,;!?)]+$/, ""); 
        const realProductUrl = await resolveAndCleanUrl(cleanInput);
        const myShortLink = await getShopeeShortLink(realProductUrl, subIds);
        return { original: url, resolved: realProductUrl, short: myShortLink };
    }));

    let newText = text;
    conversions.forEach(item => {
        if (item.short) newText = newText.split(item.original).join(item.short);
    });

    res.json({ success: true, newText, details: conversions });
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router); 

module.exports.handler = serverless(app);
