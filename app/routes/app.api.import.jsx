import { authenticate } from "../shopify.server";
import { fetchStockXData } from "../stockx.server";
import { calculateMarkupPrice } from "../shopify.sync";

// Helper for consistent JSON responses
const jsonResponse = (data, status = 200) => {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
};

// Helper function to only create the product in Shopify (using pre-fetched data)
async function createShopifyProductFromData(admin, data) {
    // 2. Prepare Variants
    const variantsForShopify = data.variants.map((v) => {
        if (v.price === "No Ask") return null;
        const rawPrice = parseFloat(v.price.split(" ")[0]);

        return {
            options: [v.size_eu],
            price: calculateMarkupPrice(rawPrice),
            sku: `${data.product_info.sku}-${v.size_eu.replace(/\s/g, "")}`,
            inventoryManagement: "SHOPIFY"
        };
    }).filter(Boolean);

    if (variantsForShopify.length === 0) {
        return { status: "error", message: "No valid prices found for this product." };
    }

    const sizeValues = variantsForShopify.map(v => ({ name: v.options[0] }));
    const mediaInput = data.product_info.image
        ? [{ originalSource: data.product_info.image, mediaContentType: "IMAGE" }]
        : [];

    // --- STEP 0: Ensure Collection Exists (Brand) ---
    const brand = data.product_info.brand;
    let existingCollection = null;

    if (!brand || typeof brand !== 'string') {
        console.log("Brand missing or invalid: brand data not found in StockX response.");
    } else {
        // --- STEP -1: Check for Existing Product (Duplicate Check) ---
        // We check by Tag (fastest/most accurate for our new imports) OR by Title (fallback for legacy imports)
        // Note: We'll add the SKU as a tag to new products.
        const skuToCheck = data.product_info.sku;
        const titleToCheck = data.product_info.title;
        // Escape quotes to prevent GraphQL errors
        const safeSku = skuToCheck.replace(/"/g, '\\"');
        const safeTitle = titleToCheck.replace(/"/g, '\\"');

        try {
            const duplicateQuery = await admin.graphql(
                `#graphql
              query products($query: String!) {
                products(first: 1, query: $query) {
                  edges {
                    node {
                      id
                      title
                      handle
                    }
                  }
                }
              }`,
                {
                    variables: {
                        // Query looks for exact tag match OR exact title phrase match
                        query: `tag:"${safeSku}" OR title:"${safeTitle}"`
                    }
                }
            );
            const duplicateJson = await duplicateQuery.json();
            const existingProduct = duplicateJson.data?.products?.edges?.[0]?.node;

            if (existingProduct) {
                console.log(`Duplicate found: ${existingProduct.title} (ID: ${existingProduct.id})`);
                return { status: "warning", message: `Product already exists: ${existingProduct.title}` };
            }
        } catch (err) {
            console.error("Duplicate Check Failed:", err);
            // Non-critical, continue
        }

        // Check if collection exists
        try {
            const collectionQuery = await admin.graphql(
                `#graphql
              query collections($query: String!) {
                collections(first: 1, query: $query) {
                  edges { 
                    node { 
                      id
                      title
                      ruleSet {
                        rules {
                          column
                        }
                      }
                    } 
                  }
                }
              }`,
                { variables: { query: `title:${brand}` } }
            );
            const collectionJson = await collectionQuery.json();
            existingCollection = collectionJson.data?.collections?.edges?.[0]?.node;

            if (existingCollection) {
                console.log(`Brand collection exists: ${brand}`);
            } else {
                console.log(`Brand collection missing, adding: ${brand}`);
                // Create Smart Collection for Brand
                try {
                    await admin.graphql(
                        `#graphql
                     mutation collectionCreate($input: CollectionInput!) {
                       collectionCreate(input: $input) {
                         collection { id }
                         userErrors { field, message }
                       }
                     }`,
                        {
                            variables: {
                                input: {
                                    title: brand,
                                    ruleSet: {
                                        appliedDisjunctively: false,
                                        rules: [{ column: "VENDOR", relation: "EQUALS", condition: brand }]
                                    }
                                }
                            }
                        }
                    );
                    console.log(`Brand collection added: ${brand}`);
                } catch (err) {
                    console.error("Failed to create brand collection:", err);
                    // Non-critical, continue
                }
            }
        } catch (err) {
            console.error("Collection Query Failed:", err);
            // Non-critical
        }
    }

    const finalVendor = brand || "StockX Import";

    // --- STEP A: Create Product ---
    let createResponse;
    try {
        createResponse = await admin.graphql(
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
                    inventoryItem { id }
                    selectedOptions { name, value }
                  }
                }
              }
              userErrors { field, message }
            }
          }`,
            {
                variables: {
                    input: {
                        title: data.product_info.title,
                        vendor: finalVendor,
                        productType: "Sneakers",
                        status: "ACTIVE",
                        productOptions: [
                            {
                                name: "Size (EU)",
                                values: sizeValues
                            }
                        ],
                        tags: ["stockx-sync", data.product_info.sku]
                    },
                    media: mediaInput
                },
            }
        );
    } catch (err) {
        console.error("Product Create Mutation Failed:", err);
        throw new Error(`Product Create Failed: ${err.message}`);
    }

    const createJson = await createResponse.json();

    if (createJson.data?.productCreate?.userErrors?.length > 0) {
        const errors = createJson.data.productCreate.userErrors
            .map((err) => err.message)
            .join(", ");
        return { status: "error", message: `Shopify Create Error: ${errors}` };
    }

    const createdProduct = createJson.data?.productCreate?.product;
    const createdVariants = createdProduct?.variants?.nodes || [];

    // --- STEP A.5: Create Missing Variants ---
    const existingSizeValues = createdVariants.map(v =>
        v.selectedOptions.find(opt => opt.name === "Size (EU)")?.value
    ).filter(Boolean);

    const variantsToCreate = variantsForShopify.filter(v =>
        !existingSizeValues.includes(v.options[0])
    );

    let newlyCreatedVariants = [];

    if (variantsToCreate.length > 0) {
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
              inventoryItem { id }
              selectedOptions { name, value }
            }
            userErrors { field, message }
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
            // console.error("Bulk Create Errors:", bulkCreateJson.data.productVariantsBulkCreate.userErrors);
        } else {
            newlyCreatedVariants = bulkCreateJson.data?.productVariantsBulkCreate?.productVariants || [];
        }
    }

    // Combine variants
    const allVariants = [...createdVariants, ...newlyCreatedVariants];
    const matchedVariants = allVariants.map((createdVariant) => {
        const sizeOption = createdVariant.selectedOptions.find(opt => opt.name === "Size (EU)");
        const sizeValue = sizeOption ? sizeOption.value : null;
        const sourceVariant = variantsForShopify.find(v => v.options[0] === sizeValue);
        if (!sourceVariant) return null;
        return { ...createdVariant, source: sourceVariant };
    }).filter(Boolean);

    // --- STEP B: Update Prices (Bulk) for Initial Variant ONLY ---
    const initialVariantToUpdate = matchedVariants.find(mv => existingSizeValues.includes(mv.selectedOptions[0].value));

    if (initialVariantToUpdate) {
        await admin.graphql(
            `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { field, message }
          }
        }`,
            {
                variables: {
                    productId: createdProduct.id,
                    variants: [{ id: initialVariantToUpdate.id, price: initialVariantToUpdate.source.price }]
                }
            }
        );
    }

    // --- STEP C: Update SKU & Inventory Tracking ---
    // --- STEP C: Update SKU & Inventory Tracking ---
    // Serialized to prevent "fetch failed" errors from concurrency
    for (const mv of matchedVariants) {
        const inventoryItemId = mv.inventoryItem?.id;
        if (!inventoryItemId) continue;

        try {
            const response = await admin.graphql(
                `#graphql
            mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                userErrors { field, message }
              }
            }`,
                {
                    variables: {
                        id: inventoryItemId,
                        input: { sku: mv.source.sku, tracked: true }
                    }
                }
            );

            const responseJson = await response.json();
            const userErrors = responseJson.data?.inventoryItemUpdate?.userErrors;

            if (userErrors && userErrors.length > 0) {
                console.error(`Failed to update inventory/SKU for variant ${mv.id}:`, userErrors);
            }

        } catch (err) {
            console.error(`Failed to update inventory for variant ${mv.id}:`, err);
            // Continue processing other variants even if one fails
        }
    }

    // --- STEP D: Add to Manual Collection (If applicable) ---
    if (existingCollection && !existingCollection.ruleSet) {
        // It's a manual collection, so we must explicitly add the product
        console.log(`Adding product to Manual Collection: ${existingCollection.title}`);
        await admin.graphql(
            `#graphql
            mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
              collectionAddProducts(id: $id, productIds: $productIds) {
                userErrors { field, message }
              }
            }`,
            {
                variables: {
                    id: existingCollection.id,
                    productIds: [createdProduct.id]
                }
            }
        );
    } else if (existingCollection && existingCollection.ruleSet) {
        console.log(`Product matches Smart Collection '${existingCollection.title}' via Vendor rule (automatic).`);
    }

    return { status: "success", title: createdProduct.title };
}

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    const appUrl = process.env.SHOPIFY_APP_URL || "";

    try {
        if (intent === "fetch_stockx") {
            const sku = formData.get("sku");
            if (!sku) return jsonResponse({ status: "error", message: "Missing SKU" });

            const result = await fetchStockXData(sku, appUrl);

            if (result.status === 401) return jsonResponse({
                status: "error",
                message: result.action || "Unauthorized",
                loginUrl: result.loginUrl
            });
            if (result.status !== 200) return jsonResponse({ status: "error", message: result.error || "Failed to fetch data." });

            const data = result.data;
            if (!data?.product_info || !data?.variants) {
                return jsonResponse({ status: "error", message: "Product not found or invalid API response." });
            }

            return jsonResponse({ status: "success", data: data });
        }

        if (intent === "create_shopify") {
            const dataJson = formData.get("data");
            if (!dataJson) return jsonResponse({ status: "error", message: "Missing Data" });

            const data = JSON.parse(dataJson);
            const res = await createShopifyProductFromData(admin, data);
            return jsonResponse(res);
        }

        return jsonResponse({ status: "error", message: "Unknown Intent" });

    } catch (e) {
        console.error("[API Action Error]", e);
        return jsonResponse({ status: "error", message: e.message }, 500);
    }
};
