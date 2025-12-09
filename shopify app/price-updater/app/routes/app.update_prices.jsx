import { useState, useCallback } from "react";
import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
  AppProvider,
  Button,
  Collapsible,
  InlineStack,
  Badge,
  Banner
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { fetchStockXData } from "../stockx.server";
import { updateShopifyProduct } from "../shopify.sync";

// --- LOADER: Fetch Products from Shopify ---
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
    query getProducts {
      products(first: 50, sortKey: TITLE) {
        nodes {
          id
          title
          status
          totalVariants
          initialVariant: variants(first: 1) {
            nodes {
              sku
            }
          }
          variants(first: 100) {
            nodes {
              id
              title
              price
            }
          }
        }
      }
    }`
  );

  const responseJson = await response.json();

  // Map to flatten structure for easier consumption
  const products = responseJson.data.products.nodes.map(p => ({
    ...p,

    sku: p.initialVariant?.nodes[0]?.sku?.replace(/-[^-]+$/, "") || "",
    variants: p.variants
  }));

  return { products };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const appUrl = process.env.SHOPIFY_APP_URL || "";

  if (intent === "update_single") {
    const productId = formData.get("productId");
    const sku = formData.get("sku");

    if (!sku) return { status: "error", message: "Product has no SKU to search." };

    try {
      const stockxResult = await fetchStockXData(sku, appUrl);
      if (stockxResult.status !== 200) {
        return { status: "error", message: stockxResult.error || "StockX Fetch Failed" };
      }

      const updateResult = await updateShopifyProduct(admin, { id: productId }, stockxResult.data);
      return { status: "success", message: updateResult.message, productId };

    } catch (e) {
      console.error(e);
      return { status: "error", message: e.message };
    }
  }

  if (intent === "update_all") {
    const allProductsJson = formData.get("products");
    const allProducts = JSON.parse(allProductsJson);

    let successCount = 0;
    let failCount = 0;

    // Sequential to avoid rate limits
    for (const p of allProducts) {
      if (!p.sku) continue;
      try {
        // 1s delay
        await new Promise(r => setTimeout(r, 1000));

        const stockxResult = await fetchStockXData(p.sku, appUrl);
        if (stockxResult.status === 200) {
          await updateShopifyProduct(admin, { id: p.id }, stockxResult.data);
          successCount++;
        } else {
          failCount++;
        }
      } catch (e) {
        console.error(`Failed to update ${p.title}`, e);
        failCount++;
      }
    }

    return { status: "success", message: `Updated ${successCount} products. Failed ${failCount}.` };
  }

  return null;
};

import { useActionData, useNavigation, useSubmit } from "react-router";

export default function UpdatePricesPage() {
  const { products } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();

  // State to track which products are expanded
  const [expanded, setExpanded] = useState({});

  const handleToggle = useCallback((id) => {
    setExpanded((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }, []);

  const handleUpdateSingle = (product) => {
    submit({ intent: "update_single", productId: product.id, sku: product.sku }, { method: "post" });
  };

  const handleUpdateAll = () => {
    // Pass minimal data needed for update (id and sku)
    const minimalProducts = products.map(p => ({ id: p.id, sku: p.sku, title: p.title }));
    submit({ intent: "update_all", products: JSON.stringify(minimalProducts) }, { method: "post" });
  };

  const isLoading = nav.state === "submitting";
  const isUpdatingAll = isLoading && nav.formData?.get("intent") === "update_all";
  const updatingProductId = isLoading && nav.formData?.get("productId");

  return (
    <AppProvider i18n={enTranslations}>
      <Page
        title="Update Prices"
        primaryAction={{
          content: "Update prices for all",
          onAction: handleUpdateAll,
          loading: isUpdatingAll,
          disabled: isLoading
        }}
      >
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                {actionData?.status && (
                  <Banner tone={actionData.status === "success" ? "success" : "critical"}>
                    <p>{actionData.message}</p>
                  </Banner>
                )}

                {products.length === 0 ? (
                  <BlockStack align="center" inlineAlign="center">
                    <Text tone="subdued">No products found.</Text>
                  </BlockStack>
                ) : (
                  <BlockStack gap="400">
                    <Text variant="headingMd" as="h2">All Products ({products.length})</Text>
                    {products.map((product) => {
                      const isOpen = !!expanded[product.id];
                      const rows = product.variants.nodes.map(v => [v.title, `€${v.price}`]);
                      const isUpdatingThis = updatingProductId === product.id;

                      return (
                        <div key={product.id} style={{ borderBottom: '1px solid #e1e3e5', paddingBottom: '1rem' }}>
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <BlockStack gap="050">
                                <InlineStack gap="200">
                                  <Text variant="headingSm" as="h3">{product.title}</Text>
                                  <Badge tone={product.status === 'ACTIVE' ? 'success' : 'info'}>
                                    {product.status}
                                  </Badge>
                                </InlineStack>
                                <Text tone="subdued" variant="bodySm">SKU Prefix: {product.sku || "N/A"}</Text>
                              </BlockStack>

                              <InlineStack gap="300">
                                <Button
                                  onClick={() => handleUpdateSingle(product)}
                                  loading={isUpdatingThis}
                                  disabled={isLoading}
                                >
                                  Update
                                </Button>
                                <Button
                                  onClick={() => handleToggle(product.id)}
                                  variant="plain"
                                  ariaExpanded={isOpen}
                                >
                                  {isOpen ? "Hide Prices" : "Show Prices"}
                                </Button>
                              </InlineStack>
                            </InlineStack>

                            <Collapsible
                              open={isOpen}
                              id={`collapse-${product.id}`}
                              transition={{ duration: '500ms', timingFunction: 'ease-in-out' }}
                            >
                              <div style={{ marginTop: '0.5rem', paddingLeft: '1rem' }}>
                                {rows.length > 0 ? (
                                  <DataTable
                                    columnContentTypes={["text", "numeric"]}
                                    headings={["Size / Variant", "Price (EUR)"]}
                                    rows={rows}
                                    density="compact"
                                  />
                                ) : (
                                  <Text tone="subdued">No variants found.</Text>
                                )}
                              </div>
                            </Collapsible>
                          </BlockStack>
                        </div>
                      );
                    })}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}
