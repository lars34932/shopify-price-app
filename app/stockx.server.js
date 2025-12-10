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
let refreshToken = null;

// --- HELPER FUNCTIONS ---
const saveToken = (tokenData) => {
    try {
        // Merge with existing data to preserve refresh_token if the new response doesn't have one
        let existingData = {};
        if (fs.existsSync(TOKEN_PATH)) {
            try {
                existingData = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
            } catch (e) { /* ignore */ }
        }

        const newData = { ...existingData, ...tokenData };

        fs.writeFileSync(TOKEN_PATH, JSON.stringify(newData));
        accessToken = newData.access_token;
        if (newData.refresh_token) {
            refreshToken = newData.refresh_token;
        }
    } catch (e) {
        console.error("Error saving token:", e);
    }
};

const loadToken = () => {
    if (accessToken && refreshToken) return true;
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
            accessToken = data.access_token;
            refreshToken = data.refresh_token;
            return !!accessToken;
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

async function refreshAccessToken() {
    loadToken(); // Ensure we have the latest
    if (!refreshToken) {
        console.error("No refresh token available");
        return false;
    }

    try {
        const tokenResponse = await fetch('https://accounts.stockx.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                refresh_token: refreshToken
            })
        });

        const tokenData = await tokenResponse.json();
        if (tokenResponse.ok) {
            console.log("Token successfully refreshed");
            saveToken(tokenData);
            return true;
        } else {
            console.error("Token Refresh Error:", tokenData);
            return false;
        }
    } catch (e) {
        console.error("Token Refresh Exception:", e);
        return false;
    }
}

export async function fetchStockXData(sku, baseUrl) {
    // Ensure SKU is clean
    const cleanSku = sku ? sku.trim() : "";
    if (!cleanSku) throw new Error("Missing 'sku'");

    // 1. Auth Check
    loadToken();

    // Auto-login logic
    if (!accessToken) {
        console.log("No access token, attempting refresh...");
        const refreshed = await refreshAccessToken();
        if (!refreshed) {
            return {
                status: 401,
                error: 'Unauthorized',
                action: `Please visit ${baseUrl}/stockx/login to authenticate first.`
            };
        }
    }

    const makeRequest = async (retry = false) => {
        // 2. Search for Product (With Retry)
        const searchParams = new URLSearchParams({
            query: cleanSku, pageSize: '1', pageNumber: '1', dataType: 'product'
        });
        const searchUrl = `https://api.stockx.com/v2/catalog/search?${searchParams.toString()}`;

        let searchData;
        let searchAttempt = 0;
        let searchSuccess = false;

        while (searchAttempt < 3 && !searchSuccess) {
            try {
                // Small jitter delay before search
                await new Promise(r => setTimeout(r, 50 + Math.random() * 50));

                const searchResp = await fetch(searchUrl, {
                    headers: {
                        'x-api-key': API_KEY,
                        'Authorization': `Bearer ${accessToken}`,
                        'User-Agent': 'Mozilla/5.0'
                    }
                });

                // Handle Auth Refresh
                if (searchResp.status === 401 && !retry) {
                    console.log("Got 401 searching, attempting refresh...");
                    const refreshed = await refreshAccessToken();
                    if (refreshed) {
                        return makeRequest(true);
                    } else {
                        return {
                            status: 401,
                            error: "Token Expired and Refresh Failed. Please login again.",
                            action: `Please visit ${baseUrl}/stockx/login to authenticate first.`
                        };
                    }
                }

                // Handle Rate Limits / Server Errors
                if (searchResp.status === 429 || [502, 503, 504, 524].includes(searchResp.status)) {
                    searchAttempt++;
                    const waitTime = 2000 * Math.pow(2, searchAttempt); // 4s, 8s, 16s
                    console.warn(`[StockX] Search Rate Limit/Timeout (${searchResp.status}) for ${cleanSku}. Waiting ${waitTime / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }

                if (!searchResp.ok) {
                    // If it's another error (like 400), log and fail
                    const errText = await searchResp.text();
                    console.error(`[StockX] Search Failed: ${searchResp.status} ${errText}`);
                    throw new Error(`Search failed: ${searchResp.status}`);
                }

                searchData = await searchResp.json();
                searchSuccess = true;

            } catch (err) {
                console.error(`[StockX] Search Exception for ${cleanSku}:`, err.message);
                searchAttempt++;
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!searchSuccess || !searchData) {
            return { status: 404, error: `Search failed after retries for SKU: ${cleanSku}` };
        }

        const hits = searchData.results || searchData.data || searchData.products || [];

        if (hits.length === 0) {
            return { status: 404, error: `No products found for SKU: ${cleanSku}` };
        }

        const product = hits[0];
        const currentProductId = product.productId;

        // 3. Get Variants (Retry Logic)
        let variants = [];
        let variantsAttempt = 0;
        let variantsSuccess = false;

        while (variantsAttempt < 3 && !variantsSuccess) {
            try {
                const variantsResp = await fetch(`https://api.stockx.com/v2/catalog/products/${currentProductId}/variants`, {
                    headers: { 'x-api-key': API_KEY, 'Authorization': `Bearer ${accessToken}` }
                });

                if (variantsResp.status === 401 && !retry) {
                    console.log("Got 401 variants, attempting refresh...");
                    const refreshed = await refreshAccessToken();
                    if (refreshed) {
                        return makeRequest(true);
                    }
                }

                if (variantsResp.status === 429 || [502, 503, 504, 524].includes(variantsResp.status)) {
                    variantsAttempt++;
                    const waitTime = 1000 * Math.pow(2, variantsAttempt); // 2s, 4s, 8s
                    console.warn(`[StockX] Variants Fetch Rate Limit/Timeout (${variantsResp.status}). Waiting ${waitTime / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }

                if (!variantsResp.ok) {
                    const errText = await variantsResp.text();
                    console.error(`[StockX] Failed to fetch variants. Status: ${variantsResp.status}, Body: ${errText}`);
                    throw new Error(`Failed to fetch variants: ${variantsResp.status}`);
                }

                variants = await variantsResp.json();
                variantsSuccess = true;

            } catch (err) {
                console.error(`Error fetching variants:`, err.message);
                variantsAttempt++;
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!variantsSuccess) {
            throw new Error("Failed to fetch variants after multiple retries");
        }

        // 4. Get Prices CONCURRENTLY (With Limit)
        const variantPrices = [];
        console.log(`[StockX] Found ${variants.length || 0} variants. Starting concurrent price fetch...`);
        const timerLabel = `StockX Price Fetching (${cleanSku})`;
        console.time(timerLabel);

        if (!variants || !Array.isArray(variants)) {
            return { status: 500, error: "Failed to fetch variants or invalid response" };
        }

        // Concurrency Helper
        const limit = 5;
        const fetchVariantPrice = async (variant) => {
            let euSize = variant.sizeChart?.availableConversions?.find(c => c.type === 'eu')?.size;
            let usSize = variant.sizeChart?.defaultConversion?.size;

            // Fallback for apparel which might defaults to US sizes
            if (!euSize && usSize) {
                euSize = usSize;
            }

            // Default to N/A if nothing found
            if (!euSize) euSize = "N/A";
            if (!usSize) usSize = "N/A";

            // Clean "US " prefix if present (Requested by user)
            // e.g., "US XS" -> "XS"
            euSize = euSize.replace(/^US\s+/i, "");
            usSize = usSize.replace(/^US\s+/i, "");
            let priceData = "No Ask";

            const maxRetries = 3;
            let attempt = 0;
            let success = false;

            while (attempt < maxRetries && !success) {
                try {
                    const marketUrl = `https://api.stockx.com/v2/catalog/products/${currentProductId}/variants/${variant.variantId}/market-data?currencyCode=EUR`;

                    // Base delay + Jitter (Reduced to ~50-100ms per user request)
                    const delay = 50 + (Math.random() * 50);
                    await new Promise(r => setTimeout(r, delay));

                    const marketResp = await fetch(marketUrl, {
                        headers: { 'x-api-key': API_KEY, 'Authorization': `Bearer ${accessToken}` }
                    });

                    // Handle Rate Limits AND Gateway Timeouts
                    if (marketResp.status === 429 || [502, 503, 504, 524].includes(marketResp.status)) {
                        attempt++;
                        const waitTime = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s (Reduced from 4s start)
                        console.warn(`[StockX] Rate Limit/Timeout ${marketResp.status} for size ${usSize}. Waiting ${waitTime / 1000}s... (Attempt ${attempt}/${maxRetries})`);
                        await new Promise(r => setTimeout(r, waitTime));
                        continue;
                    }

                    if (marketResp.ok) {
                        const rawData = await marketResp.json();
                        const ask = rawData.lowestAskAmount || rawData.market?.lowestAsk || rawData.lowestAsk;
                        if (ask) priceData = `${ask} EUR`;
                        success = true;
                    } else {
                        // Non-retriable error (e.g. 404, 500)
                        console.error(`[StockX] Error ${marketResp.status} for size ${usSize}`);
                        success = true; // Break loop
                    }
                } catch (err) {
                    console.error(`Error fetching size ${usSize}:`, err.message);
                    attempt++;
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            return {
                size_eu: euSize,
                size_us: usSize,
                price: priceData,
                variantId: variant.variantId
            };
        };

        // Process in chunks or a pool
        const results = [];
        for (let i = 0; i < variants.length; i += limit) {
            const chunk = variants.slice(i, i + limit);
            const chunkResults = await Promise.all(chunk.map(v => fetchVariantPrice(v)));
            results.push(...chunkResults);

            // Batch Delay (1.5s - 2s)
            if (i + limit < variants.length) {
                await new Promise(r => setTimeout(r, 1500 + Math.random() * 500));
            }

            console.log(`[StockX] Fetched prices for ${results.length}/${variants.length} variants...`);
        }

        variantPrices.push(...results);

        console.timeEnd(timerLabel);

        return {
            status: 200,
            data: {
                product_info: {
                    title: product.title,
                    sku: product.styleId || product.sku || cleanSku,
                    image: product.media?.imageUrl || product.media?.thumbUrl || product.image,
                    brand: product.brand
                },
                variants: variantPrices
            }
        };
    };

    try {
        return await makeRequest();
    } catch (error) {
        console.error(error);
        return { status: 500, error: `Lookup Failed: ${error.message}`, details: error.message };
    }
}
