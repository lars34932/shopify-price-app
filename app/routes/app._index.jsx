import { useState } from "react";
import { useActionData, useNavigation, Form, useSubmit } from "react-router";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
  Text,
  BlockStack,
  Banner,
  AppProvider,
  ProgressBar
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
// --- FRONTEND UI ---
export default function Index() {
  // const actionData = useActionData(); // Not using actionData directly for list anymore

  const [skus, setSkus] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [progressState, setProgressState] = useState({ current: 0, total: 0, percent: 0 });
  const [results, setResults] = useState({ success: [], failed: [] });

  const handleImport = async () => {
    const skuList = skus.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (skuList.length === 0) return;

    setIsImporting(true);
    setProgressState({ current: 0, total: skuList.length, percent: 0 });
    setResults({ success: [], failed: [] });

    let completed = 0;
    const total = skuList.length;

    // Use the dedicated API route for import actions
    const actionUrl = "/app/api/import";

    for (const sku of skuList) {
      try {              // STEP 1: Fetch StockX Data
        const fetchFormData = new FormData();
        fetchFormData.append("intent", "fetch_stockx");
        fetchFormData.append("sku", sku);

        const fetchResponse = await fetch(actionUrl, {
          method: "POST",
          body: fetchFormData,
          redirect: "manual" // IMPORTANT: Don't follow auth redirects
        });

        if (fetchResponse.type === "opaqueredirect" || fetchResponse.status === 0 || fetchResponse.status > 299) {
          if (fetchResponse.status === 302 || fetchResponse.type === "opaqueredirect" || fetchResponse.status === 401) {
            setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: Session Expired (Please Refresh)`] }));
            // Optional: Stop everything if auth is gone?
            // setIsImporting(false); return; 
            continue;
          }
          setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: Fetch Network Error (${fetchResponse.status})`] }));
          continue;
        }

        let fetchData;
        try {
          const text = await fetchResponse.text();
          if (text.trim().startsWith("<")) {
            console.log("FULL HTML RESPONSE (FETCH):", text);
            throw new Error("Received HTML instead of JSON. Check Console for details.");
          }
          fetchData = JSON.parse(text);
        } catch (err) {
          setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: ${err.message}`] }));
          continue;
        }

        if (fetchData.status !== "success") {
          setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: ${fetchData.message}`] }));
          continue;
        }

        // STEP 2: Create Shopify Product
        const createFormData = new FormData();
        createFormData.append("intent", "create_shopify");
        createFormData.append("data", JSON.stringify(fetchData.data));

        const createResponse = await fetch(actionUrl, {
          method: "POST",
          body: createFormData,
          redirect: "manual"
        });

        if (createResponse.type === "opaqueredirect" || createResponse.status === 0 || createResponse.status > 299) {
          if (createResponse.status === 302 || createResponse.type === "opaqueredirect" || createResponse.status === 401) {
            setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: Session Expired (Please Refresh)`] }));
            continue;
          }
          setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: Create Network Error (${createResponse.status})`] }));
          continue;
        }

        let createData;
        try {
          const text = await createResponse.text();
          if (text.trim().startsWith("<")) {
            console.log("FULL HTML RESPONSE (CREATE):", text);
            throw new Error("Received HTML instead of JSON. Check Console for details.");
          }
          createData = JSON.parse(text);
        } catch (err) {
          setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: ${err.message}`] }));
          continue;
        }

        if (createData.status === "success") {
          setResults(prev => ({ ...prev, success: [...prev.success, `${sku} (${createData.title})`] }));
        } else {
          setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: ${createData.message}`] }));
        }

      } catch (e) {
        console.error("Client Loop Error:", e);
        setResults(prev => ({ ...prev, failed: [...prev.failed, `${sku}: Error - ${e.message}`] }));
      } finally {
        completed++;
        const percent = Math.round((completed / total) * 100);
        setProgressState({ current: completed, total: total, percent: percent });

        // Small delay between products
        if (total > 1) await new Promise(r => setTimeout(r, 500));
      }
    }

    setIsImporting(false);
  };

  return (
    <AppProvider i18n={enTranslations}>
      <Page title="StockX Bulk Importer">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">

                {/* Result Banners */}
                {results.success.length > 0 && !isImporting && (
                  <Banner tone="success" title="Import Successful">
                    <p>Imported {results.success.length} products.</p>
                    <ul style={{ maxHeight: "100px", overflowY: "auto" }}>
                      {results.success.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </Banner>
                )}

                {results.failed.length > 0 && !isImporting && (
                  <Banner tone="warning" title="Some Imports Failed">
                    <p>Failed to import {results.failed.length} products.</p>
                    <ul>
                      {results.failed.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </Banner>
                )}

                <Text as="p" variant="bodyMd">
                  Enter SKUs below (one per line). The app will process them one by one.
                </Text>

                <FormLayout>
                  <TextField
                    label="Product SKUs"
                    value={skus}
                    onChange={setSkus}
                    placeholder="FV5029-100&#10;CW2288-111&#10;..."
                    multiline={6}
                    autoComplete="off"
                    disabled={isImporting}
                    helpText="One SKU per line."
                  />

                  {isImporting && (
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        {`Importing ${progressState.current}/${progressState.total} products... ${progressState.percent}%`}
                      </Text>
                      <ProgressBar progress={progressState.percent} tone="primary" />
                    </BlockStack>
                  )}

                  <Button
                    onClick={handleImport}
                    variant="primary"
                    loading={isImporting}
                    disabled={!skus.trim() || isImporting}
                  >
                    {isImporting ? "Importing..." : "Start Bulk Import"}
                  </Button>
                </FormLayout>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}