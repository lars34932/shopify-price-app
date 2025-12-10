import { redirect } from "react-router";
import { exchangeCodeForToken } from "../stockx.server";

export const loader = async ({ request }) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    // Check for error from provider
    const error = url.searchParams.get("error");
    if (error) {
        return new Response(`Error from StockX: ${error}`, { status: 400 });
    }

    const BASE_URL = process.env.SHOPIFY_APP_URL || "";

    if (!code) {
        return new Response("Missing code", { status: 400 });
    }

    const result = await exchangeCodeForToken(code, `${BASE_URL}/callback`);

    if (result.success) {
        return new Response('<html><body><h1>Authorized!</h1><p>Closing window...</p><script>window.close();</script></body></html>', {
            headers: { "Content-Type": "text/html" }
        });
    } else {
        return new Response(`Failed to auth: ${JSON.stringify(result.error)}`, { status: 500 });
    }
};
