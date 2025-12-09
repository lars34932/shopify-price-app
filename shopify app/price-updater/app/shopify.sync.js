export function calculateMarkupPrice(basePrice) {
    let markup = 0;
    if (basePrice <= 100) markup = 40;
    else if (basePrice <= 200) markup = 55;
    else if (basePrice <= 400) markup = 75;
    else markup = 110;

    let price = basePrice + markup;

    // Round to nearest 5
    price = Math.round(price / 5) * 5;

    // Subtract 0.01 to get .99
    price = price - 0.01;

    return price.toFixed(2);
}

export async function updateShopifyProduct(admin, product, stockxData) {
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
        return { status: "warning", message: "No valid prices found to update." };
    }

    // 2. Fetch Existing Variants (if not full provided)
    // We expect 'product' to have 'id' and 'variants'. 
    // If the variants data is thin, we might need to refetch, but let's assume valid start or fetch here.
    // Ideally, we fetch fresh data to be safe.

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
    const currentProduct = productJson.data.product;
    const currentVariants = currentProduct.variants.nodes;

    // 3. Identify Missing Variants
    const existingSizeValues = currentVariants.map(v =>
        v.selectedOptions.find(opt => opt.name === "Size (EU)")?.value
    ).filter(Boolean);

    const variantsToCreate = variantsForShopify.filter(v =>
        !existingSizeValues.includes(v.options[0])
    );

    let newlyCreatedVariants = [];

    // 4. Bulk Create Missing
    if (variantsToCreate.length > 0) {
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
    }

    // 6. Update Inventory / SKU (Slow loop)
    // We can't turbo this too much without hitting rate limits, but standard promise.all is ok for small batches
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

    return { status: "success", message: `Updated ${matchedVariants.length} variants.` };
}
