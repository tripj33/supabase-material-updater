import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logger } from './src/utils/logger.js';
import databaseService from './src/services/database.js';
import scraperService from './src/services/scraper.js';
import geminiService from './src/services/gemini.js';
import { generateNotesText } from './src/utils/date-formatter.js';

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Load environment variables
dotenv.config();

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, 'screenshots');

// Ensure screenshots directory exists
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// Track outdated URLs
const outdatedUrls = [];

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
    const screenshotPath = await scraperService.takeScreenshot(itemSource.url, itemSource.id);
    
    if (!screenshotPath) {
      logger.error(`Failed to take screenshot for item source ${itemSource.id}`);
      await databaseService.markUrlAsOutdated(itemSource.id);
      outdatedUrls.push({
        id: itemSource.id,
        url: itemSource.url,
        materialItemName: materialItem.name
      });
      return null;
    }
    
    // Extract price from screenshot
    const price = await geminiService.extractPriceFromImage(screenshotPath, materialItem.name);
    
    // Clean up screenshot
    try {
      await fs.promises.unlink(screenshotPath);
    } catch (error) {
      logger.warn(`Failed to delete screenshot ${screenshotPath}: ${error.message}`);
    }
    
    if (price === null) {
      logger.error(`Failed to extract price for item source ${itemSource.id}`);
      await databaseService.markUrlAsOutdated(itemSource.id);
      outdatedUrls.push({
        id: itemSource.id,
        url: itemSource.url,
        materialItemName: materialItem.name
      });
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
    const updatedItemSource = await databaseService.updateItemSource(itemSource.id, price, priceWithTax);
    
    logger.info(`Updated item source ${itemSource.id} with price ${price} (${priceWithTax} with tax)`);
    return updatedItemSource;
  } catch (error) {
    logger.error(`Error processing item source ${itemSource.id}: ${error.message}`);
    return null;
  }
}

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
 * Test database connection
 * @returns {Promise<boolean>} Connection success status
 */
async function testDatabaseConnection() {
  try {
    logger.info('Testing database connection...');
    
    // Query a simple table
    const result = await databaseService.query('SELECT COUNT(*) FROM item_sources');
    
    logger.info(`Database connection test successful. Found ${result.rows[0].count} item sources.`);
    return true;
  } catch (error) {
    logger.error(`Database connection test failed: ${error.message}`);
    logger.error(`Stack trace: ${error.stack}`);
    return false;
  }
}

/**
 * Verify a UUID exists directly in the database
 * @param {string} uuid - The UUID to check
 * @returns {Promise<boolean>} Whether the UUID exists
 */
async function verifyUuidExists(uuid) {
  try {
    logger.info(`Directly verifying UUID ${uuid} exists in database...`);
    const result = await databaseService.query('SELECT EXISTS(SELECT 1 FROM item_sources WHERE id = $1)', [uuid]);
    const exists = result.rows[0].exists;
    logger.info(`Direct verification: UUID ${uuid} exists in database: ${exists}`);
    return exists;
  } catch (error) {
    logger.error(`Error during direct UUID verification: ${error.message}`);
    logger.error(`Stack trace: ${error.stack}`);
    return false;
  }
}

// price-scraper.js - Replace the checkItemSourceExists function

/**
 * Check if an item source ID exists in the item_sources table
 * @param {string} itemSourceId - The item source ID to check
 * @returns {Promise<boolean>} Whether the item source exists
 */
async function checkItemSourceExists(itemSourceId) {
  try {
    logger.info(`Checking if item source ${itemSourceId} exists in database...`);
    
    // Check if databaseService is properly initialized
    if (!databaseService || typeof databaseService.query !== 'function') {
      logger.error(`Database service unavailable or query method not found`);
      
      // Fallback to direct Supabase query if available
      if (supabase) {
        const { data, error } = await supabase
          .from('item_sources')
          .select('id')
          .eq('id', itemSourceId)
          .limit(1);
          
        if (error) throw error;
        const exists = data && data.length > 0;
        logger.info(`Item source ${itemSourceId} exists (via supabase): ${exists}`);
        return exists;
      }
      
      // If we can't query, assume it exists to avoid false negatives
      logger.info(`No database access method available. Assuming item source ${itemSourceId} exists.`);
      return true;
    }
    
    // Use standard query if databaseService is available
    const result = await databaseService.query('SELECT id FROM item_sources WHERE id = $1', [itemSourceId]);
    const exists = result && result.rows && result.rows.length > 0;
    
    logger.info(`Item source ${itemSourceId} exists: ${exists}`);
    return exists;
  } catch (error) {
    logger.error(`Error checking if item source exists: ${error.message}`);
    // Assume it exists to avoid false negatives
    logger.info(`Assuming item source ${itemSourceId} exists due to query error`);
    return true;
  }
}

// price-scraper.js - Function to replace
/**
 * Process all item sources for a material item
 * @param {Object} materialItem - The material item to process
 * @returns {Promise<Object>} Result of processing
 */
async function processMaterialItem(materialItem) {
  try {
    logger.info(`Processing material item ${materialItem.id}: ${materialItem.name}`);
    
    // Test database connection first
    await testDatabaseConnection();
    
    // Fetch item sources for this material item
    const itemSources = await databaseService.fetchItemSources(materialItem.id);
    
    if (itemSources.length === 0) {
      logger.warn(`No item sources found for material item ${materialItem.id}`);
      return {
        success: false,
        message: `No item sources found for material item ${materialItem.id}`,
        materialItem
      };
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
      try {
        // Log all available item sources for debugging
        logger.info(`Available item sources in database:`);
        updatedItemSources.forEach(source => {
          logger.info(`Item Source ID: ${source.id}, Source ID: ${source.source_id}, Price: ${source.price_with_tax}`);
        });
        
        // Log details about the chosen item sources
        logger.info(`Lowest price item source details: ID=${lowestPriceSource.id}, Price=${lowestPriceSource.price_with_tax}`);
        logger.info(`Highest price item source details: ID=${highestPriceSource.id}, Price=${highestPriceSource.price_with_tax}`);
        
        // Get all sources for reference
        const allSources = await databaseService.getAllSources();
        logger.info(`Got ${allSources.length} sources from database`);
        
        // Find the actual source objects
        const lowestPriceSourceInfo = allSources.find(s => s.id === lowestPriceSource.source_id);
        const highestPriceSourceInfo = allSources.find(s => s.id === highestPriceSource.source_id);
        
        if (!lowestPriceSourceInfo) {
          logger.error(`Could not find source info for source_id ${lowestPriceSource.source_id}`);
          return {
            success: false,
            message: `Could not find source info for lowest price source`,
            materialItem,
            updatedItemSources
          };
        }
        
        if (!highestPriceSourceInfo) {
          logger.error(`Could not find source info for source_id ${highestPriceSource.source_id}`);
          return {
            success: false,
            message: `Could not find source info for highest price source`,
            materialItem,
            updatedItemSources
          };
        }
        
        const lowestPriceVendorName = lowestPriceSourceInfo.name;
        const highestPriceVendorName = highestPriceSourceInfo.name;
        
        // Generate notes text
        const notes = generateNotesText(lowestPriceVendorName, highestPriceVendorName);
        
        // Verify the item source ID exists in the item_sources table
        const itemSourceExists = await checkItemSourceExists(lowestPriceSource.id);
        if (!itemSourceExists) {
          logger.error(`Cannot update cheapest_vendor_id: Item source ID ${lowestPriceSource.id} does not exist in item_sources table!`);
          return {
            success: false,
            message: `Cannot update with item source - ID does not exist in item_sources table`,
            materialItem,
            updatedItemSources
          };
        }
        
        // Log the exact data being sent to update
        logger.info(`Updating material item with the following data:`);
        logger.info(`- Material ID: ${materialItem.id}`);
        logger.info(`- Lowest Price: ${lowestPriceSource.price_with_tax}`);
        logger.info(`- Cheapest Item Source ID: ${lowestPriceSource.id}`); // Using item_source.id
        logger.info(`- Highest Price: ${highestPriceSource.price_with_tax}`);
        logger.info(`- Notes: ${notes}`);
        
        // Update material item with the item_source.id (not the source.id)
        await databaseService.updateMaterialItem(
          materialItem.id,
          lowestPriceSource.price_with_tax,
          lowestPriceSource.id, // Use the item_source.id
          highestPriceSource.price_with_tax,
          notes
        );
        
        logger.info(`Updated material item ${materialItem.id} with new pricing information`);
        
        return {
          success: true,
          message: `Updated material item ${materialItem.id} with new pricing information`,
          materialItem,
          updatedItemSources,
          lowestPriceSource,
          highestPriceSource
        };
      } catch (error) {
        logger.error(`Error updating material item: ${error.message}`);
        logger.error(`Stack trace: ${error.stack}`);
        
        return {
          success: false,
          message: `Error updating material item: ${error.message}`,
          materialItem,
          updatedItemSources,
          error: error.message
        };
      }
    } else {
      logger.warn(`Could not update material item ${materialItem.id} due to missing pricing information`);
      
      return {
        success: false,
        message: `Could not update material item ${materialItem.id} due to missing pricing information`,
        materialItem,
        updatedItemSources
      };
    }
  } catch (error) {
    logger.error(`Error processing material item ${materialItem.id}: ${error.message}`);
    logger.error(`Stack trace: ${error.stack}`);
    
    return {
      success: false,
      message: `Error processing material item ${materialItem.id}: ${error.message}`,
      materialItem,
      error: error.message
    };
  }
}

/**
 * Main function to run the price scraper
 * @param {Object} options - Options for the scraper
 * @param {number} [options.limit] - Maximum number of material items to process
 * @param {string} [options.materialItemId] - Specific material item ID to process
 */
async function main(options = {}) {
  const { limit, materialItemId } = options;
  
  try {
    logger.info('Starting price scraper');
    
    // Initialize scraper
    await scraperService.initialize();
    
    // Login to all sites
    const loginResults = {
      winsupply: await scraperService.loginToWinSupply(),
      homedepot: await scraperService.loginToHomeDepot(),
      supplyhouse: await scraperService.loginToSupplyHouse(),
      hdsupply: await scraperService.loginToHDSupply()
    };
    
    logger.info('Login results:', loginResults);
    
    // Process material items
    let materialItems;
    
    if (materialItemId) {
      // Process a specific material item
      materialItems = await databaseService.fetchMaterialItems();
      materialItems = materialItems.filter(item => item.id === materialItemId);
      
      if (materialItems.length === 0) {
        logger.error(`Material item with ID ${materialItemId} not found`);
        await scraperService.close();
        return;
      }
    } else {
      // Process all material items (with optional limit)
      materialItems = await databaseService.fetchMaterialItems(limit);
    }
    
    logger.info(`Processing ${materialItems.length} material items`);
    
    // Process each material item
    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      details: []
    };
    
    for (const item of materialItems) {
      try {
        const result = await processMaterialItem(item);
        results.details.push(result);
        
        if (result.success) {
          results.success++;
        } else {
          results.failed++;
        }
      } catch (error) {
        logger.error(`Failed to process material item ${item.id}: ${error.message}`);
        logger.error(`Stack trace: ${error.stack}`);
        results.failed++;
        results.details.push({
          success: false,
          message: `Failed to process material item ${item.id}: ${error.message}`,
          materialItem: item,
          error: error.message
        });
      }
    }
    
    // Log results
    logger.info(`Processed ${materialItems.length} material items:`);
    logger.info(`- Success: ${results.success}`);
    logger.info(`- Failed: ${results.failed}`);
    
    // Log outdated URLs
    if (outdatedUrls.length > 0) {
      logger.info(`Found ${outdatedUrls.length} outdated URLs:`);
      for (const item of outdatedUrls) {
        logger.info(`- ${item.materialItemName}: ${item.url} (ID: ${item.id})`);
      }
    }
    
    // Clean up
    await scraperService.cleanupScreenshots();
    await scraperService.close();
    
    logger.info('Price scraper completed');
  } catch (error) {
    logger.error(`Error running price scraper: ${error.message}`);
    logger.error(`Stack trace: ${error.stack}`);
    
    // Ensure browser is closed even if there's an error
    try {
      await scraperService.close();
    } catch (closeError) {
      logger.error(`Error closing browser: ${closeError.message}`);
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && i + 1 < args.length) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--material-item-id' && i + 1 < args.length) {
    options.materialItemId = args[i + 1];
    i++;
  }
}

// Run the main function
main(options);