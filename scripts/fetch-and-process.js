const fs = require('fs');
const path = require('path');

const cruiseApiToken = process.env.CRUISE_TECH_API_TOKEN;
const storesApiKey = process.env.STORES_API_KEY;

if (!cruiseApiToken) {
  console.error('✗ Error: CRUISE_TECH_API_TOKEN environment variable not set');
  process.exit(1);
}

if (!storesApiKey) {
  console.warn('⚠ Warning: STORES_API_KEY not set - StoreS data will be skipped');
}

const cruiseHeaders = new Headers();
cruiseHeaders.append("Authorization", `Bearer ${cruiseApiToken}`);

const cruiseRequestOptions = {
  method: 'GET',
  headers: cruiseHeaders,
  redirect: 'follow'
};

async function fetchAndProcess() {
  try {
    let cruiseData = null;
    let storesData = null;

    // Fetch Cruise Tech Data
    console.log('Fetching Cruise Tech Logs data...');
    cruiseData = await fetchCruiseData();

    // Fetch StoreS Data (if API key is available)
    if (storesApiKey) {
      console.log('Fetching StoreS data...');
      storesData = await fetchStoresData();
    } else {
      console.log('Skipping StoreS data (no API key)');
      storesData = { products: [], orders: [] };
    }

    // Process the combined data
    const processed = {
      timestamp: new Date().toISOString(),
      cruise_tech: {
        rental_types: cruiseData.rental_types || {},
        countries: cruiseData.countries || [],
        summary: cruiseData.summary || {}
      },
      stores: {
        products: storesData.products || [],
        orders: storesData.orders || [],
        summary: storesData.summary || {}
      },
      combined_summary: {
        total_rental_types: cruiseData.summary?.total_types || 0,
        total_countries: cruiseData.summary?.total_countries || 0,
        total_products: (storesData.products || []).length,
        total_orders: (storesData.orders || []).length,
        total_revenue: calculateTotalRevenue(storesData.orders || [])
      }
    };

    // Save raw responses
    saveFile('data/raw-rental-types.json', cruiseData.typesRaw || {});
    saveFile('data/raw-countries.json', cruiseData.countriesRaw || {});
    if (storesData.productsRaw) saveFile('data/raw-products.json', storesData.productsRaw);
    if (storesData.ordersRaw) saveFile('data/raw-orders.json', storesData.ordersRaw);

    // Save processed data
    saveFile('data/processed.json', processed);

    // Generate report
    generateReport(processed);

    console.log('\n✓ All data fetched and processed successfully!');

  } catch (error) {
    console.error(`\n✗ Error: ${error.message}`);
    process.exit(1);
  }
}

async function fetchCruiseData() {
  try {
    // Fetch rental types
    console.log('  → Fetching rental types...');
    const typesResponse = await fetch(
      "https://api.cruisetechlogs.com/rentals/types",
      cruiseRequestOptions
    );

    if (!typesResponse.ok) {
      throw new Error(`HTTP ${typesResponse.status}: ${typesResponse.statusText}`);
    }

    const typesData = await typesResponse.json();

    if (typesData.code !== 200) {
      throw new Error(`API Error: ${typesData.message}`);
    }

    console.log(`  ✓ Fetched ${typesData.data.length} rental types`);

    // Fetch countries
    console.log('  → Fetching countries...');
    const countriesResponse = await fetch(
      "https://api.cruisetechlogs.com/rentals/countries?network=5&type=short_term",
      cruiseRequestOptions
    );

    if (!countriesResponse.ok) {
      throw new Error(`HTTP ${countriesResponse.status}: ${countriesResponse.statusText}`);
    }

    const countriesData = await countriesResponse.json();

    if (countriesData.code !== 200) {
      throw new Error(`API Error: ${countriesData.message}`);
    }

    console.log(`  ✓ Fetched ${countriesData.data.length} countries`);

    // Process rental types
    const rentalTypes = processRentalTypes(typesData);

    return {
      rental_types: rentalTypes,
      countries: countriesData.data || [],
      summary: {
        total_types: typesData.data?.length || 0,
        total_countries: countriesData.data?.length || 0,
        types_by_category: Object.keys(rentalTypes).length
      },
      typesRaw: typesData,
      countriesRaw: countriesData
    };
  } catch (error) {
    throw new Error(`Failed to fetch Cruise Tech data: ${error.message}`);
  }
}

async function fetchStoresData() {
  try {
    const baseUrl = 'https://storesm.net/api';
    const productsRaw = [];
    const ordersRaw = [];

    // Fetch products (limit to first 50)
    console.log('  → Fetching products...');
    for (let i = 1; i <= 5; i++) {
      try {
        const productResponse = await fetch(
          `${baseUrl}/product.php?api_key=${storesApiKey}&product=${i}`
        );
        if (productResponse.ok) {
          const product = await productResponse.json();
          if (product && product.id) {
            productsRaw.push(product);
          }
        }
      } catch (e) {
        // Continue if individual product fetch fails
        continue;
      }
    }
    console.log(`  ✓ Fetched ${productsRaw.length} products`);

    // Fetch recent orders (limit to first 10)
    console.log('  → Fetching orders...');
    for (let i = 1; i <= 10; i++) {
      try {
        const orderResponse = await fetch(
          `${baseUrl}/order.php?api_key=${storesApiKey}&order=${i}`
        );
        if (orderResponse.ok) {
          const order = await orderResponse.json();
          if (order && order.id) {
            ordersRaw.push(order);
          }
        }
      } catch (e) {
        // Continue if individual order fetch fails
        continue;
      }
    }
    console.log(`  ✓ Fetched ${ordersRaw.length} orders`);

    return {
      products: processProducts(productsRaw),
      orders: processOrders(ordersRaw),
      summary: {
        total_products: productsRaw.length,
        total_orders: ordersRaw.length,
        total_revenue: calculateTotalRevenue(ordersRaw)
      },
      productsRaw,
      ordersRaw
    };
  } catch (error) {
    console.warn(`⚠ Warning: Failed to fetch StoreS data: ${error.message}`);
    return {
      products: [],
      orders: [],
      summary: { total_products: 0, total_orders: 0, total_revenue: 0 }
    };
  }
}

function processRentalTypes(data) {
  if (!data.data) return {};

  const grouped = {};
  data.data.forEach(item => {
    if (!grouped[item.type]) {
      grouped[item.type] = [];
    }
    grouped[item.type].push({
      network: item.network,
      title: item.title
    });
  });

  return grouped;
}

function processProducts(products) {
  return products.map(p => ({
    id: p.id,
    name: p.name || p.title || 'Unknown',
    price: parseFloat(p.price) || 0,
    status: p.status || 'active',
    category: p.category || 'uncategorized'
  }));
}

function processOrders(orders) {
  return orders.map(o => ({
    id: o.id,
    total: parseFloat(o.total) || parseFloat(o.amount) || 0,
    status: o.status || 'pending',
    date: o.date || o.created_at || new Date().toISOString(),
    items: o.items || []
  }));
}

function calculateTotalRevenue(orders) {
  return orders.reduce((sum, order) => {
    return sum + (parseFloat(order.total) || parseFloat(order.amount) || 0);
  }, 0);
}

function saveFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✓ Saved: ${filePath}`);
}

function generateReport(data) {
  let report = `# Cruise Tech Logs & StoreS API Report\n\n`;
  report += `**Generated:** ${data.timestamp}\n\n`;

  // Summary
  report += `## Summary\n`;
  report += `- Total Rental Types: ${data.combined_summary.total_rental_types}\n`;
  report += `- Total Countries: ${data.combined_summary.total_countries}\n`;
  report += `- Total Products: ${data.combined_summary.total_products}\n`;
  report += `- Total Orders: ${data.combined_summary.total_orders}\n`;
  report += `- Total Revenue: $${data.combined_summary.total_revenue.toFixed(2)}\n\n`;

  // Cruise Tech Data
  report += `## Cruise Tech Logs - Rental Types\n`;
  Object.entries(data.cruise_tech.rental_types).forEach(([type, networks]) => {
    report += `\n### ${type.toUpperCase()}\n`;
    networks.forEach(net => {
      report += `- **Network ${net.network}:** ${net.title}\n`;
    });
  });

  // StoreS Data
  if (data.stores.products.length > 0) {
    report += `\n## StoreS - Products (Top 10)\n`;
    data.stores.products.slice(0, 10).forEach(product => {
      report += `- **${product.name}** - $${product.price.toFixed(2)} (${product.status})\n`;
    });
  }

  if (data.stores.orders.length > 0) {
    report += `\n## StoreS - Recent Orders\n`;
    data.stores.orders.slice(0, 10).forEach(order => {
      const date = new Date(order.date).toLocaleDateString();
      report += `- Order #${order.id}: $${order.total.toFixed(2)} - ${order.status} (${date})\n`;
    });
  }

  report += `\n---\n`;
  report += `*This report was auto-generated by GitHub Actions*\n`;

  saveFile('reports/latest-report.md', report);
}

// Run the function
fetchAndProcess();
