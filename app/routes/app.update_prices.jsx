import { useState, useCallback, useEffect } from "react";
import { useLoaderData, useActionData, useNavigation, useSubmit, useSearchParams } from "react-router";
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
  Banner,
  ProgressBar,
  TextField,
  Pagination,
  Modal
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { fetchStockXData } from "../stockx.server";
import { updateShopifyProduct } from "../shopify.sync";

// --- LOADER: Fetch Products from Shopify ---
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("query") || "";
  const cursor = url.searchParams.get("cursor");
  const direction = url.searchParams.get("direction") || "next"; // 'next' or 'prev'

  // STANDARD PAGINATION MODE
  const paginationArgs = direction === "prev"
    ? { last: 50, before: cursor }
    : { first: 50, after: cursor };

  // Construct search query
  const searchQuery = query
    ? `tag:stockx-sync AND (title:*${query}* OR sku:*${query}*)`
    : "tag:stockx-sync";

  const response = await admin.graphql(
    `#graphql
    query getProducts($first: Int, $last: Int, $after: String, $before: String, $query: String) {
      products(first: $first, last: $last, after: $after, before: $before, query: $query, sortKey: TITLE) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
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
    }`,
    {
      variables: {
        ...paginationArgs,
        query: searchQuery
      }
    }
  );

  const responseJson = await response.json();
  const productsData = responseJson.data.products;

  // Map to flatten structure for easier consumption
  const products = productsData.nodes.map(p => ({
    ...p,
    sku: p.initialVariant?.nodes[0]?.sku?.replace(/-[^-]+$/, "") || "",
    variants: p.variants
  }));

  return {
    products,
    pageInfo: productsData.pageInfo
  };
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
        return {
          status: "error",
          message: stockxResult.error || "StockX Fetch Failed",
          action: stockxResult.action,
          loginUrl: stockxResult.loginUrl
        };
      }

      const updateResult = await updateShopifyProduct(admin, { id: productId }, stockxResult.data);
      return { status: "success", message: updateResult.message, productId };

    } catch (e) {
      console.error(e);
      return { status: "error", message: e.message };
    }
  }

  return null;
};

export default function UpdatePricesPage() {
  const { products, pageInfo } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();

  // Search State
  // We default to the URL param so it survives reload
  const [searchQuery, setSearchQuery] = useState("");

  // State to track which products are expanded
  const [expanded, setExpanded] = useState({});

  // Bulk Update State
  const [isPreparingUpdate, setIsPreparingUpdate] = useState(false); // Fetching all IDs
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [productsToUpdate, setProductsToUpdate] = useState([]);

  const [isUpdating, setIsUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [updateResults, setUpdateResults] = useState(null);

  const handleToggle = useCallback((id) => {
    setExpanded((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }, []);

  const handleUpdateSingle = (product) => {
    submit({ intent: "update_single", productId: product.id, sku: product.sku }, { method: "post" });
  };

  // 1. Search Debounce
  const handleSearchChange = useCallback((value) => {
    setSearchQuery(value);
  }, []);

  // Effect to submit search after delay
  useEffect(() => {
    const timer = setTimeout(() => {
      // Create new search params, resetting cursor
      const params = new URLSearchParams(window.location.search);
      if (valueHasChanged(params.get("query"), searchQuery)) {
        params.set("query", searchQuery);
        params.delete("cursor");
        params.delete("direction");
        submit(params);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery, submit]);

  function valueHasChanged(oldVal, newVal) {
    return (oldVal || "") !== (newVal || "");
  }

  // 2. Pagination
  // Get current page from URL or default to 1
  const [searchParams] = useSearchParams();
  const currentPage = parseInt(searchParams.get("page_num") || "1", 10);

  const handleNext = () => {
    if (!pageInfo.hasNextPage) return;
    const params = new URLSearchParams(window.location.search);
    params.set("cursor", pageInfo.endCursor);
    params.set("direction", "next");
    params.set("page_num", currentPage + 1);
    submit(params);
  };

  const handlePrev = () => {
    if (!pageInfo.hasPreviousPage) return;
    const params = new URLSearchParams(window.location.search);
    params.set("cursor", pageInfo.startCursor);
    params.set("direction", "prev");
    params.set("page_num", Math.max(1, currentPage - 1));
    submit(params);
  };

  const handleFirst = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("cursor");
    params.delete("direction");
    params.set("page_num", 1);
    submit(params);
  };

  // 3. Bulk Update Flow
  const handleUpdateAllClick = async () => {
    // 1. Fetch ALL IDs matching current query from SEPARATE API
    setIsPreparingUpdate(true);

    try {
      // Create params based on current search, but ignoring pagination
      const params = new URLSearchParams(window.location.search);
      params.delete("cursor");
      params.delete("direction");

      const response = await fetch(`/api/products?${params.toString()}`);

      if (!response.ok) {
        throw new Error("Failed to fetch product list");
      }

      const data = await response.json();

      if (data && data.allProducts) {
        setProductsToUpdate(data.allProducts);
        setShowConfirmModal(true);
      }
    } catch (error) {
      console.error("Failed to fetch all products for update", error);
    } finally {
      setIsPreparingUpdate(false);
    }
  };

  const confirmUpdate = async () => {
    setShowConfirmModal(false);
    setIsUpdating(true);
    setProgress(0);
    setUpdateResults(null);

    let successCount = 0;
    let failCount = 0;
    const total = productsToUpdate.length;
    const actionUrl = window.location.href; // Current URL for posting back

    // Concurrency Limit
    const CONCURRENCY = 1;
    let completedCount = 0;

    // Worker
    const updateProduct = async (p) => {
      if (!p.sku) {
        failCount++;
        return;
      }

      try {
        const formData = new FormData();
        formData.append("intent", "update_single");
        formData.append("productId", p.id);
        formData.append("sku", p.sku);

        const res = await fetch(actionUrl, {
          method: "POST",
          body: formData
        });

        if (res.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (e) {
        console.error(e);
        failCount++;
      } finally {
        completedCount++;
        setProgress((completedCount / total) * 100);
      }
    };

    // Queue
    const queue = [...productsToUpdate];
    const workers = Array(Math.min(productsToUpdate.length, CONCURRENCY)).fill(null).map(async () => {
      while (queue.length > 0) {
        const p = queue.shift();
        await updateProduct(p);
      }
    });

    await Promise.all(workers);

    setIsUpdating(false);
    setUpdateResults({ success: successCount, fail: failCount });

    // Refresh list
    submit(window.location.search);
  };

  const isNavLoading = nav.state === "loading" || nav.state === "submitting";
  const updatingProductId = isNavLoading && nav.formData?.get("productId");

  return (
    <AppProvider i18n={enTranslations}>
      <Page
        title="Update Prices"
        primaryAction={{
          content: `Update All Prices`, // RENAMED
          onAction: handleUpdateAllClick,
          loading: isPreparingUpdate || isUpdating,
          disabled: isNavLoading || isPreparingUpdate || isUpdating
        }}
      >
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                {/* Search Bar */}
                <TextField
                  label="Search Products"
                  value={searchQuery}
                  onChange={handleSearchChange}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => handleSearchChange("")}
                  placeholder="Search by Title or SKU"
                />

                {/* Result Banner from Single Update (Action Data) */}
                {actionData?.status && !isUpdating && (
                  <Banner tone={actionData.status === "success" ? "success" : "critical"}>
                    <p>{actionData.message}</p>
                    {actionData.action && <p style={{ marginTop: '0.5rem' }}>{actionData.action}</p>}
                    {actionData.loginUrl && (
                      <div style={{ marginTop: '0.5rem' }}>
                        <Button url={actionData.loginUrl} target="_blank">Login to StockX</Button>
                      </div>
                    )}
                  </Banner>
                )}

                {/* Result Banner from Bulk Update (Client State) */}
                {updateResults && !isUpdating && (
                  <Banner tone={updateResults.fail === 0 ? "success" : "warning"}>
                    <p>Bulk update complete. Success: {updateResults.success}, Failed: {updateResults.fail}</p>
                  </Banner>
                )}

                {/* Progress Bar */}
                {isUpdating && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      Updating {productsToUpdate.length} products... {Math.round(progress)}%
                    </Text>
                    <ProgressBar progress={progress} tone="primary" />
                  </BlockStack>
                )}

                {products.length === 0 ? (
                  <BlockStack align="center" inlineAlign="center">
                    <Text tone="subdued">No products found.</Text>
                  </BlockStack>
                ) : (
                  <BlockStack gap="400">
                    {/* Pagination Controls Top */}
                    <InlineStack align="end" gap="200" blockAlign="center">
                      <Button variant="plain" onClick={handleFirst} disabled={!pageInfo?.hasPreviousPage}>First Page</Button>
                      <Pagination
                        hasPrevious={pageInfo?.hasPreviousPage}
                        onPrevious={handlePrev}
                        hasNext={pageInfo?.hasNextPage}
                        onNext={handleNext}
                      />
                      <Text variant="bodyMd" as="span" tone="subdued">Page {currentPage}</Text>
                    </InlineStack>

                    <Text variant="headingMd" as="h2">Products (Page View)</Text>
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
                                  disabled={isNavLoading || isUpdating}
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

                    {/* Pagination Controls Bottom */}
                    <InlineStack align="center" gap="200" blockAlign="center">
                      <Button variant="plain" onClick={handleFirst} disabled={!pageInfo?.hasPreviousPage}>First Page</Button>
                      <Pagination
                        hasPrevious={pageInfo?.hasPreviousPage}
                        onPrevious={handlePrev}
                        hasNext={pageInfo?.hasNextPage}
                        onNext={handleNext}
                      />
                      <Text variant="bodyMd" as="span" tone="subdued">Page {currentPage}</Text>
                    </InlineStack>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Confirmation Modal */}
        <Modal
          open={showConfirmModal}
          onClose={() => setShowConfirmModal(false)}
          title="Confirm Bulk Update"
          primaryAction={{
            content: `Update ${productsToUpdate.length} Products`,
            onAction: confirmUpdate,
            destructive: false,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => setShowConfirmModal(false),
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <p>
                You are about to update prices for <strong>{productsToUpdate.length}</strong> products.
              </p>
              <Banner tone="warning">
                <p>This process may take a while depending on the number of products. Please do not close this tab.</p>
              </Banner>
            </BlockStack>
          </Modal.Section>
        </Modal>

      </Page>
    </AppProvider>
  );
}
