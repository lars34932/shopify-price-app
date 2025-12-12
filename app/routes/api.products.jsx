import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const query = url.searchParams.get("query") || "";

    // This endpoint fetches EVERYTHING matching the query for client-side bulk processing
    // It isolates this heavy logic from the UI loader to prevent crashes.

    let allNodes = [];
    let hasNext = true;
    let currentCursor = null;

    try {
        while (hasNext) {
            const q = query ? `tag:stockx-sync AND (title:*${query}* OR sku:*${query}*)` : "tag:stockx-sync";

            const response = await admin.graphql(
                `#graphql
        query getAllIds($cursor: String, $query: String) {
          products(first: 250, after: $cursor, query: $query, sortKey: TITLE) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              initialVariant: variants(first: 1) {
                nodes {
                  sku
                }
              }
            }
          }
        }`,
                { variables: { cursor: currentCursor, query: q } }
            );

            const json = await response.json();

            if (!json.data || !json.data.products) {
                throw new Error("Invalid GraphQL response");
            }

            const data = json.data.products;

            const simplified = data.nodes.map(n => ({
                id: n.id,
                title: n.title,
                sku: n.initialVariant?.nodes[0]?.sku?.replace(/-[^-]+$/, "") || ""
            }));

            allNodes = allNodes.concat(simplified);

            if (data.pageInfo.hasNextPage && allNodes.length < 5000) { // Safety limit
                currentCursor = data.pageInfo.endCursor;
            } else {
                hasNext = false;
            }
        }
    } catch (error) {
        console.error("Error fetching all products:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    return { allProducts: allNodes };
};
