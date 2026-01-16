import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await sessionStorage.deleteSession(session.id);
  }

  // Attempt to clean up all sessions for this shop
  try {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) {
      await sessionStorage.deleteSessions(sessions.map(s => s.id));
    }
  } catch (e) {
    console.error("Failed to clean up sessions for shop:", shop, e);
  }

  return new Response();
};
