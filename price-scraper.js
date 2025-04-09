import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logger } from './src/utils/logger.js';
import databaseService from './src/services/database.js';
import scraperService from './src/services/scraper.js';
import geminiService from './src/services/gemini.js';
import browserPool from './src/services/browser-pool.js';
import sessionManager from './src/services/session-manager.js';
import { generateNotesText } from './src/utils/date-formatter.js';
import { TaskQueue } from './src/utils/task-queue.js';

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Load environment variables
dotenv.config();

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, 'screenshots');

// Ensure screenshots directory exists
(async function() {
  if (!fs.existsSync(screenshotsDir)) {
    await fs.mkdir(screenshotsDir, { recursive: true });
  }
})();

// Price change threshold (percentage)
const PRICE_CHANGE_THRESHOLD = parseInt(process.env.PRICE_CHANGE_THRESHOLD || '30', 10);

// Recovery system state
let processingQueue = [];
let currentIndex = 0;
let isRecovering = false;
let recoveryAttempts = 0;
const MAX_RECOVERY_ATTEMPTS = 5;
const RECOVERY_WAIT_TIME = 60000; // 60 seconds

// Initialize services
let isInitialized = false;
let taskQueue = null;

/**
 * Initialize services required for processing
 */
export async function initialize() {
  if (isInitialized) return;
  
  await browserPool.initialize();
  await sessionManager.initialize();
  taskQueue = new TaskQueue({ concurrency: 3 });
  
  // Register disconnect handler
  if (typeof browserPool.setDisconnectHandler === 'function') {
    browserPool.setDisconnectHandler(() => {
      if (!isRecovering) {
        logger.warn("Browser disconnect detected through event handler");
      }
    });
  }
  
  isInitialized = true;
  logger.info('Price scraper services initialized');
}

/**
 * Clean up and release resources
 */
export async function cleanup() {
  if (!isInitialized) return;
  
  logger.info('Performing cleanup...');
  
  try {
    await scraperService.cleanupScreenshots();
  } catch (error) {
    logger.error(`Error cleaning screenshots: ${error.message}`);
  }
  
  try {
    await browserPool.close();
  } catch (error) {
    logger.error(`Error closing browser pool: ${error.message}`);
  }
  
  isInitialized = false;
  logger.info('Price scraper services cleaned up');
}

/**
 * Handle unexpected browser disconnection and recover processing
 * @param {Array} items - Array of material items
 * @param {number} startIndex - Index to resume from
 * @returns {Promise<Object>} Processing results
 */
async function recoverFromDisconnection(items, startIndex) {
  if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    logger.error(`Exceeded maximum recovery attempts (${MAX_RECOVERY_ATTEMPTS}). Stopping process.`);
    return { 
      success: false, 
      error: "Exceeded maximum recovery attempts",
      processed: startIndex,
      total: items.length
    };
  }

  logger.info(`Browser disconnected unexpectedly. Recovery attempt ${recoveryAttempts + 1}/${MAX_RECOVERY_ATTEMPTS}`);
  logger.info(`Waiting ${RECOVERY_WAIT_TIME/1000} seconds before attempting to recover...`);
  
  // Wait for recovery time
  await new Promise(resolve => setTimeout(resolve, RECOVERY_WAIT_TIME));
  
  isRecovering = true;
  recoveryAttempts++;
  
  try {
    // Make sure browser is closed
    await browserPool.close().catch(() => {});
    
    // Reinitialize browser
    logger.info("Reinitializing browser after disconnection...");
    await browserPool.initialize();
    
    // Resume processing from the last material item
    logger.info(`Resuming processing from index ${startIndex} of ${items.length} items`);
    
    // Continue processing
    const result = await processRemainingItems(items, startIndex);
    
    // Reset recovery state if all items were processed
    if (startIndex + result.success + result.failed >= items.length) {
      isRecovering = false;
      recoveryAttempts = 0;
    }
    
    return result;
  } catch (error) {
    logger.error(`Error during recovery: ${error.message}`);
    // If error is browser-related, try recovery again
    if (error.message.includes("disconnected") || 
        error.message.includes("Target closed") || 
        error.message.includes("Session closed") ||
        error.message.includes("Protocol error")) {
      return recoverFromDisconnection(items, startIndex);
    }
    return {
      success: false,
      error: error.message,
      processed: startIndex,
      total: items.length
    };
  }
}

/**
 * Process remaining items from specified index
 * @param {Array} items - Array of material items
 * @param {number} startIndex - Index to start from
 * @returns {Promise<Object>} Processing results
 */
async function processRemainingItems(items, startIndex) {
  const results = {
    success: 0,
    failed: 0,
    skipped: 0,
    outdated: 0,
    materialUpdates: 0,
    details: [],
    updatedItemSources: []
  };
  
  for (let i = startIndex; i < items.length; i++) {
    currentIndex = i;
    const item = items[i];
    
    try {
      // Verify browser is connected
      if (!browserPool.browser) {
        logger.warn("Browser is not connected, attempting recovery...");
        const recoveryResults = await recoverFromDisconnection(items, i);
        // Merge results
        results.success += recoveryResults.success || 0;
        results.failed += recoveryResults.failed || 0;
        results.skipped += recoveryResults.skipped || 0;
        results.outdated += recoveryResults.outdated || 0;
        if (recoveryResults.details) {
          results.details.push(...recoveryResults.details);
        }
        if (recoveryResults.updatedItemSources) {
          results.updatedItemSources.push(...recoveryResults.updatedItemSources);
        }
        return results;
      }
      
      // Process material item
      logger.info(`Processing item ${i + 1}/${items.length}: ${item.id}`);
      const result = await processMaterialItem(item);
      
      if (result.success) {
        results.success++;
        if (result.updatedItemSources) {
          results.updatedItemSources.push(...result.updatedItemSources);
        }
      } else {
        results.failed++;
        if (result.outdatedUrls && result.outdatedUrls.length > 0) {
          results.outdated += result.outdatedUrls.length;
        }
      }
      
      results.details.push(result);
      
    } catch (error) {
      // Check for browser disconnection
      if (error.message.includes("disconnected") || 
          error.message.includes("Target closed") || 
          error.message.includes("Session closed") ||
          error.message.includes("Protocol error") ||
          !browserPool.browser) {
        
        logger.error(`Browser disconnection detected: ${error.message}`);
        const recoveryResults = await recoverFromDisconnection(items, i);
        // Merge results
        results.success += recoveryResults.success || 0;
        results.failed += recoveryResults.failed || 0;
        results.skipped += recoveryResults.skipped || 0;
        results.outdated += recoveryResults.outdated || 0;
        if (recoveryResults.details) {
          results.details.push(...recoveryResults.details);
        }
        if (recoveryResults.updatedItemSources) {
          results.updatedItemSources.push(...recoveryResults.updatedItemSources);
        }
        return results;
      }
      
      logger.error(`Error processing item ${item.id}: ${error.message}`);
      results.failed++;
      results.details.push({
        success: false,
        materialItemId: item.id,
        materialItemName: item.name,
        error: error.message
      });
    }
  }
  
  return results;
}

/**
 * Group item sources by domain to optimize processing
 * @param {Array} materialItems - Array of material items
 * @returns {Promise<Object>} Object with domains as keys and arrays of {item, source} pairs as values
 */
export async function groupItemSourcesByDomain(materialItems) {
  const itemsByDomain = {};
  
  for (const item of materialItems) {
    const sources = await databaseService.fetchItemSources(item.id);
    
    for (const source of sources) {
      try {
        const url = new URL(source.url);
        const domain = url.hostname;
        
        if (!itemsByDomain[domain]) {
          itemsByDomain[domain] = [];
        }
        
        itemsByDomain[domain].push({ item, source });
      } catch (error) {
        logger.error(`Invalid URL for item source ${source.id}: ${source.url}`);
      }
    }
  }
  
  return itemsByDomain;
}

/**
 * Process a single item source
 * @param {Object} source - Item source to process
 * @param {Object} item - Material item
 * @returns {Promise<Object>} Processing result
 */
export async function processItemSource(source, item) {
  const result = {
    id: source.id,
    materialItemId: item.id,
    materialItemName: item.name,
    success: false,
    outdated: false,
    priceChange: null,
    oldPrice: source.sale_price,
    newPrice: null,
    error: null
  };
  
  try {
    // Check browser connection first
    if (!browserPool.browser) {
      throw new Error("Browser disconnected before processing item source");
    }

    // Take screenshot of the product page
    const screenshotPath = await scraperService.takeScreenshot(source.url, source.id);
    
    if (!screenshotPath) {
      logger.error(`Failed to take screenshot for item source ${source.id}`);
      await databaseService.markUrlAsOutdated(source.id);
      result.outdated = true;
      result.error = "Failed to take screenshot";
      return result;
    }
    
    // Extract price from screenshot
    const price = await geminiService.extractPriceFromImage(screenshotPath, item.name);
    
    // Clean up screenshot
    try {
      await fs.unlink(screenshotPath);
    } catch (error) {
      logger.warn(`Failed to delete screenshot ${screenshotPath}: ${error.message}`);
    }
    
    if (price === null) {
      logger.error(`Failed to extract price for item source ${source.id}`);
      await databaseService.markUrlAsOutdated(source.id);
      result.outdated = true;
      result.error = "Failed to extract price";
      return result;
    }
    
    // Calculate price with tax and round to two decimal places
    const roundedPrice = Math.round(price * 100) / 100;
    const priceWithTax = Math.round((roundedPrice * 1.15) * 100) / 100;
    
    // Check for significant price change
    if (source.sale_price !== null) {
      const percentChange = Math.abs((price - source.sale_price) / source.sale_price * 100);
      
      if (percentChange > PRICE_CHANGE_THRESHOLD) {
        const vendorName = source.sources ? source.sources.name : 'Unknown Vendor';
        logger.info(
          `Significant price change detected for ${item.name} from ${vendorName}: ` +
          `${source.sale_price} -> ${price} (${percentChange.toFixed(2)}%)`
        );
        
        result.priceChange = {
          percentChange: percentChange.toFixed(2),
          vendor: vendorName
        };
      }
    }
    
    // Update item source with new pricing
    const updatedItemSource = await databaseService.updateItemSource(source.id, price, priceWithTax);
    
    logger.info(`Updated item source ${source.id} with price ${price} (${priceWithTax} with tax)`);
    
    // Update result
    result.success = true;
    result.newPrice = price;
    result.priceWithTax = priceWithTax;
    result.updatedItemSource = updatedItemSource;
    
    return result;
  } catch (error) {
    // Enhanced error detection
    if (error.message.includes("disconnected") || 
        error.message.includes("Target closed") || 
        error.message.includes("Session closed") ||
        error.message.includes("Protocol error") ||
        !browserPool.browser) {
      
      throw new Error(`Browser disconnection during item source processing: ${error.message}`);
    }
    
    logger.error(`Error processing item source ${source.id}: ${error.message}`);
    result.error = error.message;
    return result;
  }
}

/**
 * Process item sources for a specific domain
 * @param {string} domain - Domain name
 * @param {Array} itemSourcePairs - Array of {item, source} pairs
 * @returns {Promise<Object>} Processing results
 */
export async function processDomainItems(domain, itemSourcePairs) {
  logger.info(`Processing ${itemSourcePairs.length} items for domain ${domain}`);
  
  const results = {
    domain,
    success: 0,
    failed: 0,
    outdated: 0,
    priceChanges: [],
    items: [],
    outdatedUrls: []
  };
  
  // Batch process arrays for database operations
  const updateBatch = [];
  const outdatedBatch = [];
  
  // Process each item source
  for (const { item, source } of itemSourcePairs) {
    // Check browser connection
    if (!browserPool.browser) {
      throw new Error("Browser disconnected during domain processing");
    }
    
    const sourceResult = await processItemSource(source, item);
    results.items.push(sourceResult);
    
    if (sourceResult.success) {
      results.success++;
      updateBatch.push({
        id: source.id,
        salePrice: sourceResult.newPrice,
        priceWithTax: sourceResult.priceWithTax,
        source_id: source.source_id,
        item_id: item.id
      });
      
      if (sourceResult.priceChange) {
        results.priceChanges.push({
          materialName: item.name,
          vendor: sourceResult.priceChange.vendor,
          oldPrice: sourceResult.oldPrice,
          newPrice: sourceResult.newPrice,
          percentChange: sourceResult.priceChange.percentChange
        });
      }
    } else {
      results.failed++;
      
      if (sourceResult.outdated) {
        results.outdated++;
        outdatedBatch.push(source.id);
        results.outdatedUrls.push({
          id: source.id,
          url: source.url,
          materialItemName: item.name
        });
      }
    }
  }
  
  // Batch update outdated URLs
  if (outdatedBatch.length > 0) {
    await databaseService.batchMarkUrlsAsOutdated(outdatedBatch);
    logger.info(`Marked ${outdatedBatch.length} URLs as outdated for domain ${domain}`);
  }
  
  // Batch update item sources
  if (updateBatch.length > 0) {
    await databaseService.batchUpdateItemSources(updateBatch);
    logger.info(`Updated ${updateBatch.length} item sources for domain ${domain}`);
  }
  
  return results;
}

/**
 * Process material item updates after item sources have been updated
 * @param {Array} itemSourceUpdates - Updated item sources
 * @returns {Promise<Array>} Updated material items
 */
export async function updateMaterialItems(itemSourceUpdates) {
  if (itemSourceUpdates.length === 0) {
    logger.warn('No item sources were updated, skipping material item updates');
    return [];
  }
  
  // Group by material item ID
  const itemUpdates = {};
  
  for (const source of itemSourceUpdates) {
    if (!itemUpdates[source.item_id]) {
      itemUpdates[source.item_id] = {
        id: source.item_id,
        sources: []
      };
    }
    
    itemUpdates[source.item_id].sources.push(source);
  }
  
  // Find lowest and highest prices for each material item
  const materialUpdates = [];
  
  // Get all sources for vendor names
  const allSources = await databaseService.getAllSources();
  
  for (const [itemId, data] of Object.entries(itemUpdates)) {
    if (data.sources.length === 0) continue;
    
    // Sort sources by price
    data.sources.sort((a, b) => a.priceWithTax - b.priceWithTax);
    
    const lowestPriceSource = data.sources[0];
    const highestPriceSource = data.sources[data.sources.length - 1];
    
    // Get vendor names
    const lowestPriceVendorInfo = allSources.find(s => s.id === lowestPriceSource.source_id);
    const highestPriceVendorInfo = allSources.find(s => s.id === highestPriceSource.source_id);
    
    const lowestPriceVendorName = lowestPriceVendorInfo ? lowestPriceVendorInfo.name : 'Unknown Vendor';
    const highestPriceVendorName = highestPriceVendorInfo ? highestPriceVendorInfo.name : 'Unknown Vendor';
    
    // Generate notes text
    const notes = generateNotesText(lowestPriceVendorName, highestPriceVendorName);
    
    // Add to material updates
    materialUpdates.push({
      id: itemId,
      cost: lowestPriceSource.priceWithTax,
      cheapestVendorId: lowestPriceSource.id,
      salePrice: highestPriceSource.priceWithTax,
      notes: notes,
      lowestPriceVendorName,
      highestPriceVendorName
    });
  }
  
  // Batch update material items
  if (materialUpdates.length > 0) {
    await databaseService.batchUpdateMaterialItems(materialUpdates);
    logger.info(`Updated ${materialUpdates.length} material items with new pricing information`);
  }
  
  return materialUpdates;
}

/**
 * Process a single material item
 * @param {Object} materialItem - Material item to process
 * @returns {Promise<Object>} Processing results
 */
export async function processMaterialItem(materialItem) {
  try {
    if (!isInitialized) {
      await initialize();
    }
    
    logger.info(`Processing material item ${materialItem.id}: ${materialItem.name}`);
    
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
    const itemsByDomain = {};
    for (const source of itemSources) {
      try {
        const url = new URL(source.url);
        const domain = url.hostname;
        
        if (!itemsByDomain[domain]) {
          itemsByDomain[domain] = [];
        }
        
        itemsByDomain[domain].push({ item: materialItem, source });
      } catch (error) {
        logger.error(`Invalid URL for item source ${source.id}: ${source.url}`);
      }
    }
    
    // Process each domain group
    const domainResults = [];
    const updatedItemSources = [];
    const outdatedUrls = [];
    
    for (const [domain, pairs] of Object.entries(itemsByDomain)) {
      try {
        const result = await processDomainItems(domain, pairs);
        domainResults.push(result);
        
        // Collect successful item source updates for material item update
        result.items.forEach(item => {
          if (item.success) {
            updatedItemSources.push({
              id: item.id,
              salePrice: item.newPrice,
              priceWithTax: item.priceWithTax,
              source_id: item.updatedItemSource.source_id,
              item_id: materialItem.id
            });
          }
        });
        
        // Collect outdated URLs
        if (result.outdatedUrls && result.outdatedUrls.length > 0) {
          outdatedUrls.push(...result.outdatedUrls);
        }
      } catch (error) {
        // Check for browser disconnection
        if (error.message.includes("disconnected") || 
            error.message.includes("Target closed") || 
            error.message.includes("Session closed") ||
            error.message.includes("Protocol error") ||
            !browserPool.browser) {
          
          throw new Error(`Browser disconnection during domain processing: ${error.message}`);
        }
        
        logger.error(`Error processing domain ${domain}: ${error.message}`);
      }
    }
    
    // Update the material item if we have pricing information
    const materialUpdates = await updateMaterialItems(updatedItemSources);
    
    // Find the update for this material item
    const materialUpdate = materialUpdates.find(update => update.id === materialItem.id);
    
    if (materialUpdate) {
      return {
        success: true,
        message: `Updated material item ${materialItem.id} with new pricing information`,
        materialItem,
        updatedItemSources,
        outdatedUrls,
        lowestPriceSource: {
          id: materialUpdate.cheapestVendorId
        },
        highestPriceSource: {
          price_with_tax: materialUpdate.salePrice
        },
        lowestPriceVendorName: materialUpdate.lowestPriceVendorName,
        highestPriceVendorName: materialUpdate.highestPriceVendorName
      };
    } else {
      return {
        success: false,
        message: `Could not update material item ${materialItem.id} due to missing pricing information`,
        materialItem,
        updatedItemSources: updatedItemSources.length,
        outdatedUrls
      };
    }
  } catch (error) {
    logger.error(`Error processing material item ${materialItem.id}: ${error.message}`);
    
    return {
      success: false,
      message: `Error processing material item ${materialItem.id}: ${error.message}`,
      materialItem,
      error: error.message
    };
  }
}

/**
 * Process all material items in parallel
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Processing results
 */
export async function processAllMaterialItems(options = {}) {
  const { limit, concurrency = 3 } = options;
  
  try {
    if (!isInitialized) {
      await initialize();
    }
    
    // Create task queue if not already created
    if (!taskQueue) {
      taskQueue = new TaskQueue({ concurrency });
    }
    
    // Fetch all material items with optional limit
    let materialItems = await databaseService.fetchMaterialItems(limit);
    
    logger.info(`Processing ${materialItems.length} material items with concurrency ${concurrency}`);
    
    // Reset processing state
    currentIndex = 0;
    recoveryAttempts = 0;
    processingQueue = [...materialItems];
    isRecovering = false;
    
    // Process items with recovery capability
    const results = await processRemainingItems(materialItems, 0);
    
    // Update any material items if needed
    let materialUpdates = [];
    if (results.updatedItemSources && results.updatedItemSources.length > 0) {
      materialUpdates = await updateMaterialItems(results.updatedItemSources);
      results.materialUpdates = materialUpdates.length;
    }
    
    // Clean up
    try {
      await scraperService.cleanupScreenshots();
    } catch (error) {
      logger.error(`Error cleaning screenshots: ${error.message}`);
    }
    
    // Only close the browser if we're not in recovery mode
    if (!isRecovering) {
      try {
        await browserPool.close();
      } catch (error) {
        logger.error(`Error closing browser: ${error.message}`);
      }
    }
    
    logger.info(`Price scraper complete:`);
    logger.info(`- Successfully updated ${results.success} item sources`);
    logger.info(`- Failed to update ${results.failed} item sources`);
    logger.info(`- Updated ${results.materialUpdates || 0} material items`);
    logger.info(`- Marked ${results.outdated || 0} URLs as outdated`);
    
    return {
      success: true,
      message: `Processed ${materialItems.length} material items`,
      results
    };
  } catch (error) {
    logger.error(`Error processing material items: ${error.message}`);
    
    // Ensure browser is closed if not in recovery mode
    if (!isRecovering) {
      try {
        await browserPool.close();
      } catch (closeError) {
        logger.error(`Error closing browser: ${closeError.message}`);
      }
    }
    
    return {
      success: false,
      message: `Error processing material items: ${error.message}`,
      error: error.message
    };
  }
}

// Handle process exit cleanly
process.on('SIGINT', async () => {
  logger.info('Received SIGINT - shutting down gracefully');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM - shutting down gracefully');
  await cleanup();
  process.exit(0);
});

// If this file is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const options = {
    limit: null,
    materialItemId: null,
    concurrency: 3
  };
  
  // Process command line arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--limit' && i + 1 < args.length) {
      options.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--material-item-id' && i + 1 < args.length) {
      options.materialItemId = args[i + 1];
      i++;
    } else if (arg === '--concurrency' && i + 1 < args.length) {
      options.concurrency = parseInt(args[i + 1], 10);
      i++;
    }
  }
  
  // Run as standalone script
  (async () => {
    try {
      await initialize();
      
      if (options.materialItemId) {
        // Process a specific material item
        const materialItems = await databaseService.fetchMaterialItems();
        const materialItem = materialItems.find(item => item.id === options.materialItemId);
        
        if (materialItem) {
          const result = await processMaterialItem(materialItem);
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.error(`Material item with ID ${options.materialItemId} not found`);
          process.exit(1);
        }
      } else {
        // Process all material items
        const result = await processAllMaterialItems(options);
        
        if (result.success) {
          process.exit(0);
        } else {
          process.exit(1);
        }
      }
      
      await cleanup();
    } catch (error) {
      console.error(`Unhandled error: ${error.message}`);
      process.exit(1);
    }
  })();
}

export default {
  initialize,
  cleanup,
  processMaterialItem,
  processAllMaterialItems
};