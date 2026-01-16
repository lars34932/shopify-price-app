import "@shopify/shopify-app-react-router/adapters/node";
import {
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { FileSessionStorage } from "./file-session-storage";
import { restResources } from "@shopify/shopify-api/rest/admin/2024-10";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",

  // Use the explicit string to match the import above
  apiVersion: "2024-10",

  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new FileSessionStorage('./sessions'),
  distribution: AppDistribution.AppStore,

  // Pass the REST resources to the app config
  restResources,
  ...(console.log("DEBUG: restResources keys:", restResources ? Object.keys(restResources).slice(0, 3) : "MISSING") || {}),

  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = "2024-10";
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;