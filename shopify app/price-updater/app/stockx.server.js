import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const CLIENT_ID = process.env.STOCKX_CLIENT_ID;
const CLIENT_SECRET = process.env.STOCKX_CLIENT_SECRET;
const API_KEY = process.env.STOCKX_API_KEY;
// Using /tmp/ ensures write permissions in most environments, but persistence is minimal on serverless.
const TOKEN_PATH = process.platform === 'win32'
    ? path.join(process.env.TEMP || 'C:\\Temp', 'stockx_tokens.json')
    : '/tmp/stockx_tokens.json';

let accessToken = null;

// --- HELPER FUNCTIONS ---
const saveToken = (tokenData) => {
    try {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData));
        accessToken = tokenData.access_token;
    } catch (e) {
        console.error("Error saving token:", e);
    }
};

const loadToken = () => {
    if (accessToken) return true;
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
            accessToken = data.access_token;
            return true;
        } catch (e) {
            return false;
        }
    }
    return false;
};

// --- CORE FUNCTIONS ---

export async function exchangeCodeForToken(code, redirectUri) {
    const tokenResponse = await fetch('https://accounts.stockx.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            redirect_uri: redirectUri
        })
    });

    const tokenData = await tokenResponse.json();
    if (tokenResponse.ok) {
        saveToken(tokenData);
        return { success: true, tokenData };
    } else {
        console.error("Token Exchange Error:", tokenData);
        return { success: false, error: tokenData };
    }
}

export async function fetchStockXData(sku, baseUrl) {
    // Ensure SKU is clean
    const cleanSku = sku ? sku.trim() : "";
    if (!cleanSku) throw new Error("Missing 'sku'");

    // 1. Auth Check
    loadToken();
    if (!accessToken) {
        return {
            status: 401,
            error: 'Unauthorized',
            action: `Please visit ${baseUrl}/stockx/login to authenticate first.`
        };
    }

    try {
        // 2. Search for Product
        // Use cleanSku used above
        const searchParams = new URLSearchParams({
            query: cleanSku, pageSize: '1', pageNumber: '1', dataType: 'product'
        });

        const searchUrl = `https://api.stockx.com/v2/catalog/search?${searchParams.toString()}`;
        const searchResp = await fetch(searchUrl, {
            headers: {
                'x-api-key': API_KEY,
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (searchResp.status === 401) {
            return {
                status: 401,
                error: "Token Expired. Please login again.",
                action: `Please visit ${baseUrl}/stockx/login to authenticate first.`
            };
        }

        const searchData = await searchResp.json();
        const hits = searchData.results || searchData.data || searchData.products || [];

        if (hits.length === 0) {
            return { status: 404, error: `No products found for SKU: ${cleanSku}` };
        }

        const product = hits[0];
        const currentProductId = product.productId;

        // 3. Get Variants
        const variantsResp = await fetch(`https://api.stockx.com/v2/catalog/products/${currentProductId}/variants`, {
            headers: { 'x-api-key': API_KEY, 'Authorization': `Bearer ${accessToken}` }
        });
        const variants = await variantsResp.json();

        // 4. Get Prices SEQUENTIALLY (Reliable Mode)
        const variantPrices = [];
        console.log(`Found ${variants.length} variants. Fetching prices sequentially...`);

        for (const variant of variants) {
            let euSize = variant.sizeChart?.availableConversions?.find(c => c.type === 'eu')?.size || "N/A";
            let usSize = variant.sizeChart?.defaultConversion?.size || "N/A";
            let priceData = "No Ask";

            try {
                const marketUrl = `https://api.stockx.com/v2/catalog/products/${currentProductId}/variants/${variant.variantId}/market-data?currencyCode=EUR`;
                // Add tiny jitter to delay to look more human if desired, but fixed 100ms is requested

                const marketResp = await fetch(marketUrl, {
                    headers: { 'x-api-key': API_KEY, 'Authorization': `Bearer ${accessToken}` }
                });

                if (marketResp.ok) {
                    const rawData = await marketResp.json();
                    const ask = rawData.lowestAskAmount || rawData.market?.lowestAsk || rawData.lowestAsk;
                    if (ask) priceData = `${ask} EUR`;
                }
            } catch (err) {
                // Silent fail or log
                // console.error(`Error fetching size ${usSize}:`, err.message);
            }

            variantPrices.push({
                size_eu: euSize,
                size_us: usSize,
                price: priceData,
                variantId: variant.variantId
            });

            // 100ms delay as requested for reliability
            await new Promise(r => setTimeout(r, 100));
        }

        return {
            status: 200,
            data: {
                product_info: {
                    title: product.title,
                    sku: product.styleId || product.sku || cleanSku
                },
                variants: variantPrices
            }
        };

    } catch (error) {
        console.error(error);
        return { status: 500, error: "Lookup Failed", details: error.message };
    }
}
