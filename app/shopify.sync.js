export function calculateMarkupPrice(basePrice) {
    let markup = 0;
    if (basePrice <= 100) markup = 40;
    else if (basePrice <= 200) markup = 55;
    else if (basePrice <= 400) markup = 75;
    else markup = 110;

    let price = basePrice + markup;

    // Round to nearest 5
    price = Math.round(price / 5) * 5;

    // Subtract 0.10 to get .90
    price = price - 0.10;

    return price.toFixed(2);
}

export async function updateShopifyProduct(admin, product, stockxData) {
    console.log(`[Shopify Sync] Starting update for product ID: ${product.id}`);
    const timeLabel = `Shopify Sync Total (${product.id})`;
    console.time(timeLabel);

    // 1. Prepare StockX Variants
    const variantsForShopify = stockxData.variants.map((v) => {
        if (v.price === "No Ask") return null;
        const rawPrice = parseFloat(v.price.split(" ")[0]);

        return {
            options: [v.size_eu],
            price: calculateMarkupPrice(rawPrice),
            sku: `${stockxData.product_info.sku}-${v.size_eu.replace(/\s/g, "")}`,
            inventoryManagement: "SHOPIFY"
        };
    }).filter(Boolean).sort((a, b) => {
        const sizeA = parseFloat(a.options[0]);
        const sizeB = parseFloat(b.options[0]);
        return sizeA - sizeB;
    });

    if (variantsForShopify.length === 0) {
        console.warn("[Shopify Sync] No valid prices found.");
        return { status: "warning", message: "No valid prices found to update." };
    }

    // 2. Fetch Existing Variants (if not full provided)
    // We expect 'product' to have 'id' and 'variants'. 
    // If the variants data is thin, we might need to refetch, but let's assume valid start or fetch here.
    // Ideally, we fetch fresh data to be safe.

    console.time(`Sync: Fetch Current Variants (${product.id})`);
    const productQuery = await admin.graphql(
        `#graphql
    query getProductVariants($id: ID!) {
      product(id: $id) {
        id
        title
        variants(first: 200) {
          nodes {
            id
            price
            inventoryItem { id }
            selectedOptions { name, value }
          }
        }
      }
    }`,
        { variables: { id: product.id } }
    );

    const productJson = await productQuery.json();
    console.timeEnd(`Sync: Fetch Current Variants (${product.id})`);
    const currentProduct = productJson.data.product;
    const currentVariants = currentProduct.variants.nodes;
    console.log(`[Shopify Sync] Fetched ${currentVariants.length} existing variants.`);

    // 3. Identify Missing Variants (to Create) AND Extra Variants (to Delete)
    const existingSizeValues = currentVariants.map(v =>
        v.selectedOptions.find(opt => opt.name === "Size (EU)")?.value
    ).filter(Boolean);

    // Filter our source list to find ones that do NOT exist yet
    const variantsToCreate = variantsForShopify.filter(v =>
        !existingSizeValues.includes(v.options[0])
    );

    // Identify variants that exist in Shopify but NOT in the valid StockX list (No Ask)
    // We only delete variants if they belong to "Size (EU)" options.
    const validNewSizes = variantsForShopify.map(v => v.options[0]);

    // Find Shopify variants whose size is NOT in validNewSizes
    const variantsToDelete = currentVariants.filter(v => {
        const sizeVal = v.selectedOptions.find(opt => opt.name === "Size (EU)")?.value;
        // If we found a size value, and it's NOT in our valid list, mark for deletion
        return sizeVal && !validNewSizes.includes(sizeVal);
    });

    if (variantsToDelete.length > 0) {
        console.log(`[Shopify] Deleting ${variantsToDelete.length} variants (No Ask)...`);
        try {
            const deleteIds = variantsToDelete.map(v => v.id);
            console.time(`Sync: Delete Variants (${product.id})`);
            const deleteResponse = await admin.graphql(
                `#graphql
                mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
                    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
                        userErrors {
                            field
                            message
                        }
                    }
                }`,
                {
                    variables: {
                        productId: currentProduct.id,
                        variantsIds: deleteIds
                    }
                }
            );

            const deleteJson = await deleteResponse.json();
            if (deleteJson.data?.productVariantsBulkDelete?.userErrors?.length > 0) {
                console.error("Delete Errors:", deleteJson.data.productVariantsBulkDelete.userErrors);
            }
            console.timeEnd(`Sync: Delete Variants (${product.id})`);
        } catch (err) {
            console.error("Failed to delete variants:", err);
        }
    }

    let newlyCreatedVariants = [];

    // 4. Bulk Create Missing
    if (variantsToCreate.length > 0) {
        console.log(`[Shopify Sync] Creating ${variantsToCreate.length} new variants...`);
        console.time(`Sync: Create Variants (${product.id})`);
        const variantsCreateInput = variantsToCreate.map(v => ({
            price: v.price,
            optionValues: [{ optionName: "Size (EU)", name: v.options[0] }]
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
                    productId: currentProduct.id,
                    variants: variantsCreateInput
                }
            }
        );

        const bulkCreateJson = await bulkCreateResponse.json();
        if (bulkCreateJson.data?.productVariantsBulkCreate?.userErrors?.length > 0) {
            console.error("Bulk Create Errors:", bulkCreateJson.data.productVariantsBulkCreate.userErrors);
        } else {
            newlyCreatedVariants = bulkCreateJson.data?.productVariantsBulkCreate?.productVariants || [];
        }
        console.timeEnd(`Sync: Create Variants (${product.id})`);
    }

    // 5. Bulk Update Existing
    const allVariants = [...currentVariants, ...newlyCreatedVariants];
    const matchedVariants = allVariants.map((createdVariant) => {
        const sizeOption = createdVariant.selectedOptions.find(opt => opt.name === "Size (EU)");
        const sizeValue = sizeOption ? sizeOption.value : null;
        const sourceVariant = variantsForShopify.find(v => v.options[0] === sizeValue);
        if (!sourceVariant) return null;
        return { ...createdVariant, source: sourceVariant };
    }).filter(Boolean);

    // We only need to update the *prices* of the *existing* variants. New ones are already correct.
    // Actually, let's just batch update ALL to be safe and simple, or filter.
    // BulkUpdate is cheap.

    const variantsToUpdate = matchedVariants.map(mv => ({
        id: mv.id,
        price: mv.source.price
    }));

    if (variantsToUpdate.length > 0) {
        console.log(`[Shopify Sync] Updating prices for ${variantsToUpdate.length} variants...`);
        console.time(`Sync: Update Prices (${product.id})`);
        const priceUpdateResponse = await admin.graphql(
            `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { field, message }
          }
        }`,
            {
                variables: {
                    productId: currentProduct.id,
                    variants: variantsToUpdate
                }
            }
        );
        console.timeEnd(`Sync: Update Prices (${product.id})`);
    }

    // 6. Update Inventory / SKU (Slow loop)
    // We can't turbo this too much without hitting rate limits, but standard promise.all is ok for small batches
    console.log(`[Shopify Sync] Updating Inventory/SKU for ${matchedVariants.length} variants...`);
    console.time(`Sync: Inventory/SKU Update (${product.id})`);

    await Promise.all(matchedVariants.map(async (mv) => {
        const inventoryItemId = mv.inventoryItem?.id;
        if (!inventoryItemId) return;

        // Only update if SKU is different usually, but blind update is fine for now
        await admin.graphql(
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
    }));
    console.timeEnd(`Sync: Inventory/SKU Update (${product.id})`);

    // 7. Reorder Option Values (Ensures variants are sorted by size)
    // We must sort the option values, which implicitly sorts the variants in Shopify.
    console.log("[Shopify Sync] Reordering option values for Size (EU)...");
    console.time(`Sync: Reorder Options (${product.id})`);

    // Fetch fresh product data to get current option values (including new ones)
    const freshProductQuery = await admin.graphql(
        `#graphql
        query getProductOptions($id: ID!) {
            product(id: $id) {
                options {
                    id
                    name
                    values
                }
            }
        }`,
        { variables: { id: currentProduct.id } }
    );
    const freshProductJson = await freshProductQuery.json();
    const freshOptions = freshProductJson.data?.product?.options || [];
    const sizeOption = freshOptions.find(o => o.name === "Size (EU)");

    if (sizeOption) {
        console.log("[Shopify Sync] Found option values to sort:", sizeOption.values);

        // Helper to extract numeric value
        const getNum = (str) => {
            // Match digits, optional dot/comma, then more digits
            // e.g. "42", "42.5", "42,5", "EU 42"
            const match = String(str).match(/(\d+[.,]?\d*)/);
            if (!match) return 0;
            return parseFloat(match[0].replace(',', '.'));
        };

        // Sort values numerically
        const sortedValues = [...sizeOption.values].sort((a, b) => {
            const valA = getNum(a);
            const valB = getNum(b);
            return valA - valB;
        });

        console.log("[Shopify Sync] Sorted values:", sortedValues);

        // Only reorder if needed (simple check, or just always do it safely)
        // Check if order is different
        const isDifferent = JSON.stringify(sizeOption.values) !== JSON.stringify(sortedValues);

        if (isDifferent) {
            console.log("[Shopify Sync] Order changed, updating Shopify...");
            const reorderResponse = await admin.graphql(
                `#graphql
                mutation productOptionsReorder($productId: ID!, $options: [OptionReorderInput!]!) {
                    productOptionsReorder(productId: $productId, options: $options) {
                        userErrors {
                            field
                            message
                        }
                    }
                }`,
                {
                    variables: {
                        productId: currentProduct.id,
                        options: [
                            {
                                id: sizeOption.id,
                                values: sortedValues.map(v => ({ name: v }))
                            }
                        ]
                    }
                }
            );

            const reorderJson = await reorderResponse.json();
            if (reorderJson.data?.productOptionsReorder?.userErrors?.length > 0) {
                console.error("Reorder Errors:", reorderJson.data.productOptionsReorder.userErrors);
            }
        } else {
            console.log("[Shopify Sync] Order is already correct.");
        }
    }
    console.timeEnd(`Sync: Reorder Options (${product.id})`);

    console.timeEnd(timeLabel);

    return { status: "success", message: `Updated ${matchedVariants.length} variants.` };
}
