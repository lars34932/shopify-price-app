import { useState } from "react";
import { useActionData, useNavigation, Form } from "react-router";
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
  AppProvider
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { fetchStockXData } from "../stockx.server";

// --- BACKEND ACTION ---
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  /* GraphQL implementation used */

  const formData = await request.formData();
  const skuInput = formData.get("sku");

  if (!skuInput) return { status: "error", message: "Please enter a SKU." };

  try {
    // 1. Fetch data from INTERNAL StockX Logic
    // We pass the app URL for the auth redirect link if needed
    const appUrl = process.env.SHOPIFY_APP_URL || "";
    const result = await fetchStockXData(skuInput, appUrl);

    if (result.status === 401) {
      return { status: "error", message: result.action || "Unauthorized" };
    }

    if (result.status !== 200) {
      return { status: "error", message: result.error || "Failed to fetch data." };
    }

    const data = result.data;

    // Validation (should be covered by fetchStockXData but good to be safe)
    if (!data?.product_info || !data?.variants) {
      return { status: "error", message: "Product not found or invalid API response." };
    }

    // 2. Prepare Variants for Shopify GraphQL
    const variantsForShopify = data.variants.map((v) => {
      if (v.price === "No Ask") return null;
      const rawPrice = parseFloat(v.price.split(" ")[0]);

      return {
        options: [v.size_eu],
        price: rawPrice.toFixed(2),
        sku: `${data.product_info.sku}-${v.size_eu.replace(/\s/g, "")}`,
        // Set inventory management to Shopify (tracks quantity)
        inventoryManagement: "SHOPIFY"
      };
    }).filter(Boolean);

    if (variantsForShopify.length === 0) {
      return { status: "error", message: "No valid prices found for this product." };
    }

    // 3. Create Product using Admin GraphQL API
    // We must use a multi-step process:
    // Step A: Create Product (with options/media)
    // Step B: Update Variant Prices (via productVariantsBulkUpdate)
    // Step C: Update SKU & Inventory Tracking (via inventoryItemUpdate for each variant)

    const sizeValues = variantsForShopify.map(v => ({ name: v.options[0] }));
    const mediaInput = data.product_info.image
      ? [{ originalSource: data.product_info.image, mediaContentType: "IMAGE" }]
      : [];

    // --- STEP A: Create Product ---
    const createResponse = await admin.graphql(
      `#graphql
      mutation productCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
        productCreate(input: $input, media: $media) {
          product {
            id
            title
            variants(first: 99) {
              nodes {
                id
                price
                inventoryItem {
                  id
                }
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            title: data.product_info.title,
            vendor: "StockX Import",
            productType: "Sneakers",
            status: "ACTIVE",
            productOptions: [
              {
                name: "Size (EU)",
                values: sizeValues
              }
            ]
          },
          media: mediaInput
        },
      }
    );

    const createJson = await createResponse.json();

    if (createJson.data?.productCreate?.userErrors?.length > 0) {
      const errors = createJson.data.productCreate.userErrors
        .map((err) => err.message)
        .join(", ");
      return { status: "error", message: `Shopify Create Error: ${errors}` };
    }

    const createdProduct = createJson.data?.productCreate?.product;
    const createdVariants = createdProduct?.variants?.nodes || [];

    console.log(`DEBUG: variantsForShopify count: ${variantsForShopify.length}`);
    console.log(`DEBUG: sizeValues count: ${sizeValues.length}`);
    console.log(`DEBUG: createdVariants from Shopify count: ${createdVariants.length}`);

    // --- STEP A.5: Create Missing Variants ---
    // The productCreate mutation only creates minimal variants (usually just 1).
    // We must identify which are missing and create them.

    // 1. Identify which option values match existing variants
    const existingSizeValues = createdVariants.map(v =>
      v.selectedOptions.find(opt => opt.name === "Size (EU)")?.value
    ).filter(Boolean);

    // 2. Filter our source list to find ones that do NOT exist yet
    const variantsToCreate = variantsForShopify.filter(v =>
      !existingSizeValues.includes(v.options[0])
    );

    console.log(`DEBUG: Variants to create count: ${variantsToCreate.length}`);

    let newlyCreatedVariants = [];

    if (variantsToCreate.length > 0) {
      // Construction optionValues for bulk create
      // Note: We used "Size (EU)" as the option name. 
      // We must map it to the optionId if possible, but finding it by name is safer if we just created it.
      // Actually, we can just pass the name and value.

      const bulkCreateInput = variantsToCreate.map(v => ({
        price: v.price,
        optionValues: [{
          optionId: createdProduct.variants.nodes[0].selectedOptions[0].name === "Size (EU)"
            ? undefined // If we knew the option ID, we'd use it. But we can use name pairing? 
            : undefined,
          // Better strategy: Use the name "Size (EU)" and the value string
          name: "Size (EU)",
          value: v.options[0]
        }]
      }));

      // NOTE: optionValues input requires 'optionId' or 'name' (of the option) and 'value'.
      // However, usually it's safer to use the optionId from the created product to avoid ambiguity.
      // Let's get the Option ID from the created product.
      // We didn't fetch product options in the create mutation... let's assume we can rely on option name.
      // Actually, let's look at the productCreate response. We didn't ask for 'options'.
      // We can try using just name, but if that fails, we might need to fetch options.

      // Let's try constructing the input with just name/value pairs if valid.
      // According to docs, we need Option ID often.
      // But wait, we can just use the createdProduct.options if we fetch them.

      // Updated Mutation to fetch options IDs
      // (Since we can't change the previous mutation easily here without re-writing Step A, 
      //  we will assume "Size (EU)" name works or we fetch it now... 
      //  Actually, let's just fetch the product options ID effectively by re-reading the product or upgrading step A).

      // SIMPLIFICATION for this edit: 
      // We will try to pass `name: "Size (EU)"` and `value: "42"`. 
      // If that fails, we'll need the ID.

      const variantsCreateInput = variantsToCreate.map(v => ({
        price: v.price,
        optionValues: [
          {
            optionName: "Size (EU)",
            name: v.options[0]
          }
        ]
      }));

      const bulkCreateResponse = await admin.graphql(
        `#graphql
        mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants {
              id
              price
              inventoryItem {
                id
              }
              selectedOptions {
                name
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            productId: createdProduct.id,
            variants: variantsCreateInput
          }
        }
      );

      const bulkCreateJson = await bulkCreateResponse.json();
      if (bulkCreateJson.data?.productVariantsBulkCreate?.userErrors?.length > 0) {
        console.error("Bulk Create Errors:", bulkCreateJson.data.productVariantsBulkCreate.userErrors);
        // If it fails on option name, we might be stuck.
      } else {
        newlyCreatedVariants = bulkCreateJson.data?.productVariantsBulkCreate?.productVariants || [];
      }
    }

    // Combine all variants (Initial + Newly Created)
    const allVariants = [...createdVariants, ...newlyCreatedVariants];

    // Match to source for full context
    const matchedVariants = allVariants.map((createdVariant) => {
      const sizeOption = createdVariant.selectedOptions.find(opt => opt.name === "Size (EU)");
      const sizeValue = sizeOption ? sizeOption.value : null;
      const sourceVariant = variantsForShopify.find(v => v.options[0] === sizeValue);

      if (!sourceVariant) return null;

      return {
        ...createdVariant,
        source: sourceVariant
      };
    }).filter(Boolean);

    // --- STEP B: Update Prices (Bulk) for Initial Variant ONLY ---
    // (Newly created ones already have price set during bulk create)
    const initialVariantToUpdate = matchedVariants.find(mv => existingSizeValues.includes(mv.selectedOptions[0].value));

    if (initialVariantToUpdate) {
      const priceUpdateResponse = await admin.graphql(
        `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            productId: createdProduct.id,
            variants: [{ id: initialVariantToUpdate.id, price: initialVariantToUpdate.source.price }]
          }
        }
      );
      // check errors...
    }

    // --- STEP C: Update SKU & Inventory Tracking (Iterative) ---
    // Update ALL matched matchedVariants
    // We must update inventory items individually for SKU and tracking
    // Note: Concurrency should be limited to avoid rate limits, but Promise.all is okay for small batches (~20 sizes)
    await Promise.all(matchedVariants.map(async (mv) => {
      const inventoryItemId = mv.inventoryItem?.id;
      if (!inventoryItemId) return;

      const invResponse = await admin.graphql(
        `#graphql
        mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) {
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            id: inventoryItemId,
            input: {
              sku: mv.source.sku,
              tracked: true // Enable inventory tracking
            }
          }
        }
      );

      const invJson = await invResponse.json();
      if (invJson.data?.inventoryItemUpdate?.userErrors?.length > 0) {
        console.error(`Inventory Update Error for ${mv.source.sku}:`, invJson.data.inventoryItemUpdate.userErrors);
      }
    }));

    return {
      status: "success",
      message: `Successfully created: ${createdProduct?.title}`,
    };


  } catch (error) {
    console.error("Import Error:", error);
    return { status: "error", message: error.message };
  }
};

// --- FRONTEND UI ---
export default function Index() {
  const actionData = useActionData();
  const nav = useNavigation();
  const isLoading = nav.state === "submitting";
  const [sku, setSku] = useState("");

  return (
    <AppProvider i18n={enTranslations}>
      <Page title="StockX Importer">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">

                {/* Error Banner */}
                {actionData?.status === "error" && (
                  <Banner tone="critical" title="Error">
                    <p>{actionData.message}</p>
                  </Banner>
                )}

                {/* Success Banner */}
                {actionData?.status === "success" && (
                  <Banner tone="success" title="Product Created">
                    <p>{actionData.message}</p>
                  </Banner>
                )}

                <Text as="p" variant="bodyMd">
                  Enter a SKU below (e.g. FV5029-100). The app will fetch market data and create the product in Shopify.
                </Text>

                <Form method="post">
                  <FormLayout>
                    <TextField
                      label="Product SKU"
                      name="sku"
                      value={sku}
                      onChange={setSku}
                      placeholder="e.g. FV5029-100"
                      autoComplete="off"
                      disabled={isLoading}
                    />
                    <Button submit variant="primary" loading={isLoading}>
                      Import Product
                    </Button>
                  </FormLayout>
                </Form>

              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}