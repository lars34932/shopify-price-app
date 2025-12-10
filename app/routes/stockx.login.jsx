import { redirect } from "react-router";

export const loader = async ({ request }) => {
    const stockxAuthUrl = 'https://accounts.stockx.com/authorize';
    const state = Math.random().toString(36).substring(7);
    const CLIENT_ID = process.env.STOCKX_CLIENT_ID;
    const BASE_URL = process.env.SHOPIFY_APP_URL || "";

    if (!CLIENT_ID) {
        return new Response("STOCKX_CLIENT_ID is missing from .env", { status: 500 });
    }

    if (!BASE_URL) {
        // Fallback or error?
        // In dev, sometimes SHOPIFY_APP_URL is not set if not using 'shopify app dev'? 
        // But we need it for the redirect uri.
        return new Response("SHOPIFY_APP_URL is missing", { status: 500 });
    }

    const queryParams = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: `${BASE_URL}/callback`,
        scope: 'offline_access openid',
        audience: 'gateway.stockx.com',
        state: state
    });

    return redirect(`${stockxAuthUrl}?${queryParams.toString()}`);
};
