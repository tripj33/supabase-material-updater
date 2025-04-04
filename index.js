import dotenv from 'dotenv';
import { logger, priceChangeLogger, outdatedUrlLogger } from './src/utils/logger.js';
import databaseService from './src/services/database.js';
import scraperService from './src/services/scraper.js';
import geminiService from './src/services/gemini.js';
import { generateNotesText } from './src/utils/date-formatter.js';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Supabase URL or key is missing in environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Parse command line arguments
const args = process.argv.slice(2);
let limit = null;

// Check for --limit argument
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && i + 1 < args.length) {
    limit = parseInt(args[i + 1], 10);
    if (isNaN(limit) || limit <= 0) {
      console.error('Error: --limit must be a positive number');
      process.exit(1);
    }
    logger.info(`Limiting to ${limit} material items for testing`);
    break;
  }
}

// Price change threshold (percentage)
const PRICE_CHANGE_THRESHOLD = parseInt(process.env.PRICE_CHANGE_THRESHOLD || '30', 10);

// Track outdated URLs
const outdatedUrls = [];

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
    const screenshotPath = await scraperService.takeScreenshot(itemSource.url, itemSource.id);
    
    if (!screenshotPath) {
      logger.error(`Failed to take screenshot for item source ${itemSource.id}`);
      await databaseService.markUrlAsOutdated(itemSource.id);
      outdatedUrls.push({
        id: itemSource.id,
        url: itemSource.url,
        materialItemName: materialItem.name
      });
      outdatedUrlLogger.info(`Item source ${itemSource.id} (${itemSource.url}) for ${materialItem.name} marked as outdated`);
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
      outdatedUrlLogger.info(`Item source ${itemSource.id} (${itemSource.url}) for ${materialItem.name} marked as outdated`);
      return null;
    }
    
    // Calculate price with tax and round to two decimal places
    const roundedPrice = Math.round(price * 100) / 100;
    const priceWithTax = Math.round((roundedPrice * 1.15) * 100) / 100;
    
    // Check for significant price change
    if (itemSource.sale_price !== null) {
      const percentChange = Math.abs((price - itemSource.sale_price) / itemSource.sale_price * 100);
      
      if (percentChange > PRICE_CHANGE_THRESHOLD) {
        const vendorName = itemSource.sources ? itemSource.sources.name : 'Unknown Vendor';
        priceChangeLogger.info(
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

// index.js - Function to replace
/**
 * Process all item sources for a material item
 * @param {Object} materialItem - The material item to process
 * @returns {Promise<Array>} Array of updated item sources
 */
async function processMaterialItem(materialItem) {
  try {
    logger.info(`Processing material item ${materialItem.id}: ${materialItem.name}`);
    
    // Fetch item sources for this material item
    const itemSources = await databaseService.fetchItemSources(materialItem.id);
    
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
      try {
        // Get all sources to look up vendor names
        const allSources = await databaseService.getAllSources();
        
        // Find the vendor names
        const lowestPriceSourceInfo = allSources.find(s => s.id === lowestPriceSource.source_id);
        const highestPriceSourceInfo = allSources.find(s => s.id === highestPriceSource.source_id);
        
        const lowestPriceVendorName = lowestPriceSourceInfo ? lowestPriceSourceInfo.name : 'Unknown Vendor';
        const highestPriceVendorName = highestPriceSourceInfo ? highestPriceSourceInfo.name : 'Unknown Vendor';
        
        // Generate notes text
        const notes = generateNotesText(lowestPriceVendorName, highestPriceVendorName);
        
        // Log the values we're about to use for updating
        logger.info(`Updating material item with: cost=${lowestPriceSource.price_with_tax}, vendor=${lowestPriceSource.id}, sale_price=${highestPriceSource.price_with_tax}`);
        
        try {
          await supabase
            .from('material_items')
            .update({
              cost: lowestPriceSource.price_with_tax,
              cheapest_vendor_id: lowestPriceSource.id, // Use item_source.id not source_id
              sale_price: highestPriceSource.price_with_tax,
              notes: notes,
              updated_at: new Date().toISOString()
            })
            .eq('id', materialItem.id);
          
          logger.info(`Updated material item ${materialItem.id} with new pricing information`);
        } catch (error) {
          logger.error(`Error updating material item: ${error.message}`);
        }
      } catch (error) {
        logger.error(`Error updating material item ${materialItem.id}: ${error.message}`);
        // Continue processing other material items
      }
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
 * Retry a function with exponential backoff
 * @param {Function} fn - The function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelay - Initial delay in milliseconds
 * @returns {Promise<any>} Result of the function
 */
async function retry(fn, maxRetries = 3, initialDelay = 1000) {
  let retries = 0;
  let delay = initialDelay;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      
      if (retries > maxRetries) {
        throw error;
      }
      
      logger.warn(`Retry ${retries}/${maxRetries} after error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

/**
 * Main function
 */
async function main() {
  try {
    logger.info('Starting material price update process');
    
    // Initialize scraper
    await scraperService.initialize();
    
    // Login to all sites first
    logger.info('Logging in to all sites before processing items');
    
    // Login to WinSupply
    logger.info('Logging in to WinSupply');
    const winSupplyLoginSuccess = await scraperService.loginToWinSupply();
    if (!winSupplyLoginSuccess) {
      logger.error('Failed to log in to WinSupply. WinSupply items will be marked as outdated.');
    } else {
      logger.info('Successfully logged in to WinSupply');
    }
    
    // Login to Home Depot
    logger.info('Logging in to Home Depot');
    const homeDepotLoginSuccess = await scraperService.loginToHomeDepot();
    if (!homeDepotLoginSuccess) {
      logger.error('Failed to log in to Home Depot. Home Depot items will be marked as outdated.');
    } else {
      logger.info('Successfully logged in to Home Depot');
    }
    
    // Login to SupplyHouse.com
    logger.info('Logging in to SupplyHouse.com');
    const supplyHouseLoginSuccess = await scraperService.loginToSupplyHouse();
    if (!supplyHouseLoginSuccess) {
      logger.error('Failed to log in to SupplyHouse.com. SupplyHouse.com items will be marked as outdated.');
    } else {
      logger.info('Successfully logged in to SupplyHouse.com');
    }
    
    // Login to HD Supply
    logger.info('Logging in to HD Supply');
    const hdSupplyLoginSuccess = await scraperService.loginToHDSupply();
    if (!hdSupplyLoginSuccess) {
      logger.error('Failed to log in to HD Supply. HD Supply items will be marked as outdated.');
    } else {
      logger.info('Successfully logged in to HD Supply');
    }
    
    // Fetch all material items with retry
    let materialItems = await retry(async () => {
      return await databaseService.fetchMaterialItems();
    });
    
    // Apply limit if specified
    if (limit !== null && materialItems.length > limit) {
      logger.info(`Limiting to ${limit} out of ${materialItems.length} material items for testing`);
      materialItems = materialItems.slice(0, limit);
    }
    
    logger.info(`Processing ${materialItems.length} material items`);
    
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
    await scraperService.close();
    await scraperService.cleanupScreenshots();
    
    // Log summary
    logger.info('Material price update process completed');
    logger.info(`Results: ${results.success} successful, ${results.failed} failed, ${results.skipped} skipped`);
    
    if (outdatedUrls.length > 0) {
      logger.warn(`${outdatedUrls.length} URLs were marked as outdated`);
      console.log('Outdated URLs:');
      for (const item of outdatedUrls) {
        console.log(`- ${item.materialItemName}: ${item.url} (ID: ${item.id})`);
      }
    }
  } catch (error) {
    logger.error(`Error in main process: ${error.message}`);
    
    // Ensure browser is closed even if there's an error
    try {
      await scraperService.close();
    } catch (closeError) {
      logger.error(`Error closing browser: ${closeError.message}`);
    }
  }
}

// Run the main function
main().catch(error => {
  logger.error(`Unhandled error: ${error.message}`);
  process.exit(1);
});
