import dotenv from 'dotenv';
import { logger } from './src/utils/logger.js';
import mockDatabaseService from './src/services/mock-database.js';
import { generateNotesText } from './src/utils/date-formatter.js';

// Load environment variables
dotenv.config();

// Mock the scraper and Gemini services
const mockScraperService = {
  initialize: async () => {
    logger.info('Mock: Initializing Puppeteer browser');
    return true;
  },
  takeScreenshot: async (url, itemId) => {
    logger.info(`Mock: Taking screenshot of ${url}`);
    // Simulate success for most URLs, but fail for one to test error handling
    if (url.includes('fail-screenshot')) {
      logger.error(`Mock: Failed to take screenshot for ${url}`);
      return null;
    }
    return `./screenshots/mock_${itemId}.jpg`;
  },
  close: async () => {
    logger.info('Mock: Closing Puppeteer browser');
    return true;
  },
  cleanupScreenshots: async () => {
    logger.info('Mock: Cleaning up screenshots');
    return true;
  }
};

const mockGeminiService = {
  extractPriceFromImage: async (screenshotPath, productName) => {
    logger.info(`Mock: Extracting price from ${screenshotPath} for ${productName}`);
    // Simulate success for most screenshots, but fail for one to test error handling
    if (screenshotPath.includes('fail-extract')) {
      logger.error(`Mock: Failed to extract price for ${productName}`);
      return null;
    }
    // Return a random price between 90 and 110% of the original price
    const basePrice = 100;
    const randomFactor = 0.9 + Math.random() * 0.2; // Between 0.9 and 1.1
    return basePrice * randomFactor;
  }
};

/**
 * Group item sources by domain
 * @param {Array} itemSources - Array of item sources
 * @returns {Object} Object with domains as keys and arrays of item sources as values
 */
function groupItemSourcesByDomain(itemSources) {
  const groups = {};
  
  for (const source of itemSources) {
    try {
      const url = new URL(source.url);
      const domain = url.hostname;
      
      if (!groups[domain]) {
        groups[domain] = [];
      }
      
      groups[domain].push(source);
    } catch (error) {
      logger.error(`Invalid URL for item source ${source.id}: ${source.url}`);
    }
  }
  
  return groups;
}

/**
 * Process a single item source
 * @param {Object} itemSource - The item source to process
 * @param {Object} materialItem - The material item
 * @returns {Promise<Object|null>} Updated item source or null if failed
 */
async function processItemSource(itemSource, materialItem) {
  try {
    logger.info(`Processing item source ${itemSource.id} for material item ${materialItem.id}`);
    
    // Take screenshot of the product page
    const screenshotPath = await mockScraperService.takeScreenshot(itemSource.url, itemSource.id);
    
    if (!screenshotPath) {
      logger.error(`Failed to take screenshot for item source ${itemSource.id}`);
      await mockDatabaseService.markUrlAsOutdated(itemSource.id);
      return null;
    }
    
    // Extract price from screenshot
    const price = await mockGeminiService.extractPriceFromImage(screenshotPath, materialItem.name);
    
    if (price === null) {
      logger.error(`Failed to extract price for item source ${itemSource.id}`);
      await mockDatabaseService.markUrlAsOutdated(itemSource.id);
      return null;
    }
    
    // Calculate price with tax and round to two decimal places
    const roundedPrice = Math.round(price * 100) / 100;
    const priceWithTax = Math.round((roundedPrice * 1.15) * 100) / 100;
    
    // Check for significant price change
    if (itemSource.sale_price !== null) {
      const percentChange = Math.abs((price - itemSource.sale_price) / itemSource.sale_price * 100);
      
      if (percentChange > 30) {
        const vendorName = itemSource.sources ? itemSource.sources.name : 'Unknown Vendor';
        logger.info(
          `Significant price change detected for ${materialItem.name} from ${vendorName}: ` +
          `${itemSource.sale_price} -> ${price} (${percentChange.toFixed(2)}%)`
        );
      }
    }
    
    // Update item source with new pricing
    const updatedItemSource = await mockDatabaseService.updateItemSource(itemSource.id, price, priceWithTax);
    
    logger.info(`Updated item source ${itemSource.id} with price ${price} (${priceWithTax} with tax)`);
    return updatedItemSource;
  } catch (error) {
    logger.error(`Error processing item source ${itemSource.id}: ${error.message}`);
    return null;
  }
}

/**
 * Process all item sources for a material item
 * @param {Object} materialItem - The material item to process
 * @returns {Promise<Array>} Array of updated item sources
 */
async function processMaterialItem(materialItem) {
  try {
    logger.info(`Processing material item ${materialItem.id}: ${materialItem.name}`);
    
    // Fetch item sources for this material item
    const itemSources = await mockDatabaseService.fetchItemSources(materialItem.id);
    
    if (itemSources.length === 0) {
      logger.warn(`No item sources found for material item ${materialItem.id}`);
      return [];
    }
    
    // Group item sources by domain
    const domainGroups = groupItemSourcesByDomain(itemSources);
    
    // Process each domain group
    const updatedItemSources = [];
    
    for (const [domain, sources] of Object.entries(domainGroups)) {
      logger.info(`Processing ${sources.length} item sources for domain ${domain}`);
      
      // Process each item source in this domain group
      for (const source of sources) {
        const updatedSource = await processItemSource(source, materialItem);
        
        if (updatedSource) {
          updatedItemSources.push(updatedSource);
        }
      }
    }
    
    // Find lowest and highest priced item sources
    let lowestPriceSource = null;
    let highestPriceSource = null;
    
    for (const source of updatedItemSources) {
      if (!lowestPriceSource || source.price_with_tax < lowestPriceSource.price_with_tax) {
        lowestPriceSource = source;
      }
      
      if (!highestPriceSource || source.price_with_tax > highestPriceSource.price_with_tax) {
        highestPriceSource = source;
      }
    }
    
    // Update material item if we have pricing information
    if (lowestPriceSource && highestPriceSource) {
      // Get vendor names
      const lowestPriceVendor = await mockDatabaseService.getSourceById(lowestPriceSource.source_id);
      const highestPriceVendor = await mockDatabaseService.getSourceById(highestPriceSource.source_id);
      
      // Generate notes text
      const notes = generateNotesText(lowestPriceVendor.name, highestPriceVendor.name);
      
      // Update material item
      await mockDatabaseService.updateMaterialItem(
        materialItem.id,
        lowestPriceSource.price_with_tax,
        lowestPriceSource.source_id,
        highestPriceSource.price_with_tax,
        notes
      );
      
      logger.info(`Updated material item ${materialItem.id} with new pricing information`);
    } else {
      logger.warn(`Could not update material item ${materialItem.id} due to missing pricing information`);
    }
    
    return updatedItemSources;
  } catch (error) {
    logger.error(`Error processing material item ${materialItem.id}: ${error.message}`);
    return [];
  }
}

/**
 * Main test function
 */
async function runTest() {
  try {
    logger.info('Starting test with mock data');
    
    // Initialize mock services
    await mockScraperService.initialize();
    
    // Fetch all material items
    const materialItems = await mockDatabaseService.fetchMaterialItems();
    
    logger.info(`Found ${materialItems.length} material items to process`);
    
    // Process each material item
    const results = {
      success: 0,
      failed: 0,
      skipped: 0
    };
    
    for (const item of materialItems) {
      try {
        const updatedSources = await processMaterialItem(item);
        
        if (updatedSources.length > 0) {
          results.success++;
        } else if (updatedSources.length === 0) {
          results.skipped++;
        }
      } catch (error) {
        logger.error(`Failed to process material item ${item.id}: ${error.message}`);
        results.failed++;
      }
    }
    
    // Clean up
    await mockScraperService.close();
    await mockScraperService.cleanupScreenshots();
    
    // Log summary
    logger.info('Test completed');
    logger.info(`Results: ${results.success} successful, ${results.failed} failed, ${results.skipped} skipped`);
    
    // Log updates
    const updates = mockDatabaseService.getUpdates();
    logger.info('Updates made:');
    logger.info(`- Item sources: ${Object.keys(updates.itemSources).length}`);
    logger.info(`- Material items: ${Object.keys(updates.materialItems).length}`);
    
    // Print some sample updates
    if (Object.keys(updates.materialItems).length > 0) {
      const sampleItemId = Object.keys(updates.materialItems)[0];
      const sampleItem = updates.materialItems[sampleItemId];
      logger.info('Sample material item update:');
      logger.info(`- ID: ${sampleItem.id}`);
      logger.info(`- Name: ${sampleItem.name}`);
      logger.info(`- Cost: ${sampleItem.cost}`);
      logger.info(`- Sale price: ${sampleItem.sale_price}`);
      logger.info(`- Notes: ${sampleItem.notes}`);
    }
    
    return results;
  } catch (error) {
    logger.error(`Error in test: ${error.message}`);
    return null;
  }
}

// Run the test
runTest().then(results => {
  if (results) {
    logger.info('Test completed successfully');
    process.exit(0);
  } else {
    logger.error('Test failed');
    process.exit(1);
  }
});
